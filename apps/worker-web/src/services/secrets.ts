// Owns `secret`, `secret_version` and `paste_link`: an environment's values as ciphertext. A write
// adds a version and never changes one, a delete only clears the pointer to the current version
// (the secret is then in the bin, until `Bin` removes it for good), and none of it can be read here.
import {
  type Actor,
  type ActorIdentity,
  AlreadyExistsError,
  type Bundle,
  InvalidRequestError,
  LIMITS,
  LimitReachedError,
  LinkSpentError,
  NameIndexSchema,
  type NamesNotSealedError,
  NoAccessError,
  NotFoundError,
  OwnerRequiredError,
  PASTE_LINK_WAIT_MS,
  type PasteLink,
  type PasteTarget,
  type SealedVersion,
  type Secret,
  type SecretVersion,
  VersionConflictError,
} from '@baymutt/api';
import * as D1Client from '@effect/sql-d1/D1Client';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import type * as Statement from 'effect/sql/Statement';
import { namesNotSealed, orgsOf } from './access/rows.ts';
import { Access } from './access.ts';
import { ActorJsonSchema, actorOf, encodeActor } from './actors.ts';
import { Audit } from './audit.ts';
import { BIN_MS } from './bin.ts';

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

const PasteRowSchema = Schema.Struct({
  id: Schema.String,
  orgId: Schema.String,
  orgSlug: Schema.String,
  environmentId: Schema.String,
  environmentName: Schema.String,
  environmentSealedName: Schema.NullOr(Schema.String),
  environmentPublicKey: Schema.String,
  keyVersion: Schema.Finite,
  name: Schema.String,
  sealedName: Schema.NullOr(Schema.String),
  reason: Schema.String,
  hint: Schema.String,
  status: Schema.Literals(['pending', 'fulfilled', 'cancelled', 'expired']),
  createdBy: ActorJsonSchema,
  createdAt: Schema.Finite,
  latestVersion: Schema.NullOr(Schema.Finite),
});
type PasteRow = typeof PasteRowSchema.Type;

type Slot = { readonly environmentId: string; readonly name: string };
type SealedValue = {
  readonly version: number;
  readonly keyVersion: number;
  readonly ciphertext: string;
};
type Write = Slot &
  SealedValue & {
    /** Needed for a new name, which is stored only in a sealed org; ignored for one that exists. */
    readonly sealedName?: string | undefined;
  };

const toPasteLink = ({
  environmentPublicKey: _,
  keyVersion: __,
  latestVersion: ___,
  ...link
}: PasteRow): PasteLink => link;

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
      | NoAccessError
      | VersionConflictError
      | LimitReachedError
      | NamesNotSealedError
      | InvalidRequestError
    >;
    /** To the bin: clears the current version and keeps every version until it is removed for good. */
    readonly remove: (
      request: { readonly actor: ActorIdentity } & Slot,
    ) => Effect.Effect<Secret, NotFoundError | NoAccessError>;
    readonly rollback: (
      request: {
        readonly actor: ActorIdentity;
        readonly version: number;
        /** A restore from the bin: nothing moves when the secret has left it since. */
        readonly fromBin?: boolean;
      } & Slot,
    ) => Effect.Effect<Secret, NotFoundError | NoAccessError>;
    readonly versions: (
      request: { readonly actor: ActorIdentity } & Slot,
    ) => Effect.Effect<ReadonlyArray<SecretVersion>, NotFoundError | NoAccessError>;
    /** One version's ciphertext, for the owner's browser to open. Logged before it is answered. */
    readonly reveal: (
      request: { readonly actor: ActorIdentity; readonly version: number } & Slot,
    ) => Effect.Effect<SealedVersion, NotFoundError | OwnerRequiredError>;

    readonly listPasteLinks: (actor: ActorIdentity) => Effect.Effect<ReadonlyArray<PasteLink>>;
    /** For the owner, and for the credential that made it. */
    readonly getPasteLink: (request: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) => Effect.Effect<PasteLink, NotFoundError>;
    readonly createPasteLink: (request: {
      readonly actor: ActorIdentity;
      readonly paste: Slot & {
        readonly id: string;
        readonly sealedName: string;
        readonly reason: string;
        readonly hint: string;
      };
    }) => Effect.Effect<
      PasteLink,
      NotFoundError | NoAccessError | AlreadyExistsError | NamesNotSealedError
    >;
    readonly cancelPasteLink: (request: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) => Effect.Effect<PasteLink, NotFoundError | LinkSpentError>;
    /** For an owner of the link's org, signed in. */
    readonly pasteTarget: (request: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) => Effect.Effect<PasteTarget, NotFoundError | LinkSpentError | OwnerRequiredError>;
    /** The owner writes the pasted value and spends the link, together. */
    readonly fulfilPaste: (request: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly write: SealedValue;
    }) => Effect.Effect<
      Secret,
      NotFoundError | LinkSpentError | OwnerRequiredError | VersionConflictError | LimitReachedError
    >;
  }
>()('@baymutt/worker-web/services/Secrets') {
  static readonly layer = Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const sql = yield* D1Client.D1Client;
      const access = yield* Access;
      const audit = yield* Audit;

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

      const PasteQuerySchema = Schema.Struct({
        accountId: Schema.NullOr(Schema.String),
        createdBy: Schema.NullOr(Schema.String),
        id: Schema.NullOr(Schema.String),
        /** A pending link made at or before this has expired, whatever its row still says. */
        expiredBy: Schema.Finite,
      });

      const storedPasteRows = SqlSchema.findAll({
        Request: PasteQuerySchema,
        Result: PasteRowSchema,
        execute: ({ accountId, createdBy, id, expiredBy }) =>
          sql`SELECT r.id, e.org_id, o.slug AS org_slug, r.environment_id,
                e.name AS environment_name, e.sealed_name AS environment_sealed_name,
                e.public_key AS environment_public_key, e.key_version, r.name, r.sealed_name,
                r.reason, r.hint, r.status, r.created_by, r.created_at,
                (SELECT s.latest_version FROM secret s
                  WHERE s.environment_id = r.environment_id AND s.name = r.name) AS latest_version
              FROM paste_link r
              JOIN environment e ON e.id = r.environment_id
              JOIN organization o ON o.id = e.org_id
              WHERE e.deleted_at IS NULL
                AND (${accountId} IS NULL OR e.org_id IN (${orgsOf(sql, accountId ?? '')}))
                AND (${id} IS NOT NULL OR (r.status = 'pending' AND r.created_at > ${expiredBy}))
                AND (${id} IS NULL OR r.id = ${id})
                AND (${createdBy} IS NULL OR json_extract(r.created_by, '$.id') = ${createdBy})
              ORDER BY r.created_at DESC LIMIT 200`,
      });

      /**
       * Paste links of live environments: of the caller's orgs, or any when `accountId` is null.
       * One still pending past its hour is expired from that moment; no run has to close it.
       */
      const pasteRows = Effect.fnUntraced(function* (
        filter: Omit<typeof PasteQuerySchema.Type, 'expiredBy'>,
      ) {
        const expiredBy = (yield* Clock.currentTimeMillis) - PASTE_LINK_WAIT_MS;
        const rows = yield* storedPasteRows({ ...filter, expiredBy });
        return rows.map(row =>
          row.status === 'pending' && row.createdAt <= expiredBy
            ? { ...row, status: 'expired' as const }
            : row,
        );
      });

      /** A link still waiting at `now`: pending, and not past its hour. */
      const isWaiting = (now: number) =>
        sql`status = 'pending' AND created_at > ${now - PASTE_LINK_WAIT_MS}`;

      const spent = (status: PasteRow['status']) =>
        new LinkSpentError({
          message:
            status === 'expired'
              ? 'This paste link expired: nobody answered it within an hour. Whoever needs the value makes a new one.'
              : `This paste link was already ${status}.`,
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
       * The three statements of a write: the secret's row moves to `version` only from the one
       * below it and only under the environment's current key, the version row is added only if that
       * took, and so is the log entry. `alsoIf` is one more condition on the first.
       */
      const writeStatements = Effect.fnUntraced(function* (
        { environmentId, name, version, keyVersion, ciphertext, sealedName }: Write,
        {
          orgId,
          actor,
          action,
          alsoIf,
        }: {
          readonly orgId: string;
          readonly actor: Actor;
          readonly action: 'secret.write' | 'paste-link.fulfil';
          readonly alsoIf?: Statement.Fragment;
        },
      ) {
        const now = yield* Clock.currentTimeMillis;
        const by = encodeActor(actor);
        const writeId = crypto.randomUUID();
        const took = sql`EXISTS (SELECT 1 FROM secret
          WHERE environment_id = ${environmentId} AND name = ${name} AND write_id = ${writeId})`;
        const statements = [
          // A new name is stored only with its sealed name; one that exists keeps its own.
          sql`INSERT INTO secret
                (environment_id, name, sealed_name, current_version, latest_version, updated_at,
                 updated_by, write_id)
              SELECT ${environmentId}, ${name}, ${sealedName ?? null}, ${version}, ${version},
                ${now}, ${by}, ${writeId}
              WHERE EXISTS (SELECT 1 FROM environment
                            WHERE id = ${environmentId} AND key_version = ${keyVersion}
                              AND deleted_at IS NULL)
                AND ((${version} = 1 AND ${sealedName ?? null} IS NOT NULL)
                     OR EXISTS (SELECT 1 FROM secret
                                WHERE environment_id = ${environmentId} AND name = ${name}))
                AND ${alsoIf ?? sql`1 = 1`}
              ON CONFLICT (environment_id, name) DO UPDATE
                SET current_version = excluded.current_version,
                    latest_version = excluded.latest_version,
                    updated_at = excluded.updated_at, updated_by = excluded.updated_by,
                    write_id = excluded.write_id, purge_at = NULL
                WHERE secret.latest_version = excluded.latest_version - 1
              RETURNING latest_version`,
          sql`INSERT INTO secret_version
                (environment_id, name, version, key_version, ciphertext, created_by, created_at)
              SELECT ${environmentId}, ${name}, ${version}, ${keyVersion}, ${ciphertext}, ${by},
                ${now}
              WHERE ${took}`,
          yield* audit.entry(
            { orgId, actor, action, environmentId, secretName: name, version },
            took,
          ),
        ] as const;
        return { statements, took };
      });

      /** Counted before the write: a cap on growth, which two writers at once can overshoot by one. */
      const underLimit = Effect.fnUntraced(function* ({
        environmentId,
        version,
      }: Pick<Write, 'environmentId' | 'version'>) {
        if (version > LIMITS.versionsPerSecret) {
          return yield* new LimitReachedError({
            limit: LIMITS.versionsPerSecret,
            message: `A secret keeps up to ${LIMITS.versionsPerSecret} versions while baymutt is in beta.`,
          });
        }
        if (version !== 1) return;
        const [row] = yield* sql`SELECT COUNT(*) AS held FROM secret
          WHERE environment_id = ${environmentId}`.pipe(Effect.orDie);
        if (Number(row?.held ?? 0) >= LIMITS.secretsPerEnvironment) {
          return yield* new LimitReachedError({
            limit: LIMITS.secretsPerEnvironment,
            message: `An environment holds up to ${LIMITS.secretsPerEnvironment} secrets while baymutt is in beta.`,
          });
        }
      });

      const conflict = Effect.fnUntraced(function* ({ environmentId, name }: Slot) {
        const [found] = yield* sql`SELECT
            (SELECT latest_version FROM secret WHERE environment_id = ${environmentId} AND name = ${name})
              AS latest_version,
            (SELECT key_version FROM environment WHERE id = ${environmentId}) AS key_version`.pipe(
          Effect.orDie,
        );
        const latestVersion = Number(found?.latestVersion ?? 0);
        const keyVersion = Number(found?.keyVersion ?? 0);
        return new VersionConflictError({
          latestVersion,
          keyVersion,
          message: `This secret is at version ${latestVersion} under environment key ${keyVersion}. Seal the value again for version ${latestVersion + 1} and that key, then write it.`,
        });
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
        const { environment } = yield* access.needing(
          yield* access.environment(actor, environmentId),
          'write',
        );
        // A rollback of a deleted secret is how it leaves the bin; the log says so.
        const [before] = yield* secretRows({ environmentId, name }).pipe(Effect.orDie);
        const now = yield* Clock.currentTimeMillis;
        const by = encodeActor(actorOf(actor));
        const writeId = crypto.randomUUID();
        const [moved] = yield* sql
          .batch([
            sql`UPDATE secret
                SET current_version = ${to}, updated_at = ${now}, updated_by = ${by},
                    write_id = ${writeId}, purge_at = ${to === null ? now + BIN_MS : null}
                WHERE environment_id = ${environmentId} AND name = ${name}
                  AND (${to} IS NOT NULL OR current_version IS NOT NULL)
                  AND (${fromBin ? 1 : 0} = 0 OR current_version IS NULL)
                  AND (${to} IS NULL OR EXISTS (SELECT 1 FROM secret_version
                                               WHERE environment_id = ${environmentId} AND name = ${name}
                                                 AND version = ${to}))
                RETURNING name`,
            yield* audit.entry(
              {
                orgId: environment.orgId,
                actor: actorOf(actor),
                action,
                environmentId,
                secretName: name,
                version: to,
                detail: to !== null && before?.currentVersion === null ? 'from the bin' : null,
              },
              sql`EXISTS (SELECT 1 FROM secret WHERE environment_id = ${environmentId} AND name = ${name}
                           AND write_id = ${writeId})`,
            ),
          ])
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

      const pasteRow = Effect.fnUntraced(function* (id: string, accountId: string | null) {
        const [row] = yield* pasteRows({ accountId, createdBy: null, id }).pipe(Effect.orDie);
        if (row === undefined) {
          return yield* new NotFoundError({ message: 'No paste link has this id.' });
        }
        return row;
      });

      /** A pending link an owner of its org answers, signed in: nobody else, and no link alone. */
      const answerable = Effect.fnUntraced(function* (actor: ActorIdentity, id: string) {
        if (actor._tag !== 'Owner') {
          return yield* new OwnerRequiredError({
            message:
              'Only the owner answers a paste link, signed in to the dashboard. Send them the link; `baymutt ask wait <id>` returns once they have.',
          });
        }
        const row = yield* pasteRow(id, actor.accountId);
        const [owns] = yield* sql`SELECT 1 AS owns FROM member m
          JOIN store_account a ON a.user_id = m.userId
          WHERE m.organizationId = ${row.orgId} AND a.id = ${actor.accountId}
            AND m.role = 'owner'`.pipe(Effect.orDie);
        if (owns === undefined) {
          return yield* new OwnerRequiredError({
            message: `Only an owner of ${row.orgSlug} answers this paste link.`,
          });
        }
        if (row.status !== 'pending') return yield* spent(row.status);
        return row;
      });

      return Secrets.of({
        list: Effect.fn('Secrets.list')(function* ({ actor, environmentId }) {
          yield* access.environment(actor, environmentId);
          return yield* secretRows({ environmentId, name: null }).pipe(Effect.orDie);
        }),

        bundle: Effect.fn('Secrets.bundle')(function* ({ actor, environmentId }) {
          const { environment, wrap, readerId } = yield* access.needing(
            yield* access.environment(actor, environmentId),
            'read',
          );
          // An environment's values load through a credential; the dashboard reveals one value at
          // a time, through `reveal`.
          if (actor._tag !== 'Credential') {
            return yield* new NoAccessError({
              message: 'Only a service account loads an environment’s values.',
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
          const { environment, areNamesSealed } = yield* access.needing(
            yield* access.environment(actor, write.environmentId),
            'write',
          );
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
                  'A new secret name is sent sealed (`sealedName`), as a current baymutt CLI does. Update the baymutt CLI and try again.',
              });
            }
          }
          yield* underLimit(write);
          const { statements } = yield* writeStatements(
            { ...write, sealedName: existing === undefined ? write.sealedName : undefined },
            { orgId: environment.orgId, actor: actorOf(actor), action: 'secret.write' },
          );
          const [moved] = yield* sql.batch(statements).pipe(Effect.orDie);
          if ((moved ?? []).length === 0) return yield* yield* conflict(write);
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
                'Only an owner reveals a value, in the dashboard. A CLI login or service account loads values through varlock.',
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

        listPasteLinks: Effect.fn('Secrets.listPasteLinks')(function* (actor) {
          const rows = yield* pasteRows({
            accountId: actor.accountId,
            createdBy: actor._tag === 'Credential' ? actor.credentialId : null,
            id: null,
          }).pipe(Effect.orDie);
          return rows.map(toPasteLink);
        }),

        getPasteLink: Effect.fn('Secrets.getPasteLink')(function* ({ actor, id }) {
          const row = yield* pasteRow(id, actor.accountId);
          // One a credential did not make is not its to see.
          if (actor._tag === 'Credential' && row.createdBy.id !== actor.credentialId) {
            return yield* new NotFoundError({ message: 'No paste link has this id.' });
          }
          return toPasteLink(row);
        }),

        createPasteLink: Effect.fn('Secrets.createPasteLink')(function* ({ actor, paste }) {
          const listed = yield* access.environment(actor, paste.environmentId);
          // A CLI login lists every environment of its person's orgs and asks for a value in any;
          // a service account, only where it may write the value itself.
          const { environment, areNamesSealed } = listed.readerIsLogin
            ? listed
            : yield* access.needing(listed, 'write');
          if (!areNamesSealed) return yield* namesNotSealed(environment.orgSlug);
          const now = yield* Clock.currentTimeMillis;
          const by = encodeActor(actorOf(actor));
          const took = sql`EXISTS (SELECT 1 FROM paste_link
                            WHERE id = ${paste.id} AND created_at = ${now} AND created_by = ${by})`;
          const [inserted] = yield* sql
            .batch([
              sql`INSERT OR IGNORE INTO paste_link
                    (id, environment_id, name, sealed_name, reason, hint, status, created_by,
                     created_at)
                  VALUES (${paste.id}, ${paste.environmentId}, ${paste.name}, ${paste.sealedName},
                    ${paste.reason}, ${paste.hint}, 'pending', ${by}, ${now})
                  RETURNING id`,
              // A new link replaces the earlier one for the same name: the owner sees one.
              sql`UPDATE paste_link SET status = 'cancelled', resolved_at = ${now}
                  WHERE environment_id = ${paste.environmentId} AND name = ${paste.name}
                    AND ${isWaiting(now)} AND id != ${paste.id} AND ${took}`,
              yield* audit.entry(
                {
                  orgId: environment.orgId,
                  actor: actorOf(actor),
                  action: 'paste-link.create',
                  environmentId: paste.environmentId,
                  secretName: paste.name,
                  secretSealedName: paste.sealedName,
                  detail: paste.reason,
                },
                took,
              ),
            ])
            .pipe(Effect.orDie);
          if ((inserted ?? []).length === 0) {
            return yield* new AlreadyExistsError({
              message: 'A paste link with this id exists.',
            });
          }
          return toPasteLink(yield* pasteRow(paste.id, actor.accountId).pipe(Effect.orDie));
        }),

        cancelPasteLink: Effect.fn('Secrets.cancelPasteLink')(function* ({ actor, id }) {
          const row = yield* pasteRow(id, actor.accountId);
          // A credential cancels the links it made; one it did not make is not its to see.
          if (actor._tag === 'Credential' && row.createdBy.id !== actor.credentialId) {
            return yield* new NotFoundError({ message: 'No paste link has this id.' });
          }
          if (row.status !== 'pending') return yield* spent(row.status);
          const now = yield* Clock.currentTimeMillis;
          // Logged first, while it is still waiting: one answered or expired in between is not.
          const [, cancelled] = yield* sql
            .batch([
              yield* audit.entry(
                {
                  orgId: row.orgId,
                  actor: actorOf(actor),
                  action: 'paste-link.cancel',
                  environmentId: row.environmentId,
                  secretName: row.name,
                  secretSealedName: row.sealedName,
                },
                sql`EXISTS (SELECT 1 FROM paste_link WHERE id = ${id} AND ${isWaiting(now)})`,
              ),
              sql`UPDATE paste_link SET status = 'cancelled', resolved_at = ${now}
                  WHERE id = ${id} AND ${isWaiting(now)} RETURNING id`,
            ])
            .pipe(Effect.orDie);
          if ((cancelled ?? []).length === 0) {
            return yield* spent((yield* pasteRow(id, actor.accountId).pipe(Effect.orDie)).status);
          }
          return toPasteLink({ ...row, status: 'cancelled' });
        }),

        pasteTarget: Effect.fn('Secrets.pasteTarget')(function* ({ actor, id }) {
          const row = yield* answerable(actor, id);
          return {
            link: toPasteLink(row),
            environmentPublicKey: row.environmentPublicKey,
            keyVersion: row.keyVersion,
            nextVersion: (row.latestVersion ?? 0) + 1,
          };
        }),

        fulfilPaste: Effect.fn('Secrets.fulfilPaste')(function* ({ actor, id, write }) {
          const row = yield* answerable(actor, id);
          const slot = { environmentId: row.environmentId, name: row.name };
          yield* underLimit({ ...slot, version: write.version });
          const now = yield* Clock.currentTimeMillis;
          // One batch: the value is written only while the link is still pending, under the link's
          // own name and sealed name, and the link is spent only if the value was written, so a
          // link answers once.
          const { statements, took } = yield* writeStatements(
            { ...slot, ...write, sealedName: row.sealedName ?? undefined },
            {
              orgId: row.orgId,
              actor: actorOf(actor),
              action: 'paste-link.fulfil',
              alsoIf: sql`EXISTS (SELECT 1 FROM paste_link WHERE id = ${id} AND ${isWaiting(now)})`,
            },
          );
          const [moved] = yield* sql
            .batch([
              ...statements,
              sql`UPDATE paste_link SET status = 'fulfilled', resolved_at = ${now}
                  WHERE id = ${id} AND ${isWaiting(now)} AND ${took}`,
              // The value is in: any other link for the same name has nothing left to ask.
              sql`UPDATE paste_link SET status = 'cancelled', resolved_at = ${now}
                  WHERE environment_id = ${slot.environmentId} AND name = ${slot.name}
                    AND ${isWaiting(now)} AND ${took}`,
            ])
            .pipe(Effect.orDie);
          if ((moved ?? []).length === 0) {
            const after = yield* pasteRow(id, null).pipe(Effect.orDie);
            if (after.status !== 'pending') return yield* spent(after.status);
            return yield* yield* conflict(slot);
          }
          return yield* secret(slot).pipe(Effect.orDie);
        }),
      });
    }),
  );
}
