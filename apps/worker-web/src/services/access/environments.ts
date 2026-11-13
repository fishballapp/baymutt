// Environments and the grants on them.
import {
  type ActorIdentity,
  AlreadyExistsError,
  type Grant,
  NotFoundError,
  OwnerRequiredError,
} from '@baymutt/api';
import type * as D1Client from '@effect/sql-d1/D1Client';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import { actorOf, encodeActor } from '../actors.ts';
import type { Audit } from '../audit.ts';
import { BIN_MS } from '../bin.ts';
import type { Lookups } from './rows.ts';

const GrantRowSchema = Schema.Struct({
  credentialId: Schema.String,
  credentialName: Schema.String,
  credentialPublicKey: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  endorsement: Schema.NullOr(Schema.String),
  canRead: Schema.Finite,
  canWrite: Schema.Finite,
  createdAt: Schema.Finite,
});

const ownerOnly = (actor: ActorIdentity, what: string) =>
  actor._tag === 'Owner'
    ? Effect.void
    : Effect.fail(
        new OwnerRequiredError({ message: `Only the owner ${what}, from the dashboard.` }),
      );

export const environments = ({
  sql,
  audit,
  lookups: { environmentsOf, environmentFor, ownersEnvironment, serviceAccountIn, underLimit },
}: {
  readonly sql: D1Client.D1Client;
  readonly audit: Audit['Service'];
  readonly lookups: Lookups;
}) => {
  const grantRows = SqlSchema.findAll({
    Request: Schema.Struct({
      environmentId: Schema.String,
      credentialId: Schema.NullOr(Schema.String),
    }),
    Result: GrantRowSchema,
    execute: ({ environmentId, credentialId }) =>
      sql`SELECT g.credential_id, c.name AS credential_name, c.public_key AS credential_public_key,
            c.parent_id, c.endorsement, g.read_wrap IS NOT NULL AS can_read, g.can_write,
            g.created_at
          FROM project_grant g JOIN credential c ON c.id = g.credential_id
          WHERE g.project_id = ${environmentId} AND c.revoked_at IS NULL
            AND (${credentialId} IS NULL OR g.credential_id = ${credentialId})
          ORDER BY c.name`,
  });

  const creatorOf = SqlSchema.findAll({
    Request: Schema.Struct({ accountId: Schema.String, id: Schema.String }),
    Result: Schema.Struct({
      id: Schema.String,
      publicKey: Schema.String,
      endorsement: Schema.NullOr(Schema.String),
    }),
    execute: ({ accountId, id }) =>
      sql`SELECT id, public_key, endorsement FROM credential
          WHERE id = ${id} AND account_id = ${accountId}`,
  });

  const grantsOn = (
    actor: ActorIdentity,
    environmentId: string,
    credentialId: string | null = null,
  ) =>
    grantRows({ environmentId, credentialId }).pipe(
      Effect.orDie,
      Effect.map(rows =>
        rows.map(
          ({ canRead, canWrite, endorsement, ...row }): Grant => ({
            ...row,
            endorsement: actor._tag === 'Owner' ? endorsement : null,
            canRead: canRead !== 0,
            canWrite: canWrite !== 0,
          }),
        ),
      ),
    );

  /** A grant written by the owner. `readWrap` null with `canWrite` false is no grant at all. */
  const grantStatement = ({
    accountId,
    environmentId,
    credentialId,
    canWrite,
    readWrap,
    keyProof,
    keyVersion,
    now,
  }: {
    readonly accountId: string;
    readonly environmentId: string;
    readonly credentialId: string;
    readonly canWrite: boolean;
    readonly readWrap: string | null;
    readonly keyProof: string;
    readonly keyVersion: number;
    readonly now: number;
  }) =>
    sql`INSERT INTO project_grant
          (project_id, credential_id, account_id, can_write, read_wrap, key_proof, key_version,
           created_at)
        VALUES (${environmentId}, ${credentialId}, ${accountId}, ${canWrite ? 1 : 0}, ${readWrap},
          ${keyProof}, ${keyVersion}, ${now})
        ON CONFLICT (project_id, credential_id) DO UPDATE
          SET can_write = excluded.can_write, read_wrap = excluded.read_wrap,
              key_proof = excluded.key_proof, key_version = excluded.key_version`;

  return {
    grantStatement,

    listEnvironments: Effect.fn('Access.listEnvironments')(function* (actor: ActorIdentity) {
      return (yield* environmentsOf(actor)).map(({ environment }) => environment);
    }),

    environment: environmentFor,

    createEnvironment: Effect.fn('Access.createEnvironment')(function* ({
      actor,
      environment,
    }: {
      readonly actor: ActorIdentity;
      readonly environment: {
        readonly id: string;
        readonly name: string;
        readonly publicKey: string;
        readonly ownerWrap: string;
        readonly ownerProof: string;
        readonly creatorWrap: string | null;
        readonly creatorProof: string | null;
        readonly loginGrants?: ReadonlyArray<{
          readonly credentialId: string;
          readonly readWrap: string;
          readonly keyProof: string;
        }>;
      };
    }) {
      const loginGrants = environment.loginGrants ?? [];
      // The owner's vault vouches for a login's key and for no other, so an environment made by a
      // scoped service account is one the owner could never open or hand to a login.
      if (actor._tag === 'ServiceAccount' && actor.parentId !== null) {
        return yield* new OwnerRequiredError({
          message:
            'A service account a login made cannot create an environment. The owner or a login creates it and hands this service account access.',
        });
      }
      if (actor._tag === 'ServiceAccount' && loginGrants.length > 0) {
        return yield* new OwnerRequiredError({
          message:
            'Only the owner’s vault vouches for a login’s key, so only the owner hands a new environment to the logins. The dashboard does it once the owner opens it.',
        });
      }
      if (
        actor._tag === 'ServiceAccount' &&
        (environment.creatorWrap === null || environment.creatorProof === null)
      ) {
        return yield* new OwnerRequiredError({
          message:
            'A service account that creates an environment wraps the environment key to itself and vouches for it (`creatorWrap`, `creatorProof`), or it could never read what it made.',
        });
      }
      yield* underLimit(actor.accountId, 'environments');
      const now = yield* Clock.currentTimeMillis;
      // The wrap is this request's own: an id that was taken leaves another's there.
      const made = sql`EXISTS (SELECT 1 FROM project
        WHERE id = ${environment.id} AND created_at = ${now} AND owner_wrap = ${environment.ownerWrap})`;
      // One batch: the environment, its creator's grant and the log entry, or none. `OR IGNORE`
      // leaves a taken name or id without a row.
      const [inserted] = yield* sql
        .batch([
          sql`INSERT OR IGNORE INTO project
                (id, account_id, name, public_key, key_version, owner_wrap, owner_proof,
                 created_by, created_at)
              VALUES (${environment.id}, ${actor.accountId}, ${environment.name}, ${environment.publicKey}, 1,
                ${environment.ownerWrap}, ${environment.ownerProof}, ${encodeActor(actorOf(actor))}, ${now})
              RETURNING id`,
          ...(actor._tag === 'ServiceAccount'
            ? [
                sql`INSERT INTO project_grant
                      (project_id, credential_id, account_id, can_write, read_wrap, key_proof,
                       key_version, created_at)
                    SELECT ${environment.id}, ${actor.credentialId}, ${actor.accountId}, 1,
                      ${environment.creatorWrap}, ${environment.creatorProof}, 1, ${now}
                    WHERE ${made}`,
              ]
            : []),
          // Each login the owner wrapped the key to, if it is still a live login of this account.
          ...loginGrants.map(
            grant =>
              sql`INSERT INTO project_grant
                    (project_id, credential_id, account_id, can_write, read_wrap, key_proof,
                     key_version, created_at)
                  SELECT ${environment.id}, id, account_id, 1, ${grant.readWrap}, ${grant.keyProof}, 1,
                    ${now}
                  FROM credential
                  WHERE id = ${grant.credentialId} AND account_id = ${actor.accountId}
                    AND parent_id IS NULL AND revoked_at IS NULL AND ${made}`,
          ),
          yield* audit.entry(
            {
              accountId: actor.accountId,
              actor: actorOf(actor),
              action: 'environment.create',
              environmentId: environment.id,
              environmentName: environment.name,
            },
            made,
          ),
        ])
        .pipe(Effect.orDie);
      if ((inserted ?? []).length === 0) {
        // A name in the bin stays taken: reusing it would leave two environments to tell apart.
        const [binned] = yield* sql`SELECT 1 AS binned FROM project
          WHERE account_id = ${actor.accountId} AND name = ${environment.name}
            AND archived_at IS NOT NULL`.pipe(Effect.orDie);
        return yield* new AlreadyExistsError({
          message:
            binned === undefined
              ? `An environment named ${environment.name} exists in this account.`
              : `An environment named ${environment.name} is in the bin, and keeps its name until it is removed for good. The owner can restore it, or remove it for good, from the Bin in the dashboard.`,
        });
      }
      return (yield* environmentFor(actor, environment.id).pipe(Effect.orDie)).environment;
    }),

    removeEnvironment: Effect.fn('Access.removeEnvironment')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      yield* ownerOnly(actor, 'deletes an environment');
      const { environment } = yield* ownersEnvironment(actor, id);
      const now = yield* Clock.currentTimeMillis;
      const purgeAt = now + BIN_MS;
      yield* sql
        .batch([
          sql`UPDATE project SET archived_at = ${now}, purge_at = ${purgeAt}
              WHERE id = ${id} AND archived_at IS NULL`,
          sql`UPDATE paste_request SET status = 'cancelled', resolved_at = ${now}
              WHERE project_id = ${id} AND status = 'pending'`,
          yield* audit.entry({
            accountId: actor.accountId,
            actor: actorOf(actor),
            action: 'environment.delete',
            environmentId: id,
            environmentName: environment.name,
          }),
        ])
        .pipe(Effect.orDie);
      return { deletedAt: now, purgeAt };
    }),

    restoreEnvironment: Effect.fn('Access.restoreEnvironment')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      yield* ownerOnly(actor, 'restores an environment, as only the owner deletes one');
      const [binned] = yield* sql`SELECT name FROM project
        WHERE id = ${id} AND account_id = ${actor.accountId} AND archived_at IS NOT NULL`.pipe(
        Effect.orDie,
      );
      if (binned === undefined) {
        return yield* new NotFoundError({ message: 'No environment in the bin has this id.' });
      }
      yield* underLimit(actor.accountId, 'environments');
      yield* sql
        .batch([
          sql`UPDATE project SET archived_at = NULL, purge_at = NULL
              WHERE id = ${id} AND archived_at IS NOT NULL`,
          yield* audit.entry({
            accountId: actor.accountId,
            actor: actorOf(actor),
            action: 'environment.restore',
            environmentId: id,
            environmentName: String(binned.name),
          }),
        ])
        .pipe(Effect.orDie);
      return (yield* environmentFor(actor, id).pipe(Effect.orDie)).environment;
    }),

    ownerWrap: Effect.fn('Access.ownerWrap')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      yield* ownerOnly(actor, 'reads the owner’s wrap');
      const { wrap, ownerProof, environment } = yield* ownersEnvironment(actor, id);
      if (wrap === null) return yield* Effect.die(`environment ${id} has no owner wrap`);
      // The creator's key as the store holds it, revoked or not: the owner's vault decides whether
      // it is one it endorsed.
      const creators =
        environment.createdBy.kind === 'machine'
          ? yield* creatorOf({ accountId: actor.accountId, id: environment.createdBy.id }).pipe(
              Effect.orDie,
            )
          : [];
      return {
        ownerWrap: wrap,
        ownerProof,
        keyVersion: environment.keyVersion,
        creator: creators[0] ?? null,
      };
    }),

    grants: Effect.fn('Access.grants')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      yield* environmentFor(actor, id);
      return yield* grantsOn(actor, id);
    }),

    setGrant: Effect.fn('Access.setGrant')(function* ({
      actor,
      id,
      credentialId,
      canWrite,
      readWrap,
      keyProof,
      keyVersion,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly credentialId: string;
      readonly canWrite: boolean;
      readonly readWrap: string | null;
      readonly keyProof: string;
      readonly keyVersion: number;
    }) {
      yield* ownerOnly(actor, 'grants access');
      const { environment } = yield* ownersEnvironment(actor, id);
      const serviceAccount = yield* serviceAccountIn(actor.accountId, credentialId);
      if (!canWrite && readWrap === null) {
        return yield* new NotFoundError({
          message: 'A grant gives read, write or both. To take access away, remove the grant.',
        });
      }
      const now = yield* Clock.currentTimeMillis;
      yield* sql
        .batch([
          grantStatement({
            accountId: actor.accountId,
            environmentId: id,
            credentialId,
            canWrite,
            readWrap,
            keyProof,
            keyVersion,
            now,
          }),
          yield* audit.entry({
            accountId: actor.accountId,
            actor: actorOf(actor),
            action: 'grant.set',
            environmentId: id,
            environmentName: environment.name,
            detail: `${serviceAccount.name}: ${[readWrap !== null && 'read', canWrite && 'write'].filter(Boolean).join(' + ')}`,
          }),
        ])
        .pipe(Effect.orDie);
      const [grant] = yield* grantsOn(actor, id, credentialId);
      if (grant === undefined) return yield* Effect.die(`grant ${id}/${credentialId} vanished`);
      return grant;
    }),

    removeGrant: Effect.fn('Access.removeGrant')(function* ({
      actor,
      id,
      credentialId,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly credentialId: string;
    }) {
      yield* ownerOnly(actor, 'removes access');
      const { environment } = yield* ownersEnvironment(actor, id);
      const serviceAccount = yield* serviceAccountIn(actor.accountId, credentialId);
      // A service account made by this one holds a copy of the same access, so it loses it too.
      const [removed] = yield* sql
        .batch([
          sql`DELETE FROM project_grant
              WHERE project_id = ${id}
                AND credential_id IN (SELECT id FROM credential
                                      WHERE id = ${credentialId} OR parent_id = ${credentialId})
              RETURNING credential_id`,
          yield* audit.entry({
            accountId: actor.accountId,
            actor: actorOf(actor),
            action: 'grant.remove',
            environmentId: id,
            environmentName: environment.name,
            detail: serviceAccount.name,
          }),
        ])
        .pipe(Effect.orDie);
      return { removed: (removed ?? []).length > 0 };
    }),
  };
};
