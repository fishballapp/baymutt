// The rows `Access` reads, and the lookups its sub-domains share.
import {
  type ActorIdentity,
  type Environment,
  LIMITS,
  LimitReachedError,
  NoAccessError,
  NotFoundError,
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
  accountId: Schema.String,
  name: Schema.String,
  publicKey: Schema.String,
  keyVersion: Schema.Finite,
  ownerWrap: Schema.String,
  ownerProof: Schema.String,
  createdBy: ActorJsonSchema,
  createdAt: Schema.Finite,
  secretCount: Schema.Finite,
  /** The caller's grant, when the caller is a service account that has one. */
  canWrite: Schema.NullOr(Schema.Finite),
  readWrap: Schema.NullOr(Schema.String),
  keyProof: Schema.NullOr(Schema.String),
});
export type EnvironmentRow = typeof EnvironmentRowSchema.Type;

/** What a caller may do with an environment, and the wrap it reads with. */
export type EnvironmentAccess = {
  readonly environment: Environment;
  readonly ownerProof: string;
  /** The environment key wrapped to the caller, and the reader id the wrap is bound to. */
  readonly wrap: string | null;
  readonly readerId: string;
  /** The caller is a login, which is meant to hold every environment: one it lacks waits on the owner's dashboard. */
  readonly readerIsLogin: boolean;
};

/** A login: made by `baymutt login` and approved by the owner, so it has no parent. It holds every environment. */
export const isLogin = (actor: ActorIdentity): boolean =>
  actor._tag === 'ServiceAccount' && actor.parentId === null;

/** What a login is told when the owner's dashboard has not wrapped an environment to it yet. */
const awaitingDashboard = (environmentName: string) =>
  `This login has full access, but ${environmentName} was made by another service account and is not wrapped to this login yet: only the owner's browser can do that. Ask the owner to open the baymutt dashboard once; it grants every environment a login lacks.`;

export const lookups = (sql: D1Client.D1Client) => {
  /**
   * Live environments of an account with the caller's grant joined on. `credentialId` null is the
   * owner, who sees every environment; a login sees every environment too (one it lacks a grant on is
   * waiting for the owner's dashboard); any other service account sees only those it holds a
   * grant on.
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
      sql`SELECT e.id, e.account_id, e.name, e.public_key, e.key_version, e.owner_wrap,
            e.owner_proof, e.created_by, e.created_at, g.can_write, g.read_wrap, g.key_proof,
            (SELECT COUNT(*) FROM secret s
              WHERE s.environment_id = e.id AND s.current_version IS NOT NULL) AS secret_count
          FROM environment e
          LEFT JOIN environment_grant g ON g.environment_id = e.id AND g.credential_id = ${credentialId}
          WHERE e.account_id = ${accountId} AND e.deleted_at IS NULL
            AND (${environmentId} IS NULL OR e.id = ${environmentId})
            AND (${seesAll ? 1 : 0} = 1 OR g.credential_id IS NOT NULL)
          ORDER BY e.name`,
  });

  const toAccess = (actor: ActorIdentity, row: EnvironmentRow): EnvironmentAccess => {
    const isOwner = actor._tag === 'Owner';
    return {
      environment: {
        id: row.id,
        accountId: row.accountId,
        name: row.name,
        publicKey: row.publicKey,
        keyVersion: row.keyVersion,
        createdAt: row.createdAt,
        createdBy: row.createdBy,
        secretCount: row.secretCount,
        keyProof: isOwner ? null : row.keyProof,
        canRead: isOwner || row.readWrap !== null,
        canWrite: isOwner || row.canWrite === 1,
      },
      ownerProof: row.ownerProof,
      wrap: isOwner ? row.ownerWrap : row.readWrap,
      readerId: isOwner ? actor.accountId : actor.credentialId,
      readerIsLogin: isLogin(actor),
    };
  };

  const environmentsOf = (actor: ActorIdentity, environmentId: string | null = null) =>
    environmentRows({
      accountId: actor.accountId,
      credentialId: actor._tag === 'ServiceAccount' ? actor.credentialId : null,
      seesAll: actor._tag === 'Owner' || isLogin(actor),
      environmentId,
    }).pipe(
      Effect.orDie,
      Effect.map(rows => rows.map(row => toAccess(actor, row))),
    );

  /**
   * An environment the caller holds a grant on, or the owner. One a scoped service account holds no
   * grant on reads as not found: its name is not the caller's to learn. A login is listed every
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
            ? 'No environment has this id.'
            : 'No environment with this id is granted to this service account. List what it holds with `baymutt environments`; the login that made it, or the owner, can hand it one.',
      });
    }
    return access;
  });

  /** An environment for a caller already checked to be the owner, who holds every environment: never a refusal for access. */
  const ownersEnvironment = (actor: ActorIdentity, environmentId: string) =>
    environmentFor(actor, environmentId).pipe(Effect.catchTag('NoAccessError', Effect.die));

  const needing = (access: EnvironmentAccess, need: 'read' | 'write') => {
    const holds = need === 'read' ? access.environment.canRead : access.environment.canWrite;
    return holds
      ? Effect.succeed(access)
      : Effect.fail(
          new NoAccessError({
            need,
            message: access.readerIsLogin
              ? awaitingDashboard(access.environment.name)
              : `This service account has no ${need} access to ${access.environment.name}. The login that made it can hand that on with \`baymutt service-accounts access\`, or the owner from the dashboard.`,
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
      return yield* new NotFoundError({ message: 'No service account has this id.' });
    }
    return found.value;
  });

  /**
   * Refuses once the account holds as many as the beta allows. Counted before the write, so two
   * requests at once can pass together and overshoot by one: a cap on growth, not an invariant.
   */
  const underLimit = Effect.fnUntraced(function* (
    accountId: string,
    what: 'environments' | 'serviceAccounts',
  ) {
    const [row] = yield* (
      what === 'environments'
        ? sql`SELECT COUNT(*) AS held FROM environment
            WHERE account_id = ${accountId} AND deleted_at IS NULL`
        : sql`SELECT COUNT(*) AS held FROM credential
            WHERE account_id = ${accountId} AND revoked_at IS NULL`
    ).pipe(Effect.orDie);
    if (Number(row?.held ?? 0) >= LIMITS[what]) {
      return yield* new LimitReachedError({
        limit: LIMITS[what],
        message: `An account holds up to ${LIMITS[what]} ${what === 'environments' ? 'environments' : 'service accounts'} while baymutt is in beta. ${what === 'environments' ? 'Delete one in the dashboard' : 'Revoke one with `baymutt service-accounts revoke`'} to make room.`,
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
