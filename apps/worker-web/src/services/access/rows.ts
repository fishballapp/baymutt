// The rows `Access` reads, and the lookups its sub-domains share.
import {
  type ActorIdentity,
  type Environment,
  LIMITS,
  LimitReachedError,
  NoAccessError,
  NotFoundError,
  OwnerRequiredError,
} from '@baymutt/api';
import type * as D1Client from '@effect/sql-d1/D1Client';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import { ActorJsonSchema } from '../actors.ts';

export const ServiceAccountRowSchema = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  name: Schema.String,
  publicKey: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  endorsement: Schema.NullOr(Schema.String),
  welcome: Schema.NullOr(Schema.String),
  keyVoucherOwner: Schema.NullOr(Schema.String),
  keyVoucherMaker: Schema.NullOr(Schema.String),
  accountVoucher: Schema.NullOr(Schema.String),
  createdAt: Schema.Finite,
  lastUsedAt: Schema.NullOr(Schema.Finite),
  expiresAt: Schema.NullOr(Schema.Finite),
});
export type ServiceAccountRow = typeof ServiceAccountRowSchema.Type;

export const EnvironmentRowSchema = Schema.Struct({
  id: Schema.String,
  orgId: Schema.String,
  orgSlug: Schema.String,
  /** The caller's person's role in the org. */
  role: Schema.String,
  name: Schema.String,
  publicKey: Schema.String,
  keyVersion: Schema.Finite,
  createdBy: ActorJsonSchema,
  createdAt: Schema.Finite,
  secretCount: Schema.Finite,
  /** The caller's person's own copy of the key, and the creator's proof to it. */
  memberWrap: Schema.NullOr(Schema.String),
  memberProof: Schema.NullOr(Schema.String),
  /** The caller's grant, when the caller is a credential that has one. */
  canWrite: Schema.NullOr(Schema.Finite),
  readWrap: Schema.NullOr(Schema.String),
  keyProof: Schema.NullOr(Schema.String),
});
export type EnvironmentRow = typeof EnvironmentRowSchema.Type;

/** What a caller may do with an environment, and the wrap it reads with. */
export type EnvironmentAccess = {
  readonly environment: Environment;
  /** The caller is the signed-in owner of the environment's org. */
  readonly isOrgOwner: boolean;
  /** The member copy of the key and its proof, for the owner; null for a credential. */
  readonly memberWrap: string | null;
  readonly memberProof: string | null;
  /** The environment key wrapped to the caller, and the reader id the wrap is bound to. */
  readonly wrap: string | null;
  readonly readerId: string;
  /** The caller is a CLI login, which is meant to hold every environment: one it lacks waits on the owner's dashboard. */
  readonly readerIsLogin: boolean;
};

/** A CLI login: made by `baymutt login` and approved by the owner, so it has no parent. It holds every environment. */
export const isLogin = (actor: ActorIdentity): boolean =>
  actor._tag === 'Credential' && actor.parentId === null;

/** What a login is told when the owner's dashboard has not wrapped an environment to it yet. */
const awaitingDashboard = (environmentName: string) =>
  `This CLI login has full access, but ${environmentName} was made by another CLI login and is not wrapped to this one yet: only the owner's browser can do that. Ask the owner to open the baymutt dashboard once; it grants every environment a CLI login lacks.`;

/**
 * The orgs a person belongs to, by their account: a subquery for `IN (…)`. A credential reaches only
 * environments of these, whatever grant rows say.
 */
export const orgsOf = (sql: D1Client.D1Client, accountId: string) =>
  sql`SELECT m.organizationId FROM member m JOIN store_account a ON a.user_id = m.userId
      WHERE a.id = ${accountId}`;

export const lookups = (sql: D1Client.D1Client) => {
  /**
   * Live environments of the caller's orgs with its grant and its person's member copy joined on.
   * `credentialId` null is the owner, who sees every environment; a login sees every environment
   * too (one it lacks a grant on is waiting for the owner's dashboard); a service account sees only
   * those it holds a grant on.
   */
  const environmentRows = SqlSchema.findAll({
    Request: Schema.Struct({
      accountId: Schema.String,
      credentialId: Schema.NullOr(Schema.String),
      seesAll: Schema.Boolean,
      environmentId: Schema.NullOr(Schema.String),
    }),
    Result: EnvironmentRowSchema,
    execute: ({ accountId, credentialId, seesAll, environmentId }) =>
      sql`SELECT e.id, e.org_id, o.slug AS org_slug, m.role, e.name, e.public_key, e.key_version,
            e.created_by, e.created_at, w.wrap AS member_wrap, w.proof AS member_proof,
            g.can_write, g.read_wrap, g.key_proof,
            (SELECT COUNT(*) FROM secret s
              WHERE s.environment_id = e.id AND s.current_version IS NOT NULL) AS secret_count
          FROM environment e
          JOIN organization o ON o.id = e.org_id
          JOIN store_account a ON a.id = ${accountId}
          JOIN member m ON m.organizationId = e.org_id AND m.userId = a.user_id
          LEFT JOIN member_wrap w ON w.environment_id = e.id AND w.account_id = a.id
          LEFT JOIN environment_grant g ON g.environment_id = e.id AND g.credential_id = ${credentialId}
          WHERE e.deleted_at IS NULL
            AND (${environmentId} IS NULL OR e.id = ${environmentId})
            AND (${seesAll ? 1 : 0} = 1 OR g.credential_id IS NOT NULL)
          ORDER BY o.slug, e.name`,
  });

  const toAccess = (actor: ActorIdentity, row: EnvironmentRow): EnvironmentAccess => {
    const isOwner = actor._tag === 'Owner';
    const isOrgOwner = isOwner && row.role === 'owner';
    return {
      environment: {
        id: row.id,
        orgId: row.orgId,
        orgSlug: row.orgSlug,
        name: row.name,
        publicKey: row.publicKey,
        keyVersion: row.keyVersion,
        createdAt: row.createdAt,
        createdBy: row.createdBy,
        secretCount: row.secretCount,
        keyProof: isOwner ? null : row.keyProof,
        canRead: isOwner ? row.memberWrap !== null : row.readWrap !== null,
        canWrite: isOrgOwner || row.canWrite === 1,
      },
      isOrgOwner,
      memberWrap: isOwner ? row.memberWrap : null,
      memberProof: isOwner ? row.memberProof : null,
      wrap: isOwner ? row.memberWrap : row.readWrap,
      readerId: isOwner ? actor.accountId : actor.credentialId,
      readerIsLogin: isLogin(actor),
    };
  };

  const environmentsOf = (actor: ActorIdentity, environmentId: string | null = null) =>
    environmentRows({
      accountId: actor.accountId,
      credentialId: actor._tag === 'Credential' ? actor.credentialId : null,
      seesAll: actor._tag === 'Owner' || isLogin(actor),
      environmentId,
    }).pipe(
      Effect.orDie,
      Effect.map(rows => rows.map(row => toAccess(actor, row))),
    );

  /**
   * An environment the caller holds a grant on, or the owner. One a service account holds no grant
   * on reads as not found: its name is not the caller's to learn. A login is listed every
   * environment, and is refused one it holds nothing on yet: listed is not granted.
   */
  const environmentFor = Effect.fnUntraced(function* (actor: ActorIdentity, environmentId: string) {
    const [access] = yield* environmentsOf(actor, environmentId);
    if (access?.readerIsLogin && !access.environment.canRead && !access.environment.canWrite) {
      return yield* new NoAccessError({
        need: 'read',
        message: awaitingDashboard(access.environment.name),
      });
    }
    if (access === undefined) {
      return yield* new NotFoundError({
        message:
          actor._tag === 'Owner' || isLogin(actor)
            ? 'No environment of your orgs has this id.'
            : 'No environment with this id is granted to this service account. List what it holds with `baymutt environments`; the CLI login that made it, or the owner, can hand it one.',
      });
    }
    return access;
  });

  /**
   * An environment for an owner-only action: the caller is the signed-in owner of its org, which
   * holds every one of its environments.
   */
  const ownersEnvironment = Effect.fnUntraced(function* (
    actor: ActorIdentity,
    environmentId: string,
    what: string,
  ) {
    if (actor._tag !== 'Owner') {
      return yield* new OwnerRequiredError({
        message: `Only an owner of the environment's org ${what}, from the dashboard.`,
      });
    }
    const access = yield* environmentFor(actor, environmentId).pipe(
      Effect.catchTag('NoAccessError', Effect.die),
    );
    if (!access.isOrgOwner) {
      return yield* new OwnerRequiredError({
        message: `Only an owner of ${access.environment.orgSlug} ${what}.`,
      });
    }
    return access;
  });

  const needing = (access: EnvironmentAccess, need: 'read' | 'write') => {
    const holds = need === 'read' ? access.environment.canRead : access.environment.canWrite;
    return holds
      ? Effect.succeed(access)
      : Effect.fail(
          new NoAccessError({
            need,
            message: access.readerIsLogin
              ? awaitingDashboard(access.environment.name)
              : `This service account has no ${need} access to ${access.environment.name}. The CLI login that made it can hand that on with \`baymutt service-accounts access\`, or the owner from the dashboard.`,
          }),
        );
  };

  const serviceAccountRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ accountId: Schema.String, id: Schema.String }),
    Result: ServiceAccountRowSchema,
    execute: ({ accountId, id }) =>
      sql`SELECT id, account_id, name, public_key, parent_id, description, endorsement, welcome,
            key_voucher_owner, key_voucher_maker, account_voucher, created_at, last_used_at,
            expires_at
          FROM credential
          WHERE id = ${id} AND account_id = ${accountId} AND revoked_at IS NULL`,
  });

  const serviceAccountIn = Effect.fnUntraced(function* (accountId: string, id: string) {
    const found = yield* serviceAccountRow({ accountId, id }).pipe(Effect.orDie);
    if (Option.isNone(found)) {
      return yield* new NotFoundError({ message: 'No CLI login or service account has this id.' });
    }
    return found.value;
  });

  const LIMIT_WORDS = {
    orgs: ['orgs', 'Delete an empty one in the dashboard'],
    environments: ['environments across their orgs', 'Delete one in the dashboard'],
    serviceAccounts: [
      'CLI logins and service accounts',
      'Revoke one with `baymutt service-accounts revoke`',
    ],
  } as const;

  /**
   * Refuses once the account holds as many as the beta allows. Counted before the write, so two
   * requests at once can pass together and overshoot by one: a cap on growth, not an invariant.
   */
  const underLimit = Effect.fnUntraced(function* (
    accountId: string,
    what: 'orgs' | 'environments' | 'serviceAccounts',
  ) {
    const held = {
      orgs: sql`SELECT COUNT(*) AS held FROM (${orgsOf(sql, accountId)})`,
      environments: sql`SELECT COUNT(*) AS held FROM environment
        WHERE org_id IN (${orgsOf(sql, accountId)}) AND deleted_at IS NULL`,
      serviceAccounts: sql`SELECT COUNT(*) AS held FROM credential
        WHERE account_id = ${accountId} AND revoked_at IS NULL`,
    }[what];
    const [row] = yield* held.pipe(Effect.orDie);
    if (Number(row?.held ?? 0) >= LIMITS[what]) {
      const [noun, remedy] = LIMIT_WORDS[what];
      return yield* new LimitReachedError({
        limit: LIMITS[what],
        message: `An account holds up to ${LIMITS[what]} ${noun} while baymutt is in beta. ${remedy} to make room.`,
      });
    }
  });

  return {
    environmentsOf,
    environmentFor,
    ownersEnvironment,
    needing,
    serviceAccountIn,
    underLimit,
  };
};

export type Lookups = ReturnType<typeof lookups>;
