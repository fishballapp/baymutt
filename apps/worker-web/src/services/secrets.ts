// Owns `secret`, `secret_version` and `paste_link`: an environment's values as ciphertext. A write
// adds a version and never changes one, a delete only clears the pointer to the current version
// (the secret is then in the bin, until `Bin` removes it for good), and none of it can be read here.
import {
  type Actor,
  type ActorIdentity,
  AlreadyExistsError,
  type Bundle,
  LIMITS,
  LimitReachedError,
  LinkSpentError,
  NoAccessError,
  NotFoundError,
  OwnerRequiredError,
  type PasteLink,
  type PasteTarget,
  type SealedVersion,
  type Secret,
  type SecretVersion,
  UnauthorizedError,
  VersionConflictError,
} from '@baymutt/api';
import { tokenHash } from '@baymutt/keys/wire';
import * as D1Client from '@effect/sql-d1/D1Client';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import type * as Statement from 'effect/sql/Statement';
import { orgsOf } from './access/rows.ts';
import { Access } from './access.ts';
import { ActorJsonSchema, actorOf, encodeActor, LINK_ACTOR } from './actors.ts';
import { Audit } from './audit.ts';
import { BIN_MS } from './bin.ts';

const SecretRowSchema = Schema.Struct({
  name: Schema.String,
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
  environmentPublicKey: Schema.String,
  keyVersion: Schema.Finite,
  name: Schema.String,
  reason: Schema.String,
  hint: Schema.String,
  tokenHash: Schema.String,
  status: Schema.Literals(['pending', 'fulfilled', 'cancelled']),
  createdBy: ActorJsonSchema,
  createdAt: Schema.Finite,
  linkExpiresAt: Schema.Finite,
  latestVersion: Schema.NullOr(Schema.Finite),
});
type PasteRow = typeof PasteRowSchema.Type;

/** How long a paste link works. It stays answerable from the dashboard after it. */
const PASTE_LINK_LIFETIME_MS = 15 * 60_000;

type Slot = { readonly environmentId: string; readonly name: string };
type Write = Slot & {
  readonly version: number;
  readonly keyVersion: number;
  readonly ciphertext: string;
};

type Caller = { readonly actor: ActorIdentity | null; readonly token: string | undefined };

const toPasteLink = (row: PasteRow): PasteLink => ({
  id: row.id,
  orgId: row.orgId,
  orgSlug: row.orgSlug,
  environmentId: row.environmentId,
  environmentName: row.environmentName,
  name: row.name,
  reason: row.reason,
  hint: row.hint,
  status: row.status,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  linkExpiresAt: row.linkExpiresAt,
});

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
      NotFoundError | NoAccessError | VersionConflictError | LimitReachedError
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
    readonly createPasteLink: (request: {
      readonly actor: ActorIdentity;
      readonly paste: Slot & {
        readonly id: string;
        readonly reason: string;
        readonly hint: string;
        readonly tokenHash: string;
      };
    }) => Effect.Effect<PasteLink, NotFoundError | NoAccessError | AlreadyExistsError>;
    readonly cancelPasteLink: (request: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) => Effect.Effect<PasteLink, NotFoundError | LinkSpentError>;
    /** For the link's token while it lasts, or for the owner. */
    readonly pasteTarget: (request: {
      readonly caller: Caller;
      readonly id: string;
    }) => Effect.Effect<PasteTarget, NotFoundError | LinkSpentError | UnauthorizedError>;
    /** Writes the pasted value and spends the link, together. */
    readonly fulfilPaste: (request: {
      readonly caller: Caller;
      readonly id: string;
      readonly write: Omit<Write, keyof Slot>;
    }) => Effect.Effect<
      Secret,
      NotFoundError | LinkSpentError | UnauthorizedError | VersionConflictError | LimitReachedError
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
          sql`SELECT s.name, s.current_version, s.latest_version, s.updated_at, s.updated_by,
                s.purge_at,
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
          version: Schema.Finite,
          keyVersion: Schema.Finite,
          ciphertext: Schema.String,
        }),
        execute: environmentId =>
          sql`SELECT v.name, v.version, v.key_version, v.ciphertext
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

      /** Paste links of live environments: of the caller's orgs, or any when `accountId` is null. */
      const pasteRows = SqlSchema.findAll({
        Request: Schema.Struct({
          accountId: Schema.NullOr(Schema.String),
          createdBy: Schema.NullOr(Schema.String),
          id: Schema.NullOr(Schema.String),
        }),
        Result: PasteRowSchema,
        execute: ({ accountId, createdBy, id }) =>
          sql`SELECT r.id, e.org_id, o.slug AS org_slug, r.environment_id,
                e.name AS environment_name, e.public_key AS environment_public_key, e.key_version,
                r.name, r.reason, r.hint, r.token_hash, r.status, r.created_by, r.created_at,
                r.link_expires_at,
                (SELECT s.latest_version FROM secret s
                  WHERE s.environment_id = r.environment_id AND s.name = r.name) AS latest_version
              FROM paste_link r
              JOIN environment e ON e.id = r.environment_id
              JOIN organization o ON o.id = e.org_id
              WHERE e.deleted_at IS NULL
                AND (${accountId} IS NULL OR e.org_id IN (${orgsOf(sql, accountId ?? '')}))
                AND (${id} IS NOT NULL OR r.status = 'pending')
                AND (${id} IS NULL OR r.id = ${id})
                AND (${createdBy} IS NULL OR json_extract(r.created_by, '$.id') = ${createdBy})
              ORDER BY r.created_at DESC LIMIT 200`,
      });

      const secret = Effect.fnUntraced(function* ({ environmentId, name }: Slot) {
        const [row] = yield* secretRows({ environmentId, name }).pipe(Effect.orDie);
        if (row === undefined) {
          return yield* new NotFoundError({
            message: `This environment has no secret named ${name}. List them with \`baymutt secrets <environment>\`.`,
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
        { environmentId, name, version, keyVersion, ciphertext }: Write,
        {
          orgId,
          actor,
          environmentName,
          action,
          alsoIf,
        }: {
          readonly orgId: string;
          readonly actor: Actor;
          readonly environmentName: string;
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
          sql`INSERT INTO secret
                (environment_id, name, current_version, latest_version, updated_at, updated_by,
                 write_id)
              SELECT ${environmentId}, ${name}, ${version}, ${version}, ${now}, ${by}, ${writeId}
              WHERE EXISTS (SELECT 1 FROM environment
                            WHERE id = ${environmentId} AND key_version = ${keyVersion}
                              AND deleted_at IS NULL)
                AND (${version} = 1 OR EXISTS (SELECT 1 FROM secret
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
            { orgId, actor, action, environmentId, environmentName, secretName: name, version },
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
          message: `${name} is at version ${latestVersion} under environment key ${keyVersion}. Seal the value again for version ${latestVersion + 1} and that key, then write it.`,
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
                environmentName: environment.name,
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
              message: `This environment has no secret named ${name}, or it is already in the bin (\`baymutt bin list\`).`,
            });
          }
          return yield* new NotFoundError({
            message: fromBin
              ? `${name} is not in the bin any more, or has no version ${to}. See what is with \`baymutt bin list\`.`
              : `${name} has no version ${to}. See its history with \`baymutt secrets history\`.`,
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

      const ownsOrg = Effect.fnUntraced(function* (accountId: string, orgId: string) {
        const [found] = yield* sql`SELECT 1 AS owns FROM member m
          JOIN store_account a ON a.user_id = m.userId
          WHERE m.organizationId = ${orgId} AND a.id = ${accountId} AND m.role = 'owner'`.pipe(
          Effect.orDie,
        );
        return found !== undefined;
      });

      /** The pending link a paste page may answer: an owner of its org any time, its token until it expires. */
      const answerable = Effect.fnUntraced(function* ({ actor, token }: Caller, id: string) {
        // Whoever holds the link may be signed in to an account of their own: only an owner of
        // the link's org skips the token.
        const row = yield* pasteRow(id, null);
        if (row.status !== 'pending') {
          return yield* new LinkSpentError({
            message: `This paste link was already ${row.status}.`,
          });
        }
        if (actor?._tag === 'Owner' && (yield* ownsOrg(actor.accountId, row.orgId))) {
          return { row, by: actorOf(actor) };
        }
        if (
          token === undefined ||
          (yield* Effect.promise(() => tokenHash(token))) !== row.tokenHash
        ) {
          return yield* new UnauthorizedError({
            message:
              'Open the paste link itself, or sign in to the dashboard as an owner of its org.',
          });
        }
        if ((yield* Clock.currentTimeMillis) >= row.linkExpiresAt) {
          return yield* new LinkSpentError({
            message: 'This link has expired. It is still in the dashboard, under Paste links.',
          });
        }
        return { row, by: LINK_ACTOR };
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
              message: 'Only a CLI login or a service account loads an environment’s values.',
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
            environmentName: environment.name,
          })).pipe(Effect.orDie);
          return {
            environment: {
              id: environment.id,
              name: environment.name,
              publicKey: environment.publicKey,
              keyVersion: environment.keyVersion,
            },
            wrap,
            readerId,
            secrets,
          };
        }),

        write: Effect.fn('Secrets.write')(function* ({ actor, write }) {
          const { environment } = yield* access.needing(
            yield* access.environment(actor, write.environmentId),
            'write',
          );
          yield* underLimit(write);
          const { statements } = yield* writeStatements(write, {
            orgId: environment.orgId,
            actor: actorOf(actor),
            environmentName: environment.name,
            action: 'secret.write',
          });
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
              message: `This environment has no secret named ${name}.`,
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
              message: `This environment has no version ${version} of ${name}.`,
            });
          }
          yield* (yield* audit.entry({
            orgId: environment.orgId,
            actor: actorOf(actor),
            action: 'secret.reveal',
            environmentId,
            environmentName: environment.name,
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

        createPasteLink: Effect.fn('Secrets.createPasteLink')(function* ({ actor, paste }) {
          const { environment } = yield* access.needing(
            yield* access.environment(actor, paste.environmentId),
            'write',
          );
          const now = yield* Clock.currentTimeMillis;
          const took = sql`EXISTS (SELECT 1 FROM paste_link
                            WHERE id = ${paste.id} AND created_at = ${now}
                              AND token_hash = ${paste.tokenHash})`;
          const [inserted] = yield* sql
            .batch([
              sql`INSERT OR IGNORE INTO paste_link
                    (id, environment_id, name, reason, hint, token_hash, status, created_by,
                     created_at, link_expires_at)
                  VALUES (${paste.id}, ${paste.environmentId}, ${paste.name},
                    ${paste.reason}, ${paste.hint}, ${paste.tokenHash}, 'pending',
                    ${encodeActor(actorOf(actor))}, ${now}, ${now + PASTE_LINK_LIFETIME_MS})
                  RETURNING id`,
              // A new link replaces the earlier one for the same name: the owner sees one.
              sql`UPDATE paste_link SET status = 'cancelled', resolved_at = ${now}
                  WHERE environment_id = ${paste.environmentId} AND name = ${paste.name}
                    AND status = 'pending' AND id != ${paste.id} AND ${took}`,
              yield* audit.entry(
                {
                  orgId: environment.orgId,
                  actor: actorOf(actor),
                  action: 'paste-link.create',
                  environmentId: paste.environmentId,
                  environmentName: environment.name,
                  secretName: paste.name,
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
          if (row.status !== 'pending') {
            return yield* new LinkSpentError({
              message: `This paste link was already ${row.status}.`,
            });
          }
          const now = yield* Clock.currentTimeMillis;
          yield* sql
            .batch([
              sql`UPDATE paste_link SET status = 'cancelled', resolved_at = ${now}
                  WHERE id = ${id} AND status = 'pending'`,
              yield* audit.entry({
                orgId: row.orgId,
                actor: actorOf(actor),
                action: 'paste-link.cancel',
                environmentId: row.environmentId,
                environmentName: row.environmentName,
                secretName: row.name,
              }),
            ])
            .pipe(Effect.orDie);
          return toPasteLink({ ...row, status: 'cancelled' });
        }),

        pasteTarget: Effect.fn('Secrets.pasteTarget')(function* ({ caller, id }) {
          const { row } = yield* answerable(caller, id);
          return {
            link: toPasteLink(row),
            environmentPublicKey: row.environmentPublicKey,
            keyVersion: row.keyVersion,
            nextVersion: (row.latestVersion ?? 0) + 1,
          };
        }),

        fulfilPaste: Effect.fn('Secrets.fulfilPaste')(function* ({ caller, id, write }) {
          const { row, by } = yield* answerable(caller, id);
          const slot = { environmentId: row.environmentId, name: row.name };
          yield* underLimit({ ...slot, version: write.version });
          const now = yield* Clock.currentTimeMillis;
          // One batch: the value is written only while the link is still pending, and the link is
          // spent only if the value was written, so a link answers once.
          const { statements, took } = yield* writeStatements(
            { ...slot, ...write },
            {
              orgId: row.orgId,
              actor: by,
              environmentName: row.environmentName,
              action: 'paste-link.fulfil',
              alsoIf: sql`EXISTS (SELECT 1 FROM paste_link
                                  WHERE id = ${id} AND status = 'pending')`,
            },
          );
          const [moved] = yield* sql
            .batch([
              ...statements,
              sql`UPDATE paste_link SET status = 'fulfilled', resolved_at = ${now}
                  WHERE id = ${id} AND status = 'pending' AND ${took}`,
              // The value is in: any other link for the same name has nothing left to ask.
              sql`UPDATE paste_link SET status = 'cancelled', resolved_at = ${now}
                  WHERE environment_id = ${slot.environmentId} AND name = ${slot.name}
                    AND status = 'pending' AND ${took}`,
            ])
            .pipe(Effect.orDie);
          if ((moved ?? []).length === 0) {
            const after = yield* pasteRow(id, null).pipe(Effect.orDie);
            if (after.status !== 'pending') {
              return yield* new LinkSpentError({
                message: `This paste link was already ${after.status}.`,
              });
            }
            return yield* yield* conflict(slot);
          }
          return yield* secret(slot).pipe(Effect.orDie);
        }),
      });
    }),
  );
}
