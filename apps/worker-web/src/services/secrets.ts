// Owns `secret` and `secret_version`: an environment's values as ciphertext. A write adds a version
// and never changes one, a delete only clears the pointer to the current version (the secret is then
// in the bin, until `Bin` removes it for good), and none of it can be read here. A key only reads:
// the owner writes from the dashboard, and an approved ask step writes through `secretWrites`.
import {
  type ActorIdentity,
  type Bundle,
  InvalidRequestError,
  type LimitReachedError,
  NameIndexSchema,
  type NamesNotSealedError,
  NoAccessError,
  NotFoundError,
  OwnerRequiredError,
  type SealedVersion,
  type Secret,
  type SecretVersion,
  type VersionConflictError,
} from '@baymutt/api';
import * as D1Client from '@effect/sql-d1/D1Client';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import { isLogin, namesNotSealed } from './access/rows.ts';
import { Access } from './access.ts';
import { ActorJsonSchema, actorOf } from './actors.ts';
import { Audit } from './audit.ts';
import { type Slot, secretWrites, type Write } from './secret-writes.ts';

const SecretRowSchema = Schema.Struct({
  name: Schema.String,
  sealedName: Schema.NullOr(Schema.String),
  currentVersion: Schema.NullOr(Schema.Finite),
  latestVersion: Schema.Finite,
  size: Schema.NullOr(Schema.Finite),
  updatedAt: Schema.Finite,
  updatedBy: ActorJsonSchema,
  purgeAt: Schema.NullOr(Schema.Finite),
});

const VersionRowSchema = Schema.Struct({
  version: Schema.Finite,
  keyVersion: Schema.Finite,
  size: Schema.Finite,
  createdAt: Schema.Finite,
  createdBy: ActorJsonSchema,
  isCurrent: Schema.Finite,
});

const isNameIndex = Schema.is(NameIndexSchema);

export class Secrets extends Context.Service<
  Secrets,
  {
    readonly list: (request: {
      readonly actor: ActorIdentity;
      readonly environmentId: string;
    }) => Effect.Effect<ReadonlyArray<Secret>, NotFoundError | NoAccessError>;
    /** Every current value's ciphertext and the caller's wrap of the environment key. Logged. */
    readonly bundle: (request: {
      readonly actor: ActorIdentity;
      readonly environmentId: string;
    }) => Effect.Effect<Bundle, NotFoundError | NoAccessError>;
    /** Adds `version`, which must be one above the latest, and makes it current. */
    readonly write: (request: {
      readonly actor: ActorIdentity;
      readonly write: Write;
    }) => Effect.Effect<
      Secret,
      | NotFoundError
      | OwnerRequiredError
      | VersionConflictError
      | LimitReachedError
      | NamesNotSealedError
      | InvalidRequestError
    >;
    /** To the bin: clears the current version and keeps every version until it is removed for good. */
    readonly remove: (
      request: { readonly actor: ActorIdentity } & Slot,
    ) => Effect.Effect<Secret, NotFoundError | OwnerRequiredError>;
    readonly rollback: (
      request: {
        readonly actor: ActorIdentity;
        readonly version: number;
        /** A restore from the bin: nothing moves when the secret has left it since. */
        readonly fromBin?: boolean;
      } & Slot,
    ) => Effect.Effect<Secret, NotFoundError | OwnerRequiredError>;
    readonly versions: (
      request: { readonly actor: ActorIdentity } & Slot,
    ) => Effect.Effect<ReadonlyArray<SecretVersion>, NotFoundError | NoAccessError>;
    /** One version's ciphertext, for the owner's browser to open. Logged before it is answered. */
    readonly reveal: (
      request: { readonly actor: ActorIdentity; readonly version: number } & Slot,
    ) => Effect.Effect<SealedVersion, NotFoundError | OwnerRequiredError>;
  }
>()('@baymutt/worker-web/services/Secrets') {
  static readonly layer = Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const sql = yield* D1Client.D1Client;
      const access = yield* Access;
      const audit = yield* Audit;
      const writes = secretWrites({ sql, audit });

      const secretRows = SqlSchema.findAll({
        Request: Schema.Struct({
          environmentId: Schema.String,
          name: Schema.NullOr(Schema.String),
        }),
        Result: SecretRowSchema,
        execute: ({ environmentId, name }) =>
          sql`SELECT s.name, s.sealed_name, s.current_version, s.latest_version, s.updated_at,
                s.updated_by, s.purge_at,
                (SELECT length(v.ciphertext) * 3 / 4 FROM secret_version v
                  WHERE v.environment_id = s.environment_id AND v.name = s.name
                    AND v.version = s.current_version) AS size
              FROM secret s
              WHERE s.environment_id = ${environmentId} AND (${name} IS NULL OR s.name = ${name})
              ORDER BY s.name`,
      });

      const versionRows = SqlSchema.findAll({
        Request: Schema.Struct({ environmentId: Schema.String, name: Schema.String }),
        Result: VersionRowSchema,
        execute: ({ environmentId, name }) =>
          sql`SELECT v.version, v.key_version, length(v.ciphertext) * 3 / 4 AS size, v.created_at,
                v.created_by, v.version IS s.current_version AS is_current
              FROM secret_version v
              JOIN secret s ON s.environment_id = v.environment_id AND s.name = v.name
              WHERE v.environment_id = ${environmentId} AND v.name = ${name}
              ORDER BY v.version DESC`,
      });

      const currentCiphertexts = SqlSchema.findAll({
        Request: Schema.String,
        Result: Schema.Struct({
          name: Schema.String,
          sealedName: Schema.NullOr(Schema.String),
          version: Schema.Finite,
          keyVersion: Schema.Finite,
          ciphertext: Schema.String,
        }),
        execute: environmentId =>
          sql`SELECT v.name, s.sealed_name, v.version, v.key_version, v.ciphertext
              FROM secret s
              JOIN secret_version v
                ON v.environment_id = s.environment_id AND v.name = s.name AND v.version = s.current_version
              WHERE s.environment_id = ${environmentId} ORDER BY v.name`,
      });

      const sealedVersion = SqlSchema.findAll({
        Request: Schema.Struct({
          environmentId: Schema.String,
          name: Schema.String,
          version: Schema.Finite,
        }),
        Result: Schema.Struct({
          version: Schema.Finite,
          keyVersion: Schema.Finite,
          ciphertext: Schema.String,
        }),
        execute: ({ environmentId, name, version }) =>
          sql`SELECT version, key_version, ciphertext FROM secret_version
              WHERE environment_id = ${environmentId} AND name = ${name} AND version = ${version}`,
      });

      const secret = Effect.fnUntraced(function* ({ environmentId, name }: Slot) {
        const [row] = yield* secretRows({ environmentId, name }).pipe(Effect.orDie);
        if (row === undefined) {
          return yield* new NotFoundError({
            message:
              'This environment has no secret by this name. List them with `baymutt secret list <environment>`.',
          });
        }
        return row satisfies Secret;
      });

      /**
       * An environment whose values the caller may change: the signed-in owner of its org. A key
       * only reads, and a CLI login holds nothing: an agent asks for a write in an ask.
       */
      const writable = Effect.fnUntraced(function* (actor: ActorIdentity, environmentId: string) {
        if (actor._tag !== 'Owner') {
          return yield* new OwnerRequiredError({
            message: `${isLogin(actor) ? 'A CLI login holds no environment' : 'A key only reads'}: only the owner writes, deletes or rolls back a secret. Ask the owner for it in an ask's \`secrets\` step (\`baymutt ask --help\`).`,
          });
        }
        return yield* access.ownersEnvironment(actor, environmentId, 'changes a secret');
      });

      /** Moves the current-version pointer and logs it, when the secret exists. */
      const point = Effect.fnUntraced(function* (
        { actor, environmentId, name }: { readonly actor: ActorIdentity } & Slot,
        {
          to,
          action,
          fromBin = false,
        }: {
          readonly to: number | null;
          readonly action: 'secret.delete' | 'secret.rollback';
          readonly fromBin?: boolean;
        },
      ) {
        const { environment } = yield* writable(actor, environmentId);
        // A rollback of a deleted secret is how it leaves the bin; the log says so.
        const [before] = yield* secretRows({ environmentId, name }).pipe(Effect.orDie);
        const [moved] = yield* sql
          .batch(
            yield* writes.pointStatements(
              { environmentId, name },
              {
                to,
                fromBin,
                orgId: environment.orgId,
                actor: actorOf(actor),
                action,
                detail: to !== null && before?.currentVersion === null ? 'from the bin' : null,
                now: yield* Clock.currentTimeMillis,
              },
            ),
          )
          .pipe(Effect.orDie);
        if ((moved ?? []).length === 0) {
          if (to === null) {
            return yield* new NotFoundError({
              message:
                'This environment has no secret by this name, or it is already in the bin (`baymutt bin list`).',
            });
          }
          return yield* new NotFoundError({
            message: fromBin
              ? `This secret is not in the bin any more, or has no version ${to}. See what is with \`baymutt bin list\`.`
              : `This secret has no version ${to}. See its history with \`baymutt secret history\`.`,
          });
        }
        return yield* secret({ environmentId, name }).pipe(Effect.orDie);
      });

      return Secrets.of({
        list: Effect.fn('Secrets.list')(function* ({ actor, environmentId }) {
          yield* access.environment(actor, environmentId);
          return yield* secretRows({ environmentId, name: null }).pipe(Effect.orDie);
        }),

        bundle: Effect.fn('Secrets.bundle')(function* ({ actor, environmentId }) {
          const { environment, wrap, readerId } = yield* access.reading(
            yield* access.environment(actor, environmentId),
          );
          // An environment's values load through a credential; the dashboard reveals one value at
          // a time, through `reveal`.
          if (actor._tag !== 'Credential') {
            return yield* new NoAccessError({
              message:
                'Only a key loads an environment’s values. The dashboard reveals one at a time.',
              need: 'read',
            });
          }
          if (wrap === null) {
            return yield* Effect.die(`a read grant on ${environmentId} has no wrap`);
          }
          const secrets = yield* currentCiphertexts(environmentId).pipe(Effect.orDie);
          yield* (yield* audit.entry({
            orgId: environment.orgId,
            actor: actorOf(actor),
            action: 'environment.load',
            environmentId,
          })).pipe(Effect.orDie);
          return {
            environment: {
              id: environment.id,
              name: environment.name,
              sealedName: environment.sealedName,
              publicKey: environment.publicKey,
              keyVersion: environment.keyVersion,
            },
            wrap,
            readerId,
            secrets,
          };
        }),

        write: Effect.fn('Secrets.write')(function* ({ actor, write }) {
          const { environment, areNamesSealed } = yield* writable(actor, write.environmentId);
          const [existing] = yield* secretRows({
            environmentId: write.environmentId,
            name: write.name,
          }).pipe(Effect.orDie);
          // A name the store has not seen is filed under its index with its sealed name, and only
          // where the names are sealed: the store never learns a new name it could read.
          if (existing === undefined) {
            if (!areNamesSealed) return yield* namesNotSealed(environment.orgSlug);
            if (!isNameIndex(write.name) || write.sealedName === undefined) {
              return yield* new InvalidRequestError({
                message:
                  'A new secret name is sent sealed (`sealedName`), as the dashboard does. Reload it and try again.',
              });
            }
          }
          yield* writes.underLimit(write);
          const { statements } = yield* writes.writeStatements(
            { ...write, sealedName: existing === undefined ? write.sealedName : undefined },
            { orgId: environment.orgId, actor: actorOf(actor), action: 'secret.write' },
          );
          const [moved] = yield* sql.batch(statements).pipe(Effect.orDie);
          if ((moved ?? []).length === 0) return yield* yield* writes.conflict(write);
          return yield* secret(write).pipe(Effect.orDie);
        }),

        remove: Effect.fn('Secrets.remove')(function* (request) {
          return yield* point(request, { to: null, action: 'secret.delete' });
        }),

        rollback: Effect.fn('Secrets.rollback')(function* ({ version, fromBin, ...request }) {
          return yield* point(request, { to: version, action: 'secret.rollback', fromBin });
        }),

        versions: Effect.fn('Secrets.versions')(function* ({ actor, environmentId, name }) {
          yield* access.environment(actor, environmentId);
          const rows = yield* versionRows({ environmentId, name }).pipe(Effect.orDie);
          if (rows.length === 0) {
            return yield* new NotFoundError({
              message: 'This environment has no secret by this name.',
            });
          }
          return rows.map(({ isCurrent, ...row }) => ({ ...row, isCurrent: isCurrent !== 0 }));
        }),

        reveal: Effect.fn('Secrets.reveal')(function* ({ actor, environmentId, name, version }) {
          // A credential loads values through the bundle; this is the dashboard's, which only an
          // owner opens.
          if (actor._tag !== 'Owner') {
            return yield* new OwnerRequiredError({
              message:
                'Only an owner reveals a value, in the dashboard. A key loads values through varlock.',
            });
          }
          const { environment } = yield* access.ownersEnvironment(
            actor,
            environmentId,
            'reveals a value',
          );
          const [row] = yield* sealedVersion({ environmentId, name, version }).pipe(Effect.orDie);
          if (row === undefined) {
            return yield* new NotFoundError({
              message: `This secret has no version ${version} in this environment.`,
            });
          }
          yield* (yield* audit.entry({
            orgId: environment.orgId,
            actor: actorOf(actor),
            action: 'secret.reveal',
            environmentId,
            secretName: name,
            version,
          })).pipe(Effect.orDie);
          return row;
        }),
      });
    }),
  );
}
