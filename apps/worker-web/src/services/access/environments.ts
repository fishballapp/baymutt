// Environments and the reads granted on them.
import {
  type Actor,
  type ActorIdentity,
  type Grant,
  InvalidRequestError,
  NotFoundError,
  OwnerRequiredError,
} from '@baymutt/api';
import type * as D1Client from '@effect/sql-d1/D1Client';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import type * as Statement from 'effect/sql/Statement';
import { actorOf, encodeActor } from '../actors.ts';
import type { Audit } from '../audit.ts';
import { BIN_MS } from '../bin.ts';
import {
  addressOf,
  grantStatement,
  isLogin,
  type Lookups,
  namesNotSealed,
  newEnvironmentStatements,
  orgsOf,
} from './rows.ts';

/** An environment to the bin, and the log entry: both only if `onlyIf`. */
export const removeEnvironmentStatements = Effect.fnUntraced(function* (
  { sql, audit }: { readonly sql: D1Client.D1Client; readonly audit: Audit['Service'] },
  {
    id,
    orgId,
    actor,
    now,
    onlyIf = sql`1 = 1`,
  }: {
    readonly id: string;
    readonly orgId: string;
    readonly actor: Actor;
    readonly now: number;
    readonly onlyIf?: Statement.Fragment;
  },
) {
  return [
    sql`UPDATE environment SET deleted_at = ${now}, purge_at = ${now + BIN_MS}
        WHERE id = ${id} AND deleted_at IS NULL AND ${onlyIf}`,
    yield* audit.entry({ orgId, actor, action: 'environment.delete', environmentId: id }, onlyIf),
  ];
});

/** An environment out of the bin, and the log entry: both only if `onlyIf`. */
export const restoreEnvironmentStatements = Effect.fnUntraced(function* (
  { sql, audit }: { readonly sql: D1Client.D1Client; readonly audit: Audit['Service'] },
  {
    id,
    orgId,
    actor,
    onlyIf = sql`1 = 1`,
  }: {
    readonly id: string;
    readonly orgId: string;
    readonly actor: Actor;
    readonly onlyIf?: Statement.Fragment;
  },
) {
  return [
    sql`UPDATE environment SET deleted_at = NULL, purge_at = NULL
        WHERE id = ${id} AND deleted_at IS NOT NULL AND ${onlyIf}`,
    yield* audit.entry({ orgId, actor, action: 'environment.restore', environmentId: id }, onlyIf),
  ];
});

const GrantRowSchema = Schema.Struct({
  credentialId: Schema.String,
  credentialName: Schema.String,
  credentialPublicKey: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  endorsement: Schema.NullOr(Schema.String),
  createdAt: Schema.Finite,
});

export const environments = ({
  sql,
  audit,
  lookups: {
    environmentsOf,
    environmentFor,
    ownersEnvironment,
    approvedServiceAccountIn,
    underLimit,
    ownedOrg,
    nameTaken,
  },
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
            c.parent_id, c.endorsement, g.created_at
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

  /** The caller's own copy of the names key of each org it reaches whose names are sealed. */
  const namesKeysOf = SqlSchema.findAll({
    Request: Schema.Struct({ accountId: Schema.String, readerId: Schema.String }),
    Result: Schema.Struct({ orgId: Schema.String, wrap: Schema.String }),
    execute: ({ accountId, readerId }) =>
      // A key gets its own org's alone, whatever other rows a store from before 0.10 still holds.
      sql`SELECT n.org_id, n.wrap FROM names_key_wrap n
          LEFT JOIN credential c ON c.id = n.reader_id
          WHERE n.reader_id = ${readerId} AND n.org_id IN (${orgsOf(sql, accountId)})
            AND (c.id IS NULL OR c.parent_id IS NULL OR c.org_id = n.org_id)
          ORDER BY n.org_id`,
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
          ({ endorsement, ...row }): Grant => ({
            ...row,
            endorsement: actor._tag === 'Owner' ? endorsement : null,
          }),
        ),
      ),
    );

  return {
    listEnvironments: Effect.fn('Access.listEnvironments')(function* (actor: ActorIdentity) {
      const [listed, namesKeys] = yield* Effect.all(
        [
          environmentsOf(actor),
          namesKeysOf({
            accountId: actor.accountId,
            readerId: actor._tag === 'Owner' ? actor.accountId : actor.credentialId,
          }).pipe(Effect.orDie),
        ],
        { concurrency: 2 },
      );
      return { environments: listed.map(({ environment }) => environment), namesKeys };
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
        readonly sealedName: string;
        readonly publicKey: string;
        readonly memberWrap: string;
        readonly memberProof: string;
      };
    }) {
      if (actor._tag !== 'Owner') {
        return yield* new OwnerRequiredError({
          message: isLogin(actor)
            ? 'A CLI login does not create an environment: it asks for one in a plan’s `environments` step, and the owner creates it. See `baymutt ask --help`.'
            : 'A key cannot create an environment. A CLI login asks for one in a plan: `baymutt ask --help`.',
        });
      }
      const org = yield* ownedOrg(actor, environment.orgId, 'creates an environment in it');
      if (!org.areNamesSealed) return yield* namesNotSealed(org.slug);
      yield* underLimit(actor.accountId, 'environments');
      const now = yield* Clock.currentTimeMillis;
      const { made, statements } = newEnvironmentStatements(sql, environment, {
        accountId: actor.accountId,
        createdBy: encodeActor(actorOf(actor)),
        now,
        onlyIf: sql`1 = 1`,
      });
      // One batch: the environment, the owner's member copy and the log entry, or none of them.
      const [inserted] = yield* sql
        .batch([
          ...statements,
          yield* audit.entry(
            {
              orgId: environment.orgId,
              actor: actorOf(actor),
              action: 'environment.create',
              environmentId: environment.id,
            },
            made,
          ),
        ])
        .pipe(Effect.orDie);
      if ((inserted ?? []).length === 0) {
        return yield* yield* nameTaken({ ...environment, orgSlug: org.slug });
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
      yield* sql
        .batch(
          yield* removeEnvironmentStatements(
            { sql, audit },
            { id, orgId: environment.orgId, actor: actorOf(actor), now },
          ),
        )
        .pipe(Effect.orDie);
      return { deletedAt: now, purgeAt: now + BIN_MS };
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
        readonly orgId: string;
      }>`SELECT e.org_id FROM environment e
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
        .batch(
          yield* restoreEnvironmentStatements(
            { sql, audit },
            { id, orgId: binned.orgId, actor: actorOf(actor) },
          ),
        )
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
          message: `${addressOf(environment)} holds no copy of its key for you.`,
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
      readWrap,
      keyProof,
      keyVersion,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly credentialId: string;
      readonly readWrap: string;
      readonly keyProof: string;
      readonly keyVersion: number;
    }) {
      const { environment } = yield* ownersEnvironment(actor, id, 'grants access');
      const serviceAccount = yield* approvedServiceAccountIn(actor.accountId, credentialId);
      if (serviceAccount.parentId === null) {
        return yield* new InvalidRequestError({
          message:
            'A CLI login holds no environment. It asks for a key in a plan’s `access` step, and approving that step makes a key that reads it.',
        });
      }
      if (serviceAccount.orgId !== environment.orgId) {
        return yield* new InvalidRequestError({
          message: `${serviceAccount.name} belongs to ${serviceAccount.orgSlug ?? 'another org'}, and a key holds environments of its own org only.`,
        });
      }
      const now = yield* Clock.currentTimeMillis;
      yield* sql
        .batch([
          grantStatement(sql, {
            environmentId: id,
            credentialId,
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
            detail: `${serviceAccount.name}: read`,
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
      const serviceAccount = yield* approvedServiceAccountIn(actor.accountId, credentialId);
      const [removed] = yield* sql
        .batch([
          sql`DELETE FROM environment_grant
              WHERE environment_id = ${id} AND credential_id = ${credentialId}
              RETURNING credential_id`,
          yield* audit.entry({
            orgId: environment.orgId,
            actor: actorOf(actor),
            action: 'grant.remove',
            environmentId: id,
            detail: serviceAccount.name,
          }),
        ])
        .pipe(Effect.orDie);
      return { removed: (removed ?? []).length > 0 };
    }),
  };
};
