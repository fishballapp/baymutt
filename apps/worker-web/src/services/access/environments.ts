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
          FROM environment_grant g JOIN credential c ON c.id = g.credential_id
          WHERE g.environment_id = ${environmentId} AND c.revoked_at IS NULL
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

  /** The org, when the caller's person is its owner; a login acts for its person. */
  const ownedOrg = SqlSchema.findAll({
    Request: Schema.Struct({ accountId: Schema.String, orgId: Schema.String }),
    Result: Schema.Struct({ slug: Schema.String, role: Schema.String }),
    execute: ({ accountId, orgId }) =>
      sql`SELECT o.slug, m.role FROM organization o
          JOIN member m ON m.organizationId = o.id
          JOIN store_account a ON a.user_id = m.userId
          WHERE o.id = ${orgId} AND a.id = ${accountId}`,
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
    environmentId,
    credentialId,
    canWrite,
    readWrap,
    keyProof,
    keyVersion,
    now,
  }: {
    readonly environmentId: string;
    readonly credentialId: string;
    readonly canWrite: boolean;
    readonly readWrap: string | null;
    readonly keyProof: string;
    readonly keyVersion: number;
    readonly now: number;
  }) =>
    sql`INSERT INTO environment_grant
          (environment_id, credential_id, can_write, read_wrap, key_proof, key_version, created_at)
        VALUES (${environmentId}, ${credentialId}, ${canWrite ? 1 : 0}, ${readWrap},
          ${keyProof}, ${keyVersion}, ${now})
        ON CONFLICT (environment_id, credential_id) DO UPDATE
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
        readonly orgId: string;
        readonly name: string;
        readonly publicKey: string;
        readonly memberWrap: string;
        readonly memberProof: string;
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
      // service account is one the owner could never open or hand to a login.
      if (actor._tag === 'Credential' && actor.parentId !== null) {
        return yield* new OwnerRequiredError({
          message:
            'A service account cannot create an environment. The owner or a CLI login creates it and hands this service account access.',
        });
      }
      if (actor._tag === 'Credential' && loginGrants.length > 0) {
        return yield* new OwnerRequiredError({
          message:
            'Only the owner’s vault vouches for a CLI login’s key, so only the owner hands a new environment to the CLI logins. The dashboard does it once the owner opens it.',
        });
      }
      if (
        actor._tag === 'Credential' &&
        (environment.creatorWrap === null || environment.creatorProof === null)
      ) {
        return yield* new OwnerRequiredError({
          message:
            'A CLI login that creates an environment wraps the environment key to itself and vouches for it (`creatorWrap`, `creatorProof`), or it could never read what it made.',
        });
      }
      const [org] = yield* ownedOrg({ accountId: actor.accountId, orgId: environment.orgId }).pipe(
        Effect.orDie,
      );
      if (org === undefined) {
        return yield* new NotFoundError({
          message: 'No org of yours has this id.',
        });
      }
      if (org.role !== 'owner') {
        return yield* new OwnerRequiredError({
          message: `Only an owner of ${org.slug} creates an environment in it.`,
        });
      }
      yield* underLimit(actor.accountId, 'environments');
      const now = yield* Clock.currentTimeMillis;
      // The row is this request's own: an id that was taken leaves another's there.
      const made = sql`EXISTS (SELECT 1 FROM environment
        WHERE id = ${environment.id} AND created_at = ${now} AND public_key = ${environment.publicKey})`;
      // One batch: the environment, its creator's member copy and grant, and the log entry, or
      // none. `OR IGNORE` leaves a taken name or id without a row.
      const [inserted] = yield* sql
        .batch([
          sql`INSERT OR IGNORE INTO environment
                (id, org_id, name, public_key, key_version, created_by, created_at)
              VALUES (${environment.id}, ${environment.orgId}, ${environment.name},
                ${environment.publicKey}, 1, ${encodeActor(actorOf(actor))}, ${now})
              RETURNING id`,
          sql`INSERT INTO member_wrap (environment_id, account_id, wrap, proof, key_version, created_at)
              SELECT ${environment.id}, ${actor.accountId}, ${environment.memberWrap},
                ${environment.memberProof}, 1, ${now}
              WHERE ${made}`,
          ...(actor._tag === 'Credential'
            ? [
                sql`INSERT INTO environment_grant
                      (environment_id, credential_id, can_write, read_wrap, key_proof, key_version,
                       created_at)
                    SELECT ${environment.id}, ${actor.credentialId}, 1, ${environment.creatorWrap},
                      ${environment.creatorProof}, 1, ${now}
                    WHERE ${made}`,
              ]
            : []),
          // Each login the owner wrapped the key to, if it is still a live login of this account.
          ...loginGrants.map(
            grant =>
              sql`INSERT INTO environment_grant
                    (environment_id, credential_id, can_write, read_wrap, key_proof, key_version,
                     created_at)
                  SELECT ${environment.id}, id, 1, ${grant.readWrap}, ${grant.keyProof}, 1, ${now}
                  FROM credential
                  WHERE id = ${grant.credentialId} AND account_id = ${actor.accountId}
                    AND parent_id IS NULL AND revoked_at IS NULL AND ${made}`,
          ),
          yield* audit.entry(
            {
              orgId: environment.orgId,
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
        const [binned] = yield* sql`SELECT 1 AS binned FROM environment
          WHERE org_id = ${environment.orgId} AND name = ${environment.name}
            AND deleted_at IS NOT NULL`.pipe(Effect.orDie);
        return yield* new AlreadyExistsError({
          message:
            binned === undefined
              ? `An environment named ${org.slug}/${environment.name} exists.`
              : `An environment named ${org.slug}/${environment.name} is in the bin, and keeps its name until it is removed for good. The owner can restore it, or remove it for good, from the Bin in the dashboard.`,
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
      const { environment } = yield* ownersEnvironment(actor, id, 'deletes an environment');
      const now = yield* Clock.currentTimeMillis;
      const purgeAt = now + BIN_MS;
      yield* sql
        .batch([
          sql`UPDATE environment SET deleted_at = ${now}, purge_at = ${purgeAt}
              WHERE id = ${id} AND deleted_at IS NULL`,
          sql`UPDATE paste_link SET status = 'cancelled', resolved_at = ${now}
              WHERE environment_id = ${id} AND status = 'pending'`,
          yield* audit.entry({
            orgId: environment.orgId,
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
      if (actor._tag !== 'Owner') {
        return yield* new OwnerRequiredError({
          message:
            'Only an owner of the environment’s org restores it, as only an owner deletes one, from the dashboard.',
        });
      }
      const [binned] = yield* sql<{
        readonly name: string;
        readonly orgId: string;
      }>`SELECT e.name, e.org_id FROM environment e
          JOIN member m ON m.organizationId = e.org_id AND m.role = 'owner'
          JOIN store_account a ON a.user_id = m.userId
          WHERE e.id = ${id} AND a.id = ${actor.accountId} AND e.deleted_at IS NOT NULL`.pipe(
        Effect.orDie,
      );
      if (binned === undefined) {
        return yield* new NotFoundError({
          message: 'No environment in the bin of an org you own has this id.',
        });
      }
      yield* underLimit(actor.accountId, 'environments');
      yield* sql
        .batch([
          sql`UPDATE environment SET deleted_at = NULL, purge_at = NULL
              WHERE id = ${id} AND deleted_at IS NOT NULL`,
          yield* audit.entry({
            orgId: binned.orgId,
            actor: actorOf(actor),
            action: 'environment.restore',
            environmentId: id,
            environmentName: binned.name,
          }),
        ])
        .pipe(Effect.orDie);
      return (yield* environmentFor(actor, id).pipe(Effect.orDie)).environment;
    }),

    memberWrap: Effect.fn('Access.memberWrap')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      const { memberWrap, memberProof, environment } = yield* ownersEnvironment(
        actor,
        id,
        'reads a member’s copy of its key',
      );
      if (memberWrap === null || memberProof === null) {
        return yield* new NotFoundError({
          message: `${environment.orgSlug}/${environment.name} holds no copy of its key for you.`,
        });
      }
      // The creator's key as the store holds it, revoked or not: the owner's vault decides whether
      // it is one it endorsed.
      const creators =
        environment.createdBy.kind === 'credential'
          ? yield* creatorOf({ accountId: actor.accountId, id: environment.createdBy.id }).pipe(
              Effect.orDie,
            )
          : [];
      return {
        memberWrap,
        memberProof,
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
      const { environment } = yield* ownersEnvironment(actor, id, 'grants access');
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
            environmentId: id,
            credentialId,
            canWrite,
            readWrap,
            keyProof,
            keyVersion,
            now,
          }),
          yield* audit.entry({
            orgId: environment.orgId,
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
      const { environment } = yield* ownersEnvironment(actor, id, 'removes access');
      const serviceAccount = yield* serviceAccountIn(actor.accountId, credentialId);
      // A service account made by this one holds a copy of the same access, so it loses it too.
      const [removed] = yield* sql
        .batch([
          sql`DELETE FROM environment_grant
              WHERE environment_id = ${id}
                AND credential_id IN (SELECT id FROM credential
                                      WHERE id = ${credentialId} OR parent_id = ${credentialId})
              RETURNING credential_id`,
          yield* audit.entry({
            orgId: environment.orgId,
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
