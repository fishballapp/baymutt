// Owns `secret`, `secret_version` and `paste_request`: a project's values as ciphertext. A write
// adds a version and never changes one, a delete only clears the pointer to the current version,
// and none of it can be read here.
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
  type PasteRequest,
  type PasteTarget,
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
import { Access } from './access.ts';
import { ActorJsonSchema, actorOf, encodeActor, LINK_ACTOR } from './actors.ts';
import { Audit } from './audit.ts';

const SecretRowSchema = Schema.Struct({
  name: Schema.String,
  currentVersion: Schema.NullOr(Schema.Finite),
  latestVersion: Schema.Finite,
  size: Schema.NullOr(Schema.Finite),
  updatedAt: Schema.Finite,
  updatedBy: ActorJsonSchema,
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
  accountId: Schema.String,
  projectId: Schema.String,
  projectName: Schema.String,
  projectPublicKey: Schema.String,
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

/** How long a paste link works. The request stays answerable from the dashboard after it. */
const PASTE_LINK_LIFETIME_MS = 15 * 60_000;

type Slot = { readonly projectId: string; readonly name: string };
type Write = Slot & {
  readonly version: number;
  readonly keyVersion: number;
  readonly ciphertext: string;
};

type Caller = { readonly actor: ActorIdentity | null; readonly token: string | undefined };

const toPasteRequest = (row: PasteRow): PasteRequest => ({
  id: row.id,
  projectId: row.projectId,
  projectName: row.projectName,
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
      readonly projectId: string;
    }) => Effect.Effect<ReadonlyArray<Secret>, NotFoundError>;
    /** Every current value's ciphertext and the caller's wrap of the project key. Logged. */
    readonly bundle: (request: {
      readonly actor: ActorIdentity;
      readonly projectId: string;
    }) => Effect.Effect<Bundle, NotFoundError | NoAccessError>;
    /** Adds `version`, which must be one above the latest, and makes it current. */
    readonly write: (request: {
      readonly actor: ActorIdentity;
      readonly write: Write;
    }) => Effect.Effect<
      Secret,
      NotFoundError | NoAccessError | VersionConflictError | LimitReachedError
    >;
    /** Soft: clears the current version and keeps every version. */
    readonly remove: (
      request: { readonly actor: ActorIdentity } & Slot,
    ) => Effect.Effect<Secret, NotFoundError | NoAccessError>;
    readonly rollback: (
      request: { readonly actor: ActorIdentity; readonly version: number } & Slot,
    ) => Effect.Effect<Secret, NotFoundError | NoAccessError>;
    readonly versions: (
      request: { readonly actor: ActorIdentity } & Slot,
    ) => Effect.Effect<ReadonlyArray<SecretVersion>, NotFoundError>;

    readonly listPasteRequests: (
      actor: ActorIdentity,
    ) => Effect.Effect<ReadonlyArray<PasteRequest>>;
    readonly requestPaste: (request: {
      readonly actor: ActorIdentity;
      readonly paste: Slot & {
        readonly id: string;
        readonly reason: string;
        readonly hint: string;
        readonly tokenHash: string;
      };
    }) => Effect.Effect<PasteRequest, NotFoundError | NoAccessError | AlreadyExistsError>;
    readonly cancelPaste: (request: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) => Effect.Effect<PasteRequest, NotFoundError | LinkSpentError>;
    /** For the link's token while it lasts, or for the owner. */
    readonly pasteTarget: (request: {
      readonly caller: Caller;
      readonly id: string;
    }) => Effect.Effect<PasteTarget, NotFoundError | LinkSpentError | UnauthorizedError>;
    /** Writes the pasted value and spends the request, together. */
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
        Request: Schema.Struct({ projectId: Schema.String, name: Schema.NullOr(Schema.String) }),
        Result: SecretRowSchema,
        execute: ({ projectId, name }) =>
          sql`SELECT s.name, s.current_version, s.latest_version, s.updated_at, s.updated_by,
                (SELECT length(v.ciphertext) * 3 / 4 FROM secret_version v
                  WHERE v.project_id = s.project_id AND v.name = s.name
                    AND v.version = s.current_version) AS size
              FROM secret s
              WHERE s.project_id = ${projectId} AND (${name} IS NULL OR s.name = ${name})
              ORDER BY s.name`,
      });

      const versionRows = SqlSchema.findAll({
        Request: Schema.Struct({ projectId: Schema.String, name: Schema.String }),
        Result: VersionRowSchema,
        execute: ({ projectId, name }) =>
          sql`SELECT v.version, v.key_version, length(v.ciphertext) * 3 / 4 AS size, v.created_at,
                v.created_by, v.version IS s.current_version AS is_current
              FROM secret_version v
              JOIN secret s ON s.project_id = v.project_id AND s.name = v.name
              WHERE v.project_id = ${projectId} AND v.name = ${name}
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
        execute: projectId =>
          sql`SELECT v.name, v.version, v.key_version, v.ciphertext
              FROM secret s
              JOIN secret_version v
                ON v.project_id = s.project_id AND v.name = s.name AND v.version = s.current_version
              WHERE s.project_id = ${projectId} ORDER BY v.name`,
      });

      const pasteRows = SqlSchema.findAll({
        Request: Schema.Struct({
          accountId: Schema.NullOr(Schema.String),
          createdBy: Schema.NullOr(Schema.String),
          id: Schema.NullOr(Schema.String),
        }),
        Result: PasteRowSchema,
        execute: ({ accountId, createdBy, id }) =>
          sql`SELECT r.id, r.account_id, r.project_id, p.name AS project_name,
                p.public_key AS project_public_key, p.key_version, r.name, r.reason, r.hint,
                r.token_hash, r.status, r.created_by, r.created_at, r.link_expires_at,
                (SELECT s.latest_version FROM secret s
                  WHERE s.project_id = r.project_id AND s.name = r.name) AS latest_version
              FROM paste_request r JOIN project p ON p.id = r.project_id
              WHERE p.archived_at IS NULL
                AND (${accountId} IS NULL OR r.account_id = ${accountId})
                AND (${id} IS NOT NULL OR r.status = 'pending')
                AND (${id} IS NULL OR r.id = ${id})
                AND (${createdBy} IS NULL OR json_extract(r.created_by, '$.id') = ${createdBy})
              ORDER BY r.created_at DESC LIMIT 200`,
      });

      const secret = Effect.fnUntraced(function* ({ projectId, name }: Slot) {
        const [row] = yield* secretRows({ projectId, name }).pipe(Effect.orDie);
        if (row === undefined) {
          return yield* new NotFoundError({
            message: `This project has no secret named ${name}. List them with \`baymutt secrets <project>\`.`,
          });
        }
        return row satisfies Secret;
      });

      /**
       * The three statements of a write: the secret's row moves to `version` only from the one
       * below it and only under the project's current key, the version row is added only if that
       * took, and so is the log entry. `alsoIf` is one more condition on the first.
       */
      const writeStatements = Effect.fnUntraced(function* (
        { projectId, name, version, keyVersion, ciphertext }: Write,
        {
          accountId,
          actor,
          projectName,
          action,
          alsoIf,
        }: {
          readonly accountId: string;
          readonly actor: Actor;
          readonly projectName: string;
          readonly action: 'secret.write' | 'paste.fulfil';
          readonly alsoIf?: Statement.Fragment;
        },
      ) {
        const now = yield* Clock.currentTimeMillis;
        const by = encodeActor(actor);
        const writeId = crypto.randomUUID();
        const took = sql`EXISTS (SELECT 1 FROM secret
          WHERE project_id = ${projectId} AND name = ${name} AND write_id = ${writeId})`;
        const statements = [
          sql`INSERT INTO secret
                (project_id, name, account_id, current_version, latest_version, updated_at,
                 updated_by, write_id)
              SELECT ${projectId}, ${name}, ${accountId}, ${version}, ${version}, ${now}, ${by},
                ${writeId}
              WHERE EXISTS (SELECT 1 FROM project
                            WHERE id = ${projectId} AND key_version = ${keyVersion}
                              AND archived_at IS NULL)
                AND (${version} = 1 OR EXISTS (SELECT 1 FROM secret
                                              WHERE project_id = ${projectId} AND name = ${name}))
                AND ${alsoIf ?? sql`1 = 1`}
              ON CONFLICT (project_id, name) DO UPDATE
                SET current_version = excluded.current_version,
                    latest_version = excluded.latest_version,
                    updated_at = excluded.updated_at, updated_by = excluded.updated_by,
                    write_id = excluded.write_id
                WHERE secret.latest_version = excluded.latest_version - 1
              RETURNING latest_version`,
          sql`INSERT INTO secret_version
                (project_id, name, version, account_id, key_version, ciphertext, created_by,
                 created_at)
              SELECT ${projectId}, ${name}, ${version}, ${accountId}, ${keyVersion}, ${ciphertext},
                ${by}, ${now}
              WHERE ${took}`,
          yield* audit.entry(
            { accountId, actor, action, projectId, projectName, secretName: name, version },
            took,
          ),
        ] as const;
        return { statements, took };
      });

      /** Counted before the write: a cap on growth, which two writers at once can overshoot by one. */
      const underLimit = Effect.fnUntraced(function* ({
        projectId,
        version,
      }: Pick<Write, 'projectId' | 'version'>) {
        if (version > LIMITS.versionsPerSecret) {
          return yield* new LimitReachedError({
            limit: LIMITS.versionsPerSecret,
            message: `A secret keeps up to ${LIMITS.versionsPerSecret} versions while baymutt is in beta.`,
          });
        }
        if (version !== 1) return;
        const [row] = yield* sql`SELECT COUNT(*) AS held FROM secret
          WHERE project_id = ${projectId}`.pipe(Effect.orDie);
        if (Number(row?.held ?? 0) >= LIMITS.secretsPerProject) {
          return yield* new LimitReachedError({
            limit: LIMITS.secretsPerProject,
            message: `A project holds up to ${LIMITS.secretsPerProject} secrets while baymutt is in beta. Split it into two projects.`,
          });
        }
      });

      const conflict = Effect.fnUntraced(function* ({ projectId, name }: Slot) {
        const [found] = yield* sql`SELECT
            (SELECT latest_version FROM secret WHERE project_id = ${projectId} AND name = ${name})
              AS latest_version,
            (SELECT key_version FROM project WHERE id = ${projectId}) AS key_version`.pipe(
          Effect.orDie,
        );
        const latestVersion = Number(found?.latestVersion ?? 0);
        const keyVersion = Number(found?.keyVersion ?? 0);
        return new VersionConflictError({
          latestVersion,
          keyVersion,
          message: `${name} is at version ${latestVersion} under project key ${keyVersion}. Seal the value again for version ${latestVersion + 1} and that key, then write it.`,
        });
      });

      /** Moves the current-version pointer and logs it, when the secret exists. */
      const point = Effect.fnUntraced(function* (
        { actor, projectId, name }: { readonly actor: ActorIdentity } & Slot,
        {
          to,
          action,
        }: { readonly to: number | null; readonly action: 'secret.delete' | 'secret.rollback' },
      ) {
        const { project } = yield* access.needing(yield* access.project(actor, projectId), 'write');
        const now = yield* Clock.currentTimeMillis;
        const by = encodeActor(actorOf(actor));
        const writeId = crypto.randomUUID();
        const [moved] = yield* sql
          .batch([
            sql`UPDATE secret
                SET current_version = ${to}, updated_at = ${now}, updated_by = ${by},
                    write_id = ${writeId}
                WHERE project_id = ${projectId} AND name = ${name}
                  AND (${to} IS NULL OR EXISTS (SELECT 1 FROM secret_version
                                               WHERE project_id = ${projectId} AND name = ${name}
                                                 AND version = ${to}))
                RETURNING name`,
            yield* audit.entry(
              {
                accountId: actor.accountId,
                actor: actorOf(actor),
                action,
                projectId,
                projectName: project.name,
                secretName: name,
                version: to,
              },
              sql`EXISTS (SELECT 1 FROM secret WHERE project_id = ${projectId} AND name = ${name}
                           AND write_id = ${writeId})`,
            ),
          ])
          .pipe(Effect.orDie);
        if ((moved ?? []).length === 0) {
          return yield* new NotFoundError({
            message:
              to === null
                ? `This project has no secret named ${name}.`
                : `${name} has no version ${to}. See its history with \`baymutt secrets history\`.`,
          });
        }
        return yield* secret({ projectId, name }).pipe(Effect.orDie);
      });

      const pasteRow = Effect.fnUntraced(function* (id: string, accountId: string | null) {
        const [row] = yield* pasteRows({ accountId, createdBy: null, id }).pipe(Effect.orDie);
        if (row === undefined) {
          return yield* new NotFoundError({ message: 'No paste request has this id.' });
        }
        return row;
      });

      /** The pending request a paste page may answer: the owner's any time, a token's until it expires. */
      const answerable = Effect.fnUntraced(function* ({ actor, token }: Caller, id: string) {
        // Whoever holds the link may be signed in to an account of their own: only this
        // request's owner skips the token.
        const row = yield* pasteRow(id, null);
        if (row.status !== 'pending') {
          return yield* new LinkSpentError({
            message: `This paste request was already ${row.status}.`,
          });
        }
        if (actor?._tag === 'Owner' && actor.accountId === row.accountId) {
          return { row, by: actorOf(actor) };
        }
        if (
          token === undefined ||
          (yield* Effect.promise(() => tokenHash(token))) !== row.tokenHash
        ) {
          return yield* new UnauthorizedError({
            message: 'Open the paste link itself, or sign in to the dashboard as the owner.',
          });
        }
        if ((yield* Clock.currentTimeMillis) >= row.linkExpiresAt) {
          return yield* new LinkSpentError({
            message:
              'This link has expired. The request is still in the dashboard, under Requests.',
          });
        }
        return { row, by: LINK_ACTOR };
      });

      return Secrets.of({
        list: Effect.fn('Secrets.list')(function* ({ actor, projectId }) {
          yield* access.project(actor, projectId);
          return yield* secretRows({ projectId, name: null }).pipe(Effect.orDie);
        }),

        bundle: Effect.fn('Secrets.bundle')(function* ({ actor, projectId }) {
          const { project, wrap, readerId } = yield* access.needing(
            yield* access.project(actor, projectId),
            'read',
          );
          // Values leave through an approved service account, never a browser session: the dashboard seals
          // and never opens.
          if (actor._tag !== 'ServiceAccount') {
            return yield* new NoAccessError({
              message: 'Only an approved service account loads a project’s values.',
              need: 'read',
            });
          }
          if (wrap === null) return yield* Effect.die(`a read grant on ${projectId} has no wrap`);
          const secrets = yield* currentCiphertexts(projectId).pipe(Effect.orDie);
          yield* (yield* audit.entry({
            accountId: actor.accountId,
            actor: actorOf(actor),
            action: 'project.load',
            projectId,
            projectName: project.name,
          })).pipe(Effect.orDie);
          return {
            project: {
              id: project.id,
              accountId: project.accountId,
              name: project.name,
              publicKey: project.publicKey,
              keyVersion: project.keyVersion,
            },
            wrap,
            readerId,
            secrets,
          };
        }),

        write: Effect.fn('Secrets.write')(function* ({ actor, write }) {
          const { project } = yield* access.needing(
            yield* access.project(actor, write.projectId),
            'write',
          );
          yield* underLimit(write);
          const { statements } = yield* writeStatements(write, {
            accountId: actor.accountId,
            actor: actorOf(actor),
            projectName: project.name,
            action: 'secret.write',
          });
          const [moved] = yield* sql.batch(statements).pipe(Effect.orDie);
          if ((moved ?? []).length === 0) return yield* yield* conflict(write);
          return yield* secret(write).pipe(Effect.orDie);
        }),

        remove: Effect.fn('Secrets.remove')(function* (request) {
          return yield* point(request, { to: null, action: 'secret.delete' });
        }),

        rollback: Effect.fn('Secrets.rollback')(function* ({ version, ...request }) {
          return yield* point(request, { to: version, action: 'secret.rollback' });
        }),

        versions: Effect.fn('Secrets.versions')(function* ({ actor, projectId, name }) {
          yield* access.project(actor, projectId);
          const rows = yield* versionRows({ projectId, name }).pipe(Effect.orDie);
          if (rows.length === 0) {
            return yield* new NotFoundError({
              message: `This project has no secret named ${name}.`,
            });
          }
          return rows.map(({ isCurrent, ...row }) => ({ ...row, isCurrent: isCurrent !== 0 }));
        }),

        listPasteRequests: Effect.fn('Secrets.listPasteRequests')(function* (actor) {
          const rows = yield* pasteRows({
            accountId: actor.accountId,
            createdBy: actor._tag === 'ServiceAccount' ? actor.credentialId : null,
            id: null,
          }).pipe(Effect.orDie);
          return rows.map(toPasteRequest);
        }),

        requestPaste: Effect.fn('Secrets.requestPaste')(function* ({ actor, paste }) {
          const { project } = yield* access.needing(
            yield* access.project(actor, paste.projectId),
            'write',
          );
          const now = yield* Clock.currentTimeMillis;
          const took = sql`EXISTS (SELECT 1 FROM paste_request
                            WHERE id = ${paste.id} AND created_at = ${now}
                              AND token_hash = ${paste.tokenHash})`;
          const [inserted] = yield* sql
            .batch([
              sql`INSERT OR IGNORE INTO paste_request
                    (id, account_id, project_id, name, reason, hint, token_hash, status,
                     created_by, created_at, link_expires_at)
                  VALUES (${paste.id}, ${actor.accountId}, ${paste.projectId}, ${paste.name},
                    ${paste.reason}, ${paste.hint}, ${paste.tokenHash}, 'pending',
                    ${encodeActor(actorOf(actor))}, ${now}, ${now + PASTE_LINK_LIFETIME_MS})
                  RETURNING id`,
              // Asking again replaces the earlier request for the same name: the owner sees one.
              sql`UPDATE paste_request SET status = 'cancelled', resolved_at = ${now}
                  WHERE project_id = ${paste.projectId} AND name = ${paste.name}
                    AND status = 'pending' AND id != ${paste.id} AND ${took}`,
              yield* audit.entry(
                {
                  accountId: actor.accountId,
                  actor: actorOf(actor),
                  action: 'paste.request',
                  projectId: paste.projectId,
                  projectName: project.name,
                  secretName: paste.name,
                  detail: paste.reason,
                },
                took,
              ),
            ])
            .pipe(Effect.orDie);
          if ((inserted ?? []).length === 0) {
            return yield* new AlreadyExistsError({
              message: 'A paste request with this id exists.',
            });
          }
          return toPasteRequest(yield* pasteRow(paste.id, actor.accountId).pipe(Effect.orDie));
        }),

        cancelPaste: Effect.fn('Secrets.cancelPaste')(function* ({ actor, id }) {
          const row = yield* pasteRow(id, actor.accountId);
          // A service account cancels what it asked for; a request it did not make is not its to see.
          if (actor._tag === 'ServiceAccount' && row.createdBy.id !== actor.credentialId) {
            return yield* new NotFoundError({ message: 'No paste request has this id.' });
          }
          if (row.status !== 'pending') {
            return yield* new LinkSpentError({
              message: `This paste request was already ${row.status}.`,
            });
          }
          const now = yield* Clock.currentTimeMillis;
          yield* sql
            .batch([
              sql`UPDATE paste_request SET status = 'cancelled', resolved_at = ${now}
                  WHERE id = ${id} AND status = 'pending'`,
              yield* audit.entry({
                accountId: actor.accountId,
                actor: actorOf(actor),
                action: 'paste.cancel',
                projectId: row.projectId,
                projectName: row.projectName,
                secretName: row.name,
              }),
            ])
            .pipe(Effect.orDie);
          return toPasteRequest({ ...row, status: 'cancelled' });
        }),

        pasteTarget: Effect.fn('Secrets.pasteTarget')(function* ({ caller, id }) {
          const { row } = yield* answerable(caller, id);
          return {
            request: toPasteRequest(row),
            accountId: row.accountId,
            projectPublicKey: row.projectPublicKey,
            keyVersion: row.keyVersion,
            nextVersion: (row.latestVersion ?? 0) + 1,
          };
        }),

        fulfilPaste: Effect.fn('Secrets.fulfilPaste')(function* ({ caller, id, write }) {
          const { row, by } = yield* answerable(caller, id);
          const slot = { projectId: row.projectId, name: row.name };
          yield* underLimit({ ...slot, version: write.version });
          const now = yield* Clock.currentTimeMillis;
          // One batch: the value is written only while the request is still pending, and the
          // request is spent only if the value was written, so a link answers once.
          const { statements, took } = yield* writeStatements(
            { ...slot, ...write },
            {
              accountId: row.accountId,
              actor: by,
              projectName: row.projectName,
              action: 'paste.fulfil',
              alsoIf: sql`EXISTS (SELECT 1 FROM paste_request
                                  WHERE id = ${id} AND status = 'pending')`,
            },
          );
          const [moved] = yield* sql
            .batch([
              ...statements,
              sql`UPDATE paste_request SET status = 'fulfilled', resolved_at = ${now}
                  WHERE id = ${id} AND status = 'pending' AND ${took}`,
              // The value is in: any other request for the same name has nothing left to ask.
              sql`UPDATE paste_request SET status = 'cancelled', resolved_at = ${now}
                  WHERE project_id = ${slot.projectId} AND name = ${slot.name}
                    AND status = 'pending' AND ${took}`,
            ])
            .pipe(Effect.orDie);
          if ((moved ?? []).length === 0) {
            const after = yield* pasteRow(id, null).pipe(Effect.orDie);
            if (after.status !== 'pending') {
              return yield* new LinkSpentError({
                message: `This paste request was already ${after.status}.`,
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
