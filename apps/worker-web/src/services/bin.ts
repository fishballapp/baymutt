// The bin: what was deleted, until it is removed for good. A deleted secret is a `secret` row with
// no current version, a deleted environment a `environment` row with `archived_at`; each is removed for good
// at its `purge_at`, by the daily sweep, or earlier by the owner. Removing one for good is the only
// thing in the store that cannot be undone, so nothing a service account can call reaches it.
//
// A row deleted by a Worker from before the bin has no `purge_at`: it reads as its deleted time
// plus the bin's 30 days.
import {
  type Actor,
  type ActorIdentity,
  BIN_DAYS,
  type BinEnvironment,
  type BinSecret,
  NotFoundError,
  OwnerRequiredError,
} from '@baymutt/api';
import * as D1Client from '@effect/sql-d1/D1Client';
import { eachIsolated } from '@internal/effect-worker';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import type * as Statement from 'effect/sql/Statement';
import { isLogin } from './access/rows.ts';
import { Access } from './access.ts';
import { ActorJsonSchema, actorOf } from './actors.ts';
import { Audit } from './audit.ts';

/** How long something deleted stays in the bin. */
export const BIN_MS = BIN_DAYS * 24 * 3600 * 1000;

/** Who removes for good what has been in the bin for its 30 days. */
const SWEEP_ACTOR: Actor = { kind: 'system', id: 'bin', name: 'baymutt' };

const SWEEP_DETAIL = `after ${BIN_DAYS} days in the bin`;

const ownerOnly = (actor: ActorIdentity) =>
  actor._tag === 'Owner'
    ? Effect.void
    : Effect.fail(
        new OwnerRequiredError({
          message:
            'Only the owner removes something for good, from the Bin in the dashboard. What is in the bin is removed for good 30 days after it was deleted.',
        }),
      );

export class Bin extends Context.Service<
  Bin,
  {
    /** Newest first. The owner and a login see the account's; a scoped service account, its environments'. */
    readonly list: (actor: ActorIdentity) => Effect.Effect<{
      readonly environments: ReadonlyArray<BinEnvironment>;
      readonly secrets: ReadonlyArray<BinSecret>;
    }>;
    /** The owner's: a deleted environment, its secrets, versions, grants and requests, for good. */
    readonly purgeEnvironment: (request: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) => Effect.Effect<void, NotFoundError | OwnerRequiredError>;
    /** The owner's: a deleted secret and every version of it, for good. */
    readonly purgeSecret: (request: {
      readonly actor: ActorIdentity;
      readonly environmentId: string;
      readonly name: string;
    }) => Effect.Effect<void, NotFoundError | OwnerRequiredError>;
    /** Removes for good everything whose time in the bin is up. Run daily by the Cron Trigger. */
    readonly sweep: Effect.Effect<{ readonly environments: number; readonly secrets: number }>;
  }
>()('@baymutt/worker-web/services/Bin') {
  static readonly layer = Layer.effect(
    Bin,
    Effect.gen(function* () {
      const sql = yield* D1Client.D1Client;
      const access = yield* Access;
      const audit = yield* Audit;

      const environmentPurgeAt = sql`COALESCE(p.purge_at, p.archived_at + ${BIN_MS})`;
      const secretPurgeAt = sql`COALESCE(s.purge_at, s.updated_at + ${BIN_MS})`;

      const binnedEnvironments = SqlSchema.findAll({
        Request: Schema.Struct({
          accountId: Schema.NullOr(Schema.String),
          grantee: Schema.NullOr(Schema.String),
          id: Schema.NullOr(Schema.String),
          dueBy: Schema.NullOr(Schema.Finite),
        }),
        Result: Schema.Struct({
          id: Schema.String,
          accountId: Schema.String,
          name: Schema.String,
          deletedAt: Schema.Finite,
          purgeAt: Schema.Finite,
        }),
        execute: ({ accountId, grantee, id, dueBy }) =>
          sql`SELECT p.id, p.account_id, p.name, p.archived_at AS deleted_at,
                ${environmentPurgeAt} AS purge_at
              FROM project p
              WHERE p.archived_at IS NOT NULL
                AND (${accountId} IS NULL OR p.account_id = ${accountId})
                AND (${id} IS NULL OR p.id = ${id})
                AND (${dueBy} IS NULL OR ${environmentPurgeAt} <= ${dueBy})
                AND (${grantee} IS NULL OR EXISTS (SELECT 1 FROM project_grant g
                      WHERE g.project_id = p.id AND g.credential_id = ${grantee}))
              ORDER BY p.archived_at DESC`,
      });

      const binnedSecrets = SqlSchema.findAll({
        Request: Schema.Struct({
          accountId: Schema.NullOr(Schema.String),
          grantee: Schema.NullOr(Schema.String),
          slot: Schema.NullOr(Schema.Struct({ environmentId: Schema.String, name: Schema.String })),
          dueBy: Schema.NullOr(Schema.Finite),
        }),
        Result: Schema.Struct({
          environmentId: Schema.String,
          accountId: Schema.String,
          environmentName: Schema.String,
          name: Schema.String,
          latestVersion: Schema.Finite,
          deletedAt: Schema.Finite,
          deletedBy: ActorJsonSchema,
          purgeAt: Schema.Finite,
        }),
        // The list shows deleted secrets of live environments; a deleted environment's go with it. The
        // sweep (`dueBy`) takes every one that is due, its environment deleted or not.
        execute: ({ accountId, grantee, slot, dueBy }) =>
          sql`SELECT s.project_id AS environment_id, s.account_id, p.name AS environment_name, s.name, s.latest_version,
                s.updated_at AS deleted_at, s.updated_by AS deleted_by,
                ${secretPurgeAt} AS purge_at
              FROM secret s JOIN project p ON p.id = s.project_id
              WHERE s.current_version IS NULL
                AND (${dueBy} IS NOT NULL OR p.archived_at IS NULL)
                AND (${accountId} IS NULL OR s.account_id = ${accountId})
                AND (${slot?.environmentId ?? null} IS NULL
                     OR (s.project_id = ${slot?.environmentId ?? null} AND s.name = ${slot?.name ?? null}))
                AND (${dueBy} IS NULL OR ${secretPurgeAt} <= ${dueBy})
                AND (${grantee} IS NULL OR EXISTS (SELECT 1 FROM project_grant g
                      WHERE g.project_id = s.project_id AND g.credential_id = ${grantee}))
              ORDER BY s.updated_at DESC`,
      });

      /**
       * Everything of an environment, for good, and the log entry first: all only while `stillBinned`
       * holds, so a restore that lands first keeps it whole.
       */
      const environmentGone = (id: string, stillBinned: Statement.Fragment) => [
        sql`DELETE FROM secret_version WHERE project_id = ${id} AND ${stillBinned}`,
        sql`DELETE FROM secret WHERE project_id = ${id} AND ${stillBinned}`,
        sql`DELETE FROM project_grant WHERE project_id = ${id} AND ${stillBinned}`,
        sql`DELETE FROM paste_request WHERE project_id = ${id} AND ${stillBinned}`,
        sql`DELETE FROM access_request WHERE project_id = ${id} AND ${stillBinned}`,
        sql`DELETE FROM project WHERE id = ${id} AND ${stillBinned}`,
      ];

      const secretGone = (environmentId: string, name: string, stillBinned: Statement.Fragment) => [
        sql`DELETE FROM secret_version
            WHERE project_id = ${environmentId} AND name = ${name} AND ${stillBinned}`,
        sql`DELETE FROM secret WHERE project_id = ${environmentId} AND name = ${name} AND ${stillBinned}`,
      ];

      const purgeEnvironmentNow = Effect.fnUntraced(function* (
        environment: { readonly id: string; readonly accountId: string; readonly name: string },
        { actor, dueBy }: { readonly actor: Actor; readonly dueBy: number | null },
      ) {
        const stillBinned = sql`EXISTS (SELECT 1 FROM project p
          WHERE p.id = ${environment.id} AND p.archived_at IS NOT NULL
            AND (${dueBy} IS NULL OR ${environmentPurgeAt} <= ${dueBy}))`;
        yield* sql
          .batch([
            yield* audit.entry(
              {
                accountId: environment.accountId,
                actor,
                action: 'environment.purge',
                environmentId: environment.id,
                environmentName: environment.name,
                detail: dueBy === null ? null : SWEEP_DETAIL,
              },
              stillBinned,
            ),
            ...environmentGone(environment.id, stillBinned),
          ])
          .pipe(Effect.orDie);
      });

      const purgeSecretNow = Effect.fnUntraced(function* (
        secret: {
          readonly environmentId: string;
          readonly accountId: string;
          readonly environmentName: string;
          readonly name: string;
        },
        { actor, dueBy }: { readonly actor: Actor; readonly dueBy: number | null },
      ) {
        const stillBinned = sql`EXISTS (SELECT 1 FROM secret s
          WHERE s.project_id = ${secret.environmentId} AND s.name = ${secret.name}
            AND s.current_version IS NULL
            AND (${dueBy} IS NULL OR ${secretPurgeAt} <= ${dueBy}))`;
        yield* sql
          .batch([
            yield* audit.entry(
              {
                accountId: secret.accountId,
                actor,
                action: 'secret.purge',
                environmentId: secret.environmentId,
                environmentName: secret.environmentName,
                secretName: secret.name,
                detail: dueBy === null ? null : SWEEP_DETAIL,
              },
              stillBinned,
            ),
            ...secretGone(secret.environmentId, secret.name, stillBinned),
          ])
          .pipe(Effect.orDie);
      });

      return Bin.of({
        list: Effect.fn('Bin.list')(function* (actor) {
          const query = {
            accountId: actor.accountId,
            grantee: actor._tag === 'Owner' || isLogin(actor) ? null : actor.credentialId,
            dueBy: null,
          };
          const [environments, secrets] = yield* Effect.all(
            [binnedEnvironments({ ...query, id: null }), binnedSecrets({ ...query, slot: null })],
            { concurrency: 2 },
          ).pipe(Effect.orDie);
          return {
            environments: environments.map(({ accountId: _, ...environment }) => environment),
            secrets: secrets.map(({ accountId: _, ...secret }) => secret),
          };
        }),

        purgeEnvironment: Effect.fn('Bin.purgeEnvironment')(function* ({ actor, id }) {
          yield* ownerOnly(actor);
          const [environment] = yield* binnedEnvironments({
            accountId: actor.accountId,
            grantee: null,
            id,
            dueBy: null,
          }).pipe(Effect.orDie);
          if (environment === undefined) {
            return yield* new NotFoundError({
              message:
                'No environment in the bin has this id. Delete an environment before removing it for good.',
            });
          }
          yield* purgeEnvironmentNow(environment, { actor: actorOf(actor), dueBy: null });
        }),

        purgeSecret: Effect.fn('Bin.purgeSecret')(function* ({ actor, environmentId, name }) {
          yield* ownerOnly(actor);
          // A live environment's: one in the bin is removed for good whole.
          yield* access.ownersEnvironment(actor, environmentId);
          const [secret] = yield* binnedSecrets({
            accountId: actor.accountId,
            grantee: null,
            slot: { environmentId, name },
            dueBy: null,
          }).pipe(Effect.orDie);
          if (secret === undefined) {
            return yield* new NotFoundError({
              message: `${name} is not in the bin. Delete it before removing it for good.`,
            });
          }
          yield* purgeSecretNow(secret, { actor: actorOf(actor), dueBy: null });
        }),

        sweep: Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const due = { accountId: null, grantee: null, dueBy: now };
          // Environments first: their secrets go with them, so the secrets left are other environments'.
          const environments = yield* binnedEnvironments({ ...due, id: null }).pipe(Effect.orDie);
          yield* eachIsolated({
            sweep: 'bin environment',
            rows: environments,
            run: environment =>
              purgeEnvironmentNow(environment, { actor: SWEEP_ACTOR, dueBy: now }),
          });
          const secrets = yield* binnedSecrets({ ...due, slot: null }).pipe(Effect.orDie);
          // One that fails is logged and left for tomorrow, so it never holds up the rest.
          yield* eachIsolated({
            sweep: 'bin secret',
            rows: secrets.map(secret => ({
              ...secret,
              id: `${secret.environmentId}/${secret.name}`,
            })),
            run: secret => purgeSecretNow(secret, { actor: SWEEP_ACTOR, dueBy: now }),
          });
          yield* Effect.logInfo('bin swept', {
            environments: environments.length,
            secrets: secrets.length,
          });
          return { environments: environments.length, secrets: secrets.length };
        }).pipe(Effect.withSpan('Bin.sweep')),
      });
    }),
  );
}
