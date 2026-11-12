// Service accounts: recognising one by its bearer, approving its login, making a narrower one, revoking.
import {
  type ActorIdentity,
  AlreadyExistsError,
  InvalidRequestError,
  type LoginGrant,
  type Me,
  NoAccessError,
  NotFoundError,
  OwnerRequiredError,
  type ServiceAccount,
  type ServiceAccountActor,
  type ServiceAccountVouchers,
  type SetAccessPayload,
  UnauthorizedError,
} from '@baymutt/api';
import { parseBearer } from '@baymutt/keys/wire';
import type * as D1Client from '@effect/sql-d1/D1Client';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import { actorOf } from '../actors.ts';
import type { Audit } from '../audit.ts';
import type { projects } from './projects.ts';
import { type Lookups, type ServiceAccountRow, ServiceAccountRowSchema } from './rows.ts';

const LAST_USED_RESOLUTION_MS = 60_000;

type NewServiceAccount = {
  readonly id: string;
  readonly name: string;
  readonly publicKey: string;
  readonly bearerHash: string;
  readonly description?: string | undefined;
  readonly expiresAt?: number | undefined;
};

/** The day a time falls on, in UTC, for a message or the log: `2026-12-01`. */
// biome-ignore lint/plugin/no-date: this Worker has no Temporal (the runtime gains one at compatibility date 2026-12-01), and one day string is not worth bundling the polyfill.
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/** Not a secret comparison (both are hashes of 256 random bits), but equal time costs nothing. */
const isSameHash = (one: string, other: string): boolean =>
  one.length === other.length &&
  Array.from(one).reduce(
    (difference, character, index) =>
      difference | (character.charCodeAt(0) ^ other.charCodeAt(index)),
    0,
  ) === 0;

export const serviceAccounts = ({
  sql,
  audit,
  grantStatement,
  lookups: { projectsOf, projectFor, ownersProject, serviceAccountIn, underLimit },
}: {
  readonly sql: D1Client.D1Client;
  readonly audit: Audit['Service'];
  readonly grantStatement: ReturnType<typeof projects>['grantStatement'];
  readonly lookups: Lookups;
}) => {
  const byBearer = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      ...ServiceAccountRowSchema.fields,
      bearerHash: Schema.String,
      parentExpiresAt: Schema.NullOr(Schema.Finite),
    }),
    // A revoked parent revokes its children with it; an expired one stops them too.
    execute: id =>
      sql`SELECT c.id, c.account_id, c.name, c.public_key, c.bearer_hash, c.parent_id,
            c.description, c.endorsement, c.welcome, c.key_voucher_owner, c.key_voucher_maker,
            c.account_voucher, c.created_at, c.last_used_at, c.expires_at,
            p.expires_at AS parent_expires_at
          FROM credential c LEFT JOIN credential p ON p.id = c.parent_id
          WHERE c.id = ${id} AND c.revoked_at IS NULL`,
  });

  const visible = SqlSchema.findAll({
    Request: Schema.Struct({ accountId: Schema.String, self: Schema.NullOr(Schema.String) }),
    Result: ServiceAccountRowSchema,
    execute: ({ accountId, self }) =>
      sql`SELECT id, account_id, name, public_key, parent_id, description, endorsement, welcome,
            key_voucher_owner, key_voucher_maker, account_voucher, created_at, last_used_at,
            expires_at
          FROM credential
          WHERE account_id = ${accountId} AND revoked_at IS NULL
            AND (${self} IS NULL OR id = ${self} OR parent_id = ${self})
          ORDER BY created_at`,
  });

  const grantsOf = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      credentialId: Schema.String,
      projectId: Schema.String,
      projectName: Schema.String,
      canWrite: Schema.Finite,
      canRead: Schema.Finite,
    }),
    execute: accountId =>
      sql`SELECT g.credential_id, g.project_id, p.name AS project_name, g.can_write,
            g.read_wrap IS NOT NULL AS can_read
          FROM project_grant g JOIN project p ON p.id = g.project_id
          WHERE g.account_id = ${accountId} AND p.archived_at IS NULL
          ORDER BY p.name`,
  });

  const accountOf = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ name: Schema.String, publicKey: Schema.String }),
    execute: accountId => sql`SELECT name, public_key FROM store_account WHERE id = ${accountId}`,
  });

  /** Each copy is sealed to one reader: the owner's to the account key, the maker's to itself. */
  const keyVoucherFor = (actor: ActorIdentity, row: ServiceAccountRow): string | null => {
    if (actor._tag === 'Owner') return row.keyVoucherOwner;
    return row.parentId === actor.credentialId ? row.keyVoucherMaker : null;
  };

  const list = Effect.fn('Access.listServiceAccounts')(function* (actor: ActorIdentity) {
    const [rows, grants] = yield* Effect.all(
      [
        visible({
          accountId: actor.accountId,
          self: actor._tag === 'ServiceAccount' ? actor.credentialId : null,
        }),
        grantsOf(actor.accountId),
      ],
      { concurrency: 2 },
    ).pipe(Effect.orDie);
    return rows.map(
      (row): ServiceAccount => ({
        id: row.id,
        name: row.name,
        publicKey: row.publicKey,
        parentId: row.parentId,
        description: row.description,
        expiresAt: row.expiresAt,
        // Only the owner's vault can read an endorsement, and only the owner acts on one.
        endorsement: actor._tag === 'Owner' ? row.endorsement : null,
        keyVoucher: keyVoucherFor(actor, row),
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        grants: grants
          .filter(grant => grant.credentialId === row.id)
          .map(({ projectId, projectName, canRead, canWrite }) => ({
            projectId,
            projectName,
            canRead: canRead !== 0,
            canWrite: canWrite !== 0,
          })),
      }),
    );
  });

  const one = Effect.fnUntraced(function* (actor: ActorIdentity, id: string) {
    const found = (yield* list(actor)).find(serviceAccount => serviceAccount.id === id);
    if (found === undefined) {
      return yield* Effect.die(`service account ${id} vanished after its write`);
    }
    return found;
  });

  const insert =
    (accountId: string, serviceAccount: NewServiceAccount, now: number) =>
    ({
      parentId = null,
      endorsement = null,
      welcome = null,
      vouchers,
    }: {
      readonly parentId?: string | null;
      readonly endorsement?: string | null;
      readonly welcome?: string | null;
      readonly vouchers?: ServiceAccountVouchers | undefined;
    }) =>
      sql`INSERT OR IGNORE INTO credential
          (id, account_id, name, public_key, bearer_hash, parent_id, description, endorsement,
           welcome, key_voucher_owner, key_voucher_maker, account_voucher, created_at, expires_at)
        VALUES (${serviceAccount.id}, ${accountId}, ${serviceAccount.name}, ${serviceAccount.publicKey},
          ${serviceAccount.bearerHash}, ${parentId}, ${serviceAccount.description ?? null},
          ${endorsement}, ${welcome}, ${vouchers?.keyToOwner ?? null},
          ${vouchers?.keyToMaker ?? null}, ${vouchers?.accountKey ?? null}, ${now},
          ${serviceAccount.expiresAt ?? null})
        RETURNING id`;

  /** Whether this request's insert is the row: an id that was taken leaves another's bearer there. */
  const madeBy = (serviceAccount: NewServiceAccount, now: number) =>
    sql`EXISTS (SELECT 1 FROM credential
                WHERE id = ${serviceAccount.id} AND created_at = ${now}
                  AND bearer_hash = ${serviceAccount.bearerHash})`;

  const taken = new AlreadyExistsError({
    message:
      'A service account with this id exists. Make a new service account key and log in again.',
  });

  /**
   * A scoped service account whose access `actor` may change: the owner, or the login that made
   * it. Never itself, so it cannot widen its own access; never another login, which cannot tell
   * its real key from one the store made up. A login's access is every project and does not change.
   */
  const changeable = Effect.fnUntraced(function* (actor: ActorIdentity, id: string) {
    const target = yield* serviceAccountIn(actor.accountId, id);
    if (target.parentId === null) {
      return yield* new OwnerRequiredError({
        message:
          'A CLI login reads and writes every project, so its access does not change. Revoke it to end it.',
      });
    }
    if (actor._tag === 'ServiceAccount' && actor.credentialId !== target.parentId) {
      return yield* new OwnerRequiredError({
        message:
          actor.credentialId === target.id
            ? 'A service account cannot change its own access. The login that made it can, or the owner from the dashboard.'
            : 'Only the login that made this service account, or the owner from the dashboard, changes its access.',
      });
    }
    return target;
  });

  return {
    authenticate: Effect.fn('Access.authenticate')(function* (bearer: Redacted.Redacted<string>) {
      const refused = new UnauthorizedError({
        message:
          'This service account key is not approved, or was revoked. Log in with `baymutt login`, after `baymutt logout` if this computer was logged in before, or check BAYMUTT_KEY.',
      });
      const parsed = yield* Effect.promise(() => parseBearer(Redacted.value(bearer)));
      if (parsed === null) return yield* refused;
      const found = yield* byBearer(parsed.credentialId).pipe(Effect.orDie);
      if (Option.isNone(found) || !isSameHash(found.value.bearerHash, parsed.bearerHash)) {
        return yield* refused;
      }
      const { id, accountId, name, parentId, expiresAt, parentExpiresAt } = found.value;
      const now = yield* Clock.currentTimeMillis;
      if (expiresAt !== null && expiresAt <= now) {
        return yield* new UnauthorizedError({
          message: `This service account expired on ${dayOf(expiresAt)}. The owner can extend it under Service accounts in the dashboard; otherwise make a new one.`,
        });
      }
      if (parentExpiresAt !== null && parentExpiresAt <= now) {
        return yield* new UnauthorizedError({
          message: `The login that made this service account expired on ${dayOf(parentExpiresAt)}, so this one stopped with it. The owner can extend that login in the dashboard.`,
        });
      }
      // Coarse on purpose: one write a minute per service account, not one a request.
      yield* sql`UPDATE credential SET last_used_at = ${now}
          WHERE id = ${id}
            AND (last_used_at IS NULL OR last_used_at < ${now - LAST_USED_RESOLUTION_MS})`.pipe(
        Effect.ignoreCause({ log: true, message: 'could not stamp a service account’s last use' }),
      );
      return {
        _tag: 'ServiceAccount',
        accountId,
        credentialId: id,
        name,
        parentId,
      } satisfies ServiceAccountActor;
    }),

    me: Effect.fn('Access.me')(function* (actor: ActorIdentity) {
      const account = yield* accountOf(actor.accountId);
      const base = {
        accountId: actor.accountId,
        accountName: account.name,
        accountPublicKey: account.publicKey,
      };
      if (actor._tag === 'Owner') return { ...base, credential: null } satisfies Me;
      const { id, name, parentId, welcome, accountVoucher } = yield* serviceAccountIn(
        actor.accountId,
        actor.credentialId,
      );
      return {
        ...base,
        credential: { id, name, parentId, welcome, accountVoucher },
      } satisfies Me;
    }, Effect.orDie),

    listServiceAccounts: list,

    pair: Effect.fn('Access.pair')(function* ({
      actor,
      serviceAccount,
      endorsement,
      welcome,
      grants,
    }: {
      readonly actor: ActorIdentity;
      readonly serviceAccount: NewServiceAccount;
      readonly endorsement: string;
      readonly welcome: string;
      /** Read and write on each project, wrapped by the owner's vault: a login holds every one. */
      readonly grants: ReadonlyArray<LoginGrant>;
    }) {
      if (actor._tag !== 'Owner') {
        return yield* new OwnerRequiredError({
          message:
            'Only the owner approves a service account, from the link `baymutt login` prints. A service account makes a narrower one with `baymutt service-accounts create`.',
        });
      }
      yield* underLimit(actor.accountId, 'serviceAccounts');
      const now = yield* Clock.currentTimeMillis;
      const made = madeBy(serviceAccount, now);
      // One batch: approved and holding its projects, or neither. A grant names a live project of
      // this account or is dropped; one made meanwhile is the dashboard's top-up to add.
      const [inserted] = yield* sql
        .batch([
          insert(actor.accountId, serviceAccount, now)({ endorsement, welcome }),
          ...grants.map(
            grant =>
              sql`INSERT INTO project_grant
                    (project_id, credential_id, account_id, can_write, read_wrap, key_proof,
                     key_version, created_at)
                  SELECT id, ${serviceAccount.id}, account_id, 1, ${grant.readWrap},
                    ${grant.keyProof}, ${grant.keyVersion}, ${now}
                  FROM project
                  WHERE id = ${grant.projectId} AND account_id = ${actor.accountId}
                    AND archived_at IS NULL AND ${made}`,
          ),
          yield* audit.entry(
            {
              accountId: actor.accountId,
              actor: actorOf(actor),
              action: 'credential.pair',
              detail: serviceAccount.name,
            },
            made,
          ),
        ])
        .pipe(Effect.orDie);
      if ((inserted ?? []).length === 0) return yield* taken;
      return yield* one(actor, serviceAccount.id);
    }),

    createServiceAccount: Effect.fn('Access.createServiceAccount')(function* ({
      actor,
      serviceAccount,
      grants,
      vouchers,
    }: {
      readonly actor: ActorIdentity;
      readonly serviceAccount: NewServiceAccount;
      readonly grants: ReadonlyArray<{
        readonly projectId: string;
        readonly canWrite: boolean;
        readonly readWrap: string | null;
        readonly keyProof: string;
      }>;
      readonly vouchers?: ServiceAccountVouchers | undefined;
    }) {
      if (actor._tag !== 'ServiceAccount' || actor.parentId !== null) {
        return yield* new OwnerRequiredError({
          message:
            actor._tag === 'Owner'
              ? 'A service account makes a narrower service account, with `baymutt service-accounts create`; the owner approves one made by `baymutt login`.'
              : 'A service account made by another service account can make no others. Run this from a service account the owner approved.',
        });
      }
      // It can hand on only what it holds: the store checks the grant, and a read is a wrap only
      // its maker, holding the project key, could have sealed.
      const held = yield* projectsOf(actor);
      for (const grant of grants) {
        const access = held.find(({ project }) => project.id === grant.projectId);
        if (access === undefined) {
          return yield* new NotFoundError({
            message: `No project ${grant.projectId} is granted to this service account.`,
          });
        }
        for (const need of ['read', 'write'] as const) {
          const wants = need === 'read' ? grant.readWrap !== null : grant.canWrite;
          const holds = need === 'read' ? access.project.canRead : access.project.canWrite;
          if (wants && !holds) {
            return yield* new NoAccessError({
              need,
              message: `This service account has no ${need} access to ${access.project.name}, so it cannot hand it on.`,
            });
          }
        }
      }
      yield* underLimit(actor.accountId, 'serviceAccounts');
      const now = yield* Clock.currentTimeMillis;
      const made = madeBy(serviceAccount, now);
      const [inserted] = yield* sql
        .batch([
          insert(actor.accountId, serviceAccount, now)({ parentId: actor.credentialId, vouchers }),
          ...grants.map(grant => {
            const keyVersion =
              held.find(({ project }) => project.id === grant.projectId)?.project.keyVersion ?? 0;
            return sql`INSERT INTO project_grant
                (project_id, credential_id, account_id, can_write, read_wrap, key_proof,
                 key_version, created_at)
              SELECT ${grant.projectId}, ${serviceAccount.id}, ${actor.accountId},
                ${grant.canWrite ? 1 : 0}, ${grant.readWrap}, ${grant.keyProof}, ${keyVersion},
                ${now}
              WHERE ${made}`;
          }),
          yield* audit.entry(
            {
              accountId: actor.accountId,
              actor: actorOf(actor),
              action: 'credential.create',
              detail: serviceAccount.name,
            },
            made,
          ),
        ])
        .pipe(Effect.orDie);
      if ((inserted ?? []).length === 0) return yield* taken;
      return yield* one(actor, serviceAccount.id);
    }),

    setAccess: Effect.fn('Access.setAccess')(function* ({
      actor,
      id,
      projectId,
      access,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly projectId: string;
      readonly access: SetAccessPayload;
    }) {
      const target = yield* changeable(actor, id);
      const { canRead, canWrite, readWrap, keyProof } = access;
      if (!canRead && !canWrite) {
        return yield* new InvalidRequestError({
          message: 'Access is read, write or both. To take the project away, remove its access.',
        });
      }
      if (!canRead && readWrap !== undefined) {
        return yield* new InvalidRequestError({
          message: 'A read wrap was sent for access that does not read.',
        });
      }
      const { project } =
        actor._tag === 'Owner'
          ? yield* ownersProject(actor, projectId)
          : yield* projectFor(actor, projectId);
      // A login hands on only what it holds, as when it made this one.
      if (actor._tag === 'ServiceAccount') {
        for (const need of ['read', 'write'] as const) {
          const wants = need === 'read' ? canRead : canWrite;
          const holds = need === 'read' ? project.canRead : project.canWrite;
          if (wants && !holds) {
            return yield* new NoAccessError({
              need,
              message: `This login has no ${need} access to ${project.name}, so it cannot hand it on.`,
            });
          }
        }
      }
      // Only what was made for the project's current key is kept.
      const [held] = yield* sql<{
        readonly readWrap: string | null;
        readonly keyProof: string;
      }>`SELECT read_wrap, key_proof FROM project_grant
          WHERE project_id = ${projectId} AND credential_id = ${id}
            AND key_version = ${project.keyVersion}`.pipe(Effect.orDie);
      // A read it gains is a wrap only a holder of the project key can make, and a project it
      // gains comes with a proof of its key: the store keeps either, and makes neither.
      const wrap = canRead ? (readWrap ?? held?.readWrap ?? null) : null;
      if (canRead && wrap === null) {
        return yield* new InvalidRequestError({
          message: `${target.name} does not read ${project.name} yet: send the project key wrapped to it (\`readWrap\`).`,
        });
      }
      const proof = keyProof ?? held?.keyProof;
      if (proof === undefined) {
        return yield* new InvalidRequestError({
          message: `${target.name} holds nothing on ${project.name} yet: send the proof of the project’s key (\`keyProof\`).`,
        });
      }
      const now = yield* Clock.currentTimeMillis;
      yield* sql
        .batch([
          grantStatement({
            accountId: actor.accountId,
            projectId,
            credentialId: id,
            canWrite,
            readWrap: wrap,
            keyProof: proof,
            keyVersion: project.keyVersion,
            now,
          }),
          yield* audit.entry({
            accountId: actor.accountId,
            actor: actorOf(actor),
            action: 'grant.set',
            projectId,
            projectName: project.name,
            detail: `${target.name}: ${[canRead && 'read', canWrite && 'write'].filter(Boolean).join(' + ')}`,
          }),
        ])
        .pipe(Effect.orDie);
      return yield* one(actor, id);
    }),

    removeAccess: Effect.fn('Access.removeAccess')(function* ({
      actor,
      id,
      projectId,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly projectId: string;
    }) {
      const target = yield* changeable(actor, id);
      // By the caller's list, not its grant: a login may take away a project it lacks itself.
      const [listed] = yield* projectsOf(actor, projectId);
      if (listed === undefined) {
        return yield* new NotFoundError({ message: 'No project has this id.' });
      }
      const held = sql`EXISTS (SELECT 1 FROM project_grant
        WHERE project_id = ${projectId} AND credential_id = ${id})`;
      yield* sql
        .batch([
          // Logged only when there was access to remove, so before the delete.
          yield* audit.entry(
            {
              accountId: actor.accountId,
              actor: actorOf(actor),
              action: 'grant.remove',
              projectId,
              projectName: listed.project.name,
              detail: target.name,
            },
            held,
          ),
          sql`DELETE FROM project_grant WHERE project_id = ${projectId} AND credential_id = ${id}`,
        ])
        .pipe(Effect.orDie);
      return yield* one(actor, id);
    }),

    setExpiry: Effect.fn('Access.setExpiry')(function* ({
      actor,
      id,
      expiresAt,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly expiresAt: number | null;
    }) {
      // Not even its own: an agent that could extend itself would outlive what the owner chose.
      if (actor._tag !== 'Owner') {
        return yield* new OwnerRequiredError({
          message: 'Only the owner changes when a service account expires, from the dashboard.',
        });
      }
      const target = yield* serviceAccountIn(actor.accountId, id);
      yield* sql
        .batch([
          sql`UPDATE credential SET expires_at = ${expiresAt}
              WHERE id = ${id} AND account_id = ${actor.accountId} AND revoked_at IS NULL`,
          yield* audit.entry({
            accountId: actor.accountId,
            actor: actorOf(actor),
            action: 'credential.expiry',
            detail: `${target.name}: ${expiresAt === null ? 'never' : dayOf(expiresAt)}`,
          }),
        ])
        .pipe(Effect.orDie);
      return yield* one(actor, id);
    }),

    revoke: Effect.fn('Access.revoke')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      const target = yield* serviceAccountIn(actor.accountId, id);
      const isOwn =
        actor._tag === 'Owner' ||
        target.id === actor.credentialId ||
        target.parentId === actor.credentialId;
      if (!isOwn) {
        return yield* new OwnerRequiredError({
          message:
            'A service account can revoke itself and the service accounts it made. The owner revokes any.',
        });
      }
      const now = yield* Clock.currentTimeMillis;
      const revokedIds = sql`SELECT id FROM credential
        WHERE (id = ${id} OR parent_id = ${id}) AND account_id = ${actor.accountId}`;
      // One batch: the bearers stop working, the wraps go, and the log says
      // so. A service account it made holds nothing its maker did not, so it goes with it.
      const [revoked] = yield* sql
        .batch([
          sql`UPDATE credential SET revoked_at = ${now}, bearer_hash = ''
              WHERE id IN (${revokedIds}) AND revoked_at IS NULL RETURNING id`,
          sql`DELETE FROM project_grant WHERE credential_id IN (${revokedIds})`,
          yield* audit.entry({
            accountId: actor.accountId,
            actor: actorOf(actor),
            action: 'credential.revoke',
            detail: target.name,
          }),
        ])
        .pipe(Effect.orDie);
      return { revoked: (revoked ?? []).map(row => String(row.id)) };
    }),
  };
};
