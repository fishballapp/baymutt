// Requests: what `baymutt ask access` makes. A CLI login registers a key that holds nothing and names the
// environments it wants; the owner approves (the key then holds exactly those, as a service
// account) or rejects (the key is revoked). Owns `access_request` and `access_request_item`.
import {
  type Actor,
  type ActorIdentity,
  InvalidRequestError,
  LinkSpentError,
  NotFoundError,
  OwnerRequiredError,
  REQUEST_WAIT_MS,
  type Request,
  type ServiceAccountVouchers,
} from '@baymutt/api';
import type * as D1Client from '@effect/sql-d1/D1Client';
import { eachIsolated } from '@internal/effect-worker';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import type * as Statement from 'effect/sql/Statement';
import { actorOf } from '../actors.ts';
import type { Audit } from '../audit.ts';
import { grantStatement, isLogin, type Lookups, namesNotSealed, orgsOf } from './rows.ts';
import {
  credentialTaken,
  dayOf,
  insertCredential,
  madeBy,
  type NewServiceAccount,
  revokeStatements,
} from './service-accounts.ts';

/** Who expires a request nobody answered, and ends a key whose time is up. */
const SYSTEM_ACTOR: Actor = { kind: 'system', id: 'requests', name: 'baymutt' };

type Access = { readonly canRead: boolean; readonly canWrite: boolean };

export type RequestItemPayload = Access & { readonly environmentId: string };

export type Approval = {
  readonly expiresAt: number | null;
  readonly grants: ReadonlyArray<{
    readonly environmentId: string;
    readonly readWrap: string | null;
    readonly keyProof: string;
    readonly keyVersion: number;
  }>;
  readonly namesKeyWraps: ReadonlyArray<{ readonly orgId: string; readonly wrap: string }>;
};

const RequestRowSchema = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  name: Schema.String,
  reason: Schema.String,
  publicKey: Schema.String,
  keyVoucherOwner: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.Finite),
  status: Schema.Literals(['pending', 'approved', 'rejected', 'expired']),
  command: Schema.NullOr(Schema.String),
  lifetime: Schema.NullOr(Schema.Finite),
  createdAt: Schema.Finite,
  resolvedAt: Schema.NullOr(Schema.Finite),
  makerId: Schema.String,
  makerName: Schema.String,
  makerPublicKey: Schema.String,
  makerEndorsement: Schema.NullOr(Schema.String),
});
type RequestRow = typeof RequestRowSchema.Type;

const ItemRowSchema = Schema.Struct({
  requestId: Schema.String,
  environmentId: Schema.String,
  orgId: Schema.String,
  orgSlug: Schema.String,
  environmentName: Schema.String,
  environmentSealedName: Schema.NullOr(Schema.String),
  canRead: Schema.Finite,
  canWrite: Schema.Finite,
});

/** What approving checks an item against, as the store holds it now. */
const StoredItemSchema = Schema.Struct({
  environmentId: Schema.String,
  canRead: Schema.Finite,
  canWrite: Schema.Finite,
  /** The environment's own, while it exists. */
  orgId: Schema.NullOr(Schema.String),
  keyVersion: Schema.NullOr(Schema.Finite),
  isDeleted: Schema.NullOr(Schema.Finite),
});

const RequestQuerySchema = Schema.Struct({
  accountId: Schema.String,
  id: Schema.NullOr(Schema.String),
  makerId: Schema.NullOr(Schema.String),
  isPendingOnly: Schema.Boolean,
  /** A pending request made at or before this has expired, whatever its row still says. */
  expiredBy: Schema.Finite,
});
type RequestQuery = typeof RequestQuerySchema.Type;

const access = ({ canRead, canWrite }: Access) =>
  [canRead && 'read', canWrite && 'write'].filter(Boolean).join(' + ');

/** Items stand for whole sets of rows: bound as one JSON parameter, as D1 binds 100 at most. */
const asJson = (rows: ReadonlyArray<unknown>) => JSON.stringify(rows);

export const requests = ({
  sql,
  audit,
  lookups: { underLimit, ownedOrg },
}: {
  readonly sql: D1Client.D1Client;
  readonly audit: Audit['Service'];
  readonly lookups: Lookups;
}) => {
  const matching = ({ accountId, id, makerId, isPendingOnly, expiredBy }: RequestQuery) =>
    sql`c.account_id = ${accountId}
      AND (${id} IS NULL OR r.credential_id = ${id})
      AND (${makerId} IS NULL OR c.parent_id = ${makerId})
      AND (${isPendingOnly ? 1 : 0} = 0 OR (r.status = 'pending' AND r.created_at > ${expiredBy}))`;

  const requestRows = SqlSchema.findAll({
    Request: RequestQuerySchema,
    Result: RequestRowSchema,
    execute: query =>
      sql`SELECT c.id, c.account_id, c.name, c.description AS reason, c.public_key,
            c.key_voucher_owner, c.expires_at, r.status, r.command, r.lifetime, r.created_at,
            r.resolved_at, p.id AS maker_id, p.name AS maker_name,
            p.public_key AS maker_public_key, p.endorsement AS maker_endorsement
          FROM access_request r
          JOIN credential c ON c.id = r.credential_id
          JOIN credential p ON p.id = c.parent_id
          WHERE ${matching(query)}
          ORDER BY r.created_at`,
  });

  // An environment removed for good is no longer shown.
  const itemRows = SqlSchema.findAll({
    Request: RequestQuerySchema,
    Result: ItemRowSchema,
    execute: query =>
      sql`SELECT i.credential_id AS request_id, i.environment_id, e.org_id, o.slug AS org_slug,
            e.name AS environment_name, e.sealed_name AS environment_sealed_name, i.can_read,
            i.can_write
          FROM access_request_item i
          JOIN access_request r ON r.credential_id = i.credential_id
          JOIN credential c ON c.id = r.credential_id
          JOIN environment e ON e.id = i.environment_id
          JOIN organization o ON o.id = e.org_id
          WHERE ${matching(query)}
          ORDER BY o.slug, environment_name`,
  });

  const storedItems = SqlSchema.findAll({
    Request: Schema.String,
    Result: StoredItemSchema,
    execute: id =>
      sql`SELECT i.environment_id, i.can_read, i.can_write, e.org_id, e.key_version,
            e.deleted_at IS NOT NULL AS is_deleted
          FROM access_request_item i LEFT JOIN environment e ON e.id = i.environment_id
          WHERE i.credential_id = ${id}`,
  });

  /** The live environments of the person's orgs among `ids`. */
  const liveEnvironments = SqlSchema.findAll({
    Request: Schema.Struct({ accountId: Schema.String, ids: Schema.String }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ accountId, ids }) =>
      sql`SELECT id FROM environment
          WHERE id IN (SELECT value FROM json_each(${ids}))
            AND org_id IN (${orgsOf(sql, accountId)}) AND deleted_at IS NULL`,
  });

  const toRequest = (
    actor: ActorIdentity,
    row: RequestRow,
    items: ReadonlyArray<typeof ItemRowSchema.Type>,
    expiredBy: number,
  ): Request => {
    const isOwner = actor._tag === 'Owner';
    // Expired the moment its hour is up: the daily run only tidies its row and its key away.
    const hasExpired =
      row.status === 'expired' || (row.status === 'pending' && row.createdAt <= expiredBy);
    return {
      id: row.id,
      name: row.name,
      reason: row.reason,
      status: hasExpired ? 'expired' : row.status,
      command: row.command,
      lifetime: row.lifetime,
      expiresAt: row.status === 'approved' ? row.expiresAt : null,
      items: items
        .filter(item => item.requestId === row.id)
        .map(({ requestId: _, canRead, canWrite, ...item }) => ({
          ...item,
          canRead: canRead !== 0,
          canWrite: canWrite !== 0,
        })),
      publicKey: row.publicKey,
      // Sealed to the account key: only the owner's browser opens it, and only it needs to.
      keyVoucher: isOwner ? row.keyVoucherOwner : null,
      maker: {
        id: row.makerId,
        name: row.makerName,
        publicKey: row.makerPublicKey,
        endorsement: isOwner ? row.makerEndorsement : null,
      },
      createdAt: row.createdAt,
      resolvedAt: hasExpired ? row.createdAt + REQUEST_WAIT_MS : row.resolvedAt,
    };
  };

  const find = Effect.fnUntraced(function* (
    actor: ActorIdentity,
    filter: Omit<RequestQuery, 'expiredBy'>,
  ) {
    const query = { ...filter, expiredBy: (yield* Clock.currentTimeMillis) - REQUEST_WAIT_MS };
    const [rows, items] = yield* Effect.all([requestRows(query), itemRows(query)], {
      concurrency: 2,
    }).pipe(Effect.orDie);
    return rows.map(row => toRequest(actor, row, items, query.expiredBy));
  });

  /** A request the caller may see: the owner any, a CLI login those it made, a key its own. */
  const visible = Effect.fnUntraced(function* (actor: ActorIdentity, id: string) {
    const [found] = yield* find(actor, {
      accountId: actor.accountId,
      id,
      makerId: isLogin(actor) && actor._tag === 'Credential' ? actor.credentialId : null,
      isPendingOnly: false,
    });
    const isOwnKey = actor._tag === 'Credential' && actor.credentialId === id;
    if (found === undefined || (actor._tag === 'Credential' && !isLogin(actor) && !isOwnKey)) {
      return yield* new NotFoundError({
        message: 'No request of yours has this id.',
      });
    }
    return found;
  });

  const answered = (request: Request) =>
    new LinkSpentError({
      message:
        request.status === 'expired'
          ? 'This request expired: nobody answered it within an hour. Its maker asks again.'
          : `This request was already ${request.status}.`,
    });

  /** Still waiting for an answer at `now`: pending, and not past its hour. */
  const isPending = (id: string, now: number) =>
    sql`EXISTS (SELECT 1 FROM access_request WHERE credential_id = ${id} AND status = 'pending'
      AND created_at > ${now - REQUEST_WAIT_MS})`;

  /** The statements that close a pending request unapproved: logged first, while it is still pending. */
  const rejectStatements = Effect.fnUntraced(function* ({
    id,
    accountId,
    actor,
    detail,
    outcome,
    now,
    onlyIf,
  }: {
    readonly id: string;
    readonly accountId: string;
    readonly actor: Actor;
    readonly detail: string;
    readonly outcome: 'rejected' | 'expired';
    readonly now: number;
    readonly onlyIf: Statement.Fragment;
  }) {
    const action = outcome === 'rejected' ? 'request.reject' : 'request.expire';
    return [
      yield* audit.entry({ accountId, actor, action, detail }, onlyIf),
      ...revokeStatements(sql, {
        ids: sql`SELECT id FROM credential WHERE id = ${id}`,
        now,
        request: outcome,
        onlyIf,
      }),
    ];
  });

  const pendingFor = SqlSchema.findAll({
    Request: Schema.Finite,
    Result: Schema.Struct({ id: Schema.String, accountId: Schema.String, name: Schema.String }),
    execute: createdBy =>
      sql`SELECT r.credential_id AS id, c.account_id, c.name FROM access_request r
          JOIN credential c ON c.id = r.credential_id
          WHERE r.status = 'pending' AND r.created_at <= ${createdBy}`,
  });

  const endedKeys = SqlSchema.findAll({
    Request: Schema.Finite,
    Result: Schema.Struct({
      id: Schema.String,
      accountId: Schema.String,
      name: Schema.String,
      expiresAt: Schema.Finite,
    }),
    execute: now =>
      sql`SELECT c.id, c.account_id, c.name, c.expires_at FROM credential c
          JOIN access_request r ON r.credential_id = c.id
          WHERE r.status = 'approved' AND c.revoked_at IS NULL
            AND c.expires_at IS NOT NULL AND c.expires_at <= ${now}`,
  });

  return {
    listRequests: Effect.fn('Access.listRequests')(function* (actor: ActorIdentity) {
      if (actor._tag === 'Credential' && !isLogin(actor)) return [];
      return yield* find(actor, {
        accountId: actor.accountId,
        id: null,
        makerId: actor._tag === 'Credential' ? actor.credentialId : null,
        isPendingOnly: true,
      });
    }),

    getRequest: Effect.fn('Access.getRequest')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      return yield* visible(actor, id);
    }),

    createRequest: Effect.fn('Access.createRequest')(function* ({
      actor,
      key,
      vouchers,
      reason,
      command,
      lifetime,
      items,
    }: {
      readonly actor: ActorIdentity;
      readonly key: Omit<NewServiceAccount, 'description' | 'expiresAt'>;
      readonly vouchers: ServiceAccountVouchers;
      readonly reason: string;
      readonly command: string | null;
      readonly lifetime: number | null;
      readonly items: ReadonlyArray<RequestItemPayload>;
    }) {
      if (actor._tag !== 'Credential' || !isLogin(actor)) {
        return yield* new OwnerRequiredError({
          message:
            actor._tag === 'Owner'
              ? 'A request is a CLI login’s. The owner gives a service account access from the dashboard.'
              : 'A service account cannot ask for access. Ask from a CLI login: `baymutt ask access`.',
        });
      }
      const ids = items.map(item => item.environmentId);
      if (new Set(ids).size !== ids.length) {
        return yield* new InvalidRequestError({
          message: 'A request names each environment once.',
        });
      }
      if (items.some(({ canRead, canWrite }) => !canRead && !canWrite)) {
        return yield* new InvalidRequestError({
          message: 'Each environment a request names is asked for read, write or both.',
        });
      }
      const live = yield* liveEnvironments({ accountId: actor.accountId, ids: asJson(ids) }).pipe(
        Effect.orDie,
      );
      if (live.length !== ids.length) {
        return yield* new NotFoundError({
          message:
            'A request names an environment that is not a live environment of your orgs. List them with `baymutt env list`; a new one is asked for with `baymutt ask create-environment`.',
        });
      }
      yield* underLimit(actor.accountId, 'serviceAccounts');
      const now = yield* Clock.currentTimeMillis;
      const credential = { ...key, description: reason };
      const made = madeBy(sql, credential, now);
      // One batch: the key, which holds nothing until the owner approves, and the request.
      const [inserted] = yield* sql
        .batch([
          insertCredential(sql, {
            accountId: actor.accountId,
            credential,
            now,
            parentId: actor.credentialId,
            vouchers,
            // A key piped into a command is for another system, one kept in a file for the agent.
            intent: command === null ? 'agent' : 'service-account',
          }),
          sql`INSERT INTO access_request (credential_id, status, command, lifetime, created_at)
              SELECT ${key.id}, 'pending', ${command}, ${lifetime}, ${now} WHERE ${made}`,
          ...items.map(
            item =>
              sql`INSERT INTO access_request_item (credential_id, environment_id, can_read, can_write)
                  SELECT ${key.id}, ${item.environmentId}, ${item.canRead ? 1 : 0},
                    ${item.canWrite ? 1 : 0}
                  WHERE ${made}`,
          ),
          yield* audit.entry(
            {
              accountId: actor.accountId,
              actor: actorOf(actor),
              action: 'request.create',
              detail: key.name,
            },
            made,
          ),
        ])
        .pipe(Effect.orDie);
      if ((inserted ?? []).length === 0) return yield* credentialTaken();
      return yield* visible(actor, key.id).pipe(Effect.orDie);
    }),

    approveRequest: Effect.fn('Access.approveRequest')(function* ({
      actor,
      id,
      approval,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly approval: Approval;
    }) {
      if (actor._tag !== 'Owner') {
        return yield* new OwnerRequiredError({
          message: 'Only the owner approves a request, from the dashboard.',
        });
      }
      const request = yield* visible(actor, id);
      if (request.status !== 'pending') return yield* answered(request);
      const items = yield* storedItems(id).pipe(Effect.orDie);
      const mismatch = (what: string) =>
        new InvalidRequestError({
          message: `The approval does not match the request: ${what}. Read the request again and approve what it names.`,
        });

      const grants = new Map(approval.grants.map(grant => [grant.environmentId, grant]));
      if (grants.size !== approval.grants.length || grants.size !== items.length) {
        return yield* mismatch('one answer per environment it names');
      }
      for (const item of items) {
        if (item.orgId === null || item.isDeleted !== 0) {
          return yield* new NotFoundError({
            message:
              'An environment this request names was deleted since. Reject it; the CLI login can ask again.',
          });
        }
        const grant = grants.get(item.environmentId);
        if (grant === undefined) return yield* mismatch('an answer for each environment it names');
        if ((grant.readWrap !== null) !== (item.canRead !== 0)) {
          return yield* mismatch('read access exactly where it asked to read');
        }
        if (grant.keyVersion !== item.keyVersion) {
          return yield* mismatch('each environment answered for its current key version');
        }
      }
      const orgIds = new Set(items.map(item => item.orgId ?? ''));
      const namesKeyWraps = new Map(approval.namesKeyWraps.map(wrap => [wrap.orgId, wrap.wrap]));
      if (
        namesKeyWraps.size !== approval.namesKeyWraps.length ||
        !orgIds.isSubsetOf(new Set(namesKeyWraps.keys())) ||
        namesKeyWraps.size !== orgIds.size
      ) {
        return yield* mismatch('the names of each org it reaches, and of no other');
      }
      for (const orgId of orgIds) {
        const org = yield* ownedOrg(actor, orgId, 'approves access to its environments');
        if (!org.areNamesSealed) return yield* namesNotSealed(org.slug);
      }

      const now = yield* Clock.currentTimeMillis;
      const by = actorOf(actor);
      const pending = isPending(id, now);
      // One batch: the grants, the names keys and the expiry, logged as the environments' own
      // activity shows them, then the request is marked approved. A batch that loses to another
      // answer changes nothing.
      const results = yield* sql
        .batch([
          ...approval.grants.map(grant => {
            const item = items.find(({ environmentId }) => environmentId === grant.environmentId);
            return grantStatement(
              sql,
              { ...grant, credentialId: id, canWrite: item?.canWrite === 1, now },
              pending,
            );
          }),
          ...[...namesKeyWraps].map(
            ([orgId, wrap]) =>
              sql`INSERT INTO names_key_wrap (org_id, reader_id, wrap, created_at)
                  SELECT ${orgId}, ${id}, ${wrap}, ${now} WHERE ${pending}
                  ON CONFLICT (org_id, reader_id) DO UPDATE SET wrap = excluded.wrap`,
          ),
          sql`UPDATE credential SET expires_at = ${approval.expiresAt}
              WHERE id = ${id} AND ${pending}`,
          ...(yield* Effect.forEach(
            items,
            item =>
              audit.entry(
                {
                  orgId: item.orgId ?? '',
                  actor: by,
                  action: 'grant.set',
                  environmentId: item.environmentId,
                  detail: `${request.name}: ${access({ canRead: item.canRead !== 0, canWrite: item.canWrite !== 0 })}`,
                },
                pending,
              ),
            { concurrency: 1 },
          )),
          yield* audit.entry(
            {
              accountId: actor.accountId,
              actor: by,
              action: 'request.approve',
              detail: `${request.name}: ${approval.expiresAt === null ? 'no end' : `until ${dayOf(approval.expiresAt)}`}`,
            },
            pending,
          ),
          sql`UPDATE access_request SET status = 'approved', resolved_at = ${now}
              WHERE credential_id = ${id} AND ${pending} RETURNING credential_id`,
        ])
        .pipe(Effect.orDie);
      if ((results.at(-1) ?? []).length === 0) {
        return yield* answered(yield* visible(actor, id).pipe(Effect.orDie));
      }
      return yield* visible(actor, id).pipe(Effect.orDie);
    }),

    rejectRequest: Effect.fn('Access.rejectRequest')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      const request = yield* visible(actor, id);
      if (actor._tag === 'Credential' && actor.credentialId !== request.maker.id) {
        return yield* new OwnerRequiredError({
          message: 'Only the owner or the CLI login that asked rejects a request.',
        });
      }
      if (request.status !== 'pending') return yield* answered(request);
      const now = yield* Clock.currentTimeMillis;
      const [, revoked] = yield* sql
        .batch(
          yield* rejectStatements({
            id,
            accountId: actor.accountId,
            actor: actorOf(actor),
            detail: request.name,
            outcome: 'rejected',
            now,
            onlyIf: isPending(id, now),
          }),
        )
        .pipe(Effect.orDie);
      if ((revoked ?? []).length === 0) {
        return yield* answered(yield* visible(actor, id).pipe(Effect.orDie));
      }
      return yield* visible(actor, id).pipe(Effect.orDie);
    }),

    /**
     * The daily run's part. A request nobody answered in `REQUEST_WAIT_MS` has expired already,
     * as everything that reads it sees: here its row says so and its key is revoked. An approved
     * key whose time is up is revoked too. One that fails is logged and left for tomorrow.
     */
    sweepRequests: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cutoff = now - REQUEST_WAIT_MS;
      const unanswered = yield* pendingFor(cutoff).pipe(Effect.orDie);
      yield* eachIsolated({
        sweep: 'unanswered request',
        rows: unanswered,
        run: request =>
          Effect.gen(function* () {
            const onlyIf = sql`EXISTS (SELECT 1 FROM access_request
              WHERE credential_id = ${request.id} AND status = 'pending'
                AND created_at <= ${cutoff})`;
            yield* sql
              .batch(
                yield* rejectStatements({
                  id: request.id,
                  accountId: request.accountId,
                  actor: SYSTEM_ACTOR,
                  detail: request.name,
                  outcome: 'expired',
                  now,
                  onlyIf,
                }),
              )
              .pipe(Effect.orDie);
          }),
      });
      const ended = yield* endedKeys(now).pipe(Effect.orDie);
      yield* eachIsolated({
        sweep: 'ended key',
        rows: ended,
        run: key =>
          Effect.gen(function* () {
            // Revoking sets `revoked_at` first, so the rest of the batch is conditioned on what
            // it does not change.
            const isOver = sql`EXISTS (SELECT 1 FROM credential
              WHERE id = ${key.id} AND expires_at IS NOT NULL AND expires_at <= ${now})`;
            yield* sql
              .batch([
                yield* audit.entry(
                  {
                    accountId: key.accountId,
                    actor: SYSTEM_ACTOR,
                    action: 'credential.revoke',
                    detail: `${key.name}: ended on ${dayOf(key.expiresAt)}`,
                  },
                  sql`${isOver} AND EXISTS (SELECT 1 FROM credential
                    WHERE id = ${key.id} AND revoked_at IS NULL)`,
                ),
                ...revokeStatements(sql, {
                  ids: sql`SELECT id FROM credential WHERE id = ${key.id}`,
                  now,
                  onlyIf: isOver,
                }),
              ])
              .pipe(Effect.orDie);
          }),
      });
      yield* Effect.logInfo('requests swept', {
        expired: unanswered.length,
        ended: ended.length,
      });
      return { expired: unanswered.length, ended: ended.length };
    }).pipe(Effect.withSpan('Access.sweepRequests')),
  };
};
