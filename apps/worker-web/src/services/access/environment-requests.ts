// Environment requests: what `baymutt ask create-environment` makes. A CLI login names a new
// environment by the id and sealed name it is to have, and why; the owner approves by creating it
// (`createEnvironment` with `answers`) or rejects it. It gives nobody access. Owns
// `environment_request`.
import {
  type ActorIdentity,
  AlreadyExistsError,
  ENVIRONMENT_REQUEST_WAIT_MS,
  type EnvironmentRequest,
  LimitReachedError,
  LinkSpentError,
  NotFoundError,
  OwnerRequiredError,
} from '@baymutt/api';
import type * as D1Client from '@effect/sql-d1/D1Client';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import { ActorJsonSchema, actorOf, encodeActor } from '../actors.ts';
import type { Audit } from '../audit.ts';
import { isLogin, type Lookups, namesNotSealed, orgsOf } from './rows.ts';

/** At most this many wait for the owner per account, so one CLI login cannot fill their screen. */
const WAITING_LIMIT = 20;

const RowSchema = Schema.Struct({
  id: Schema.String,
  orgId: Schema.String,
  orgSlug: Schema.String,
  name: Schema.String,
  sealedName: Schema.String,
  reason: Schema.String,
  status: Schema.Literals(['pending', 'approved', 'rejected']),
  createdBy: ActorJsonSchema,
  createdAt: Schema.Finite,
  resolvedAt: Schema.NullOr(Schema.Finite),
});

const QuerySchema = Schema.Struct({
  accountId: Schema.String,
  id: Schema.NullOr(Schema.String),
  /** The CLI login that made it; null for the owner, who sees every one in their orgs. */
  createdBy: Schema.NullOr(Schema.String),
  isWaitingOnly: Schema.Boolean,
  /** A pending request made at or before this has expired, whatever its row still says. */
  expiredBy: Schema.Finite,
});

/** Whether request `id` is still waiting at `now`: pending, and not past its hour. */
export const isWaiting = (sql: D1Client.D1Client, id: string, now: number) =>
  sql`EXISTS (SELECT 1 FROM environment_request WHERE id = ${id} AND status = 'pending'
    AND created_at > ${now - ENVIRONMENT_REQUEST_WAIT_MS})`;

export const spent = (request: EnvironmentRequest) =>
  new LinkSpentError({
    message:
      request.status === 'expired'
        ? 'This environment request expired: nobody answered it within an hour. Its CLI login asks again with `baymutt ask create-environment`.'
        : `This environment request was already ${request.status}.`,
  });

/** How environment requests are read, here and by `createEnvironment`, which approves one. */
export const environmentRequestRows = (sql: D1Client.D1Client) => {
  const storedRows = SqlSchema.findAll({
    Request: QuerySchema,
    Result: RowSchema,
    execute: ({ accountId, id, createdBy, isWaitingOnly, expiredBy }) =>
      sql`SELECT r.id, r.org_id, o.slug AS org_slug, r.name, r.sealed_name, r.reason, r.status,
            r.created_by, r.created_at, r.resolved_at
          FROM environment_request r JOIN organization o ON o.id = r.org_id
          WHERE r.org_id IN (${orgsOf(sql, accountId)})
            AND (${id} IS NULL OR r.id = ${id})
            AND (${createdBy} IS NULL OR json_extract(r.created_by, '$.id') = ${createdBy})
            AND (${isWaitingOnly ? 1 : 0} = 0
              OR (r.status = 'pending' AND r.created_at > ${expiredBy}))
          ORDER BY r.created_at`,
  });

  /** Requests as they stand now: one still pending past its hour is expired from that moment. */
  const find = Effect.fnUntraced(function* (filter: Omit<typeof QuerySchema.Type, 'expiredBy'>) {
    const expiredBy = (yield* Clock.currentTimeMillis) - ENVIRONMENT_REQUEST_WAIT_MS;
    const rows = yield* storedRows({ ...filter, expiredBy }).pipe(Effect.orDie);
    return rows.map(({ status, resolvedAt, ...row }): EnvironmentRequest => {
      const hasExpired = status === 'pending' && row.createdAt <= expiredBy;
      return {
        ...row,
        status: hasExpired ? 'expired' : status,
        resolvedAt: hasExpired ? row.createdAt + ENVIRONMENT_REQUEST_WAIT_MS : resolvedAt,
      };
    });
  });

  /** A request the caller may see: the owner any in their orgs, a CLI login those it made. */
  const visible = Effect.fnUntraced(function* (actor: ActorIdentity, id: string) {
    const notFound = new NotFoundError({ message: 'No environment request of yours has this id.' });
    if (actor._tag === 'Credential' && !isLogin(actor)) return yield* notFound;
    const [found] = yield* find({
      accountId: actor.accountId,
      id,
      createdBy: actor._tag === 'Credential' ? actor.credentialId : null,
      isWaitingOnly: false,
    });
    if (found === undefined) return yield* notFound;
    return found;
  });

  return { find, visible };
};

export const environmentRequests = ({
  sql,
  audit,
  lookups: { memberOrg, nameTaken },
}: {
  readonly sql: D1Client.D1Client;
  readonly audit: Audit['Service'];
  readonly lookups: Lookups;
}) => {
  const { find, visible } = environmentRequestRows(sql);

  /** An environment, live or in the bin, that has this id, or this name in this org. */
  const isTaken = ({ id, orgId, name }: { id: string; orgId: string; name: string }) =>
    sql`EXISTS (SELECT 1 FROM environment WHERE id = ${id} OR (org_id = ${orgId} AND name = ${name}))`;

  const environmentExists = Effect.fnUntraced(function* (request: {
    id: string;
    orgId: string;
    name: string;
  }) {
    const [row] = yield* sql<{
      readonly isTaken: number;
    }>`SELECT ${isTaken(request)} AS is_taken`.pipe(Effect.orDie);
    return row?.isTaken === 1;
  });

  /** Those waiting in the account's orgs, but for any the new one replaces. */
  const waitingBesides = Effect.fnUntraced(function* ({
    accountId,
    orgId,
    name,
    now,
  }: {
    readonly accountId: string;
    readonly orgId: string;
    readonly name: string;
    readonly now: number;
  }) {
    const [row] = yield* sql<{ readonly waiting: number }>`SELECT COUNT(*) AS waiting
      FROM environment_request
      WHERE org_id IN (${orgsOf(sql, accountId)}) AND status = 'pending'
        AND created_at > ${now - ENVIRONMENT_REQUEST_WAIT_MS}
        AND NOT (org_id = ${orgId} AND name = ${name})`.pipe(Effect.orDie);
    return Number(row?.waiting ?? 0);
  });

  return {
    listEnvironmentRequests: Effect.fn('Access.listEnvironmentRequests')(function* (
      actor: ActorIdentity,
    ) {
      if (actor._tag === 'Credential' && !isLogin(actor)) return [];
      return yield* find({
        accountId: actor.accountId,
        id: null,
        createdBy: actor._tag === 'Credential' ? actor.credentialId : null,
        isWaitingOnly: true,
      });
    }),

    getEnvironmentRequest: Effect.fn('Access.getEnvironmentRequest')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      return yield* visible(actor, id);
    }),

    createEnvironmentRequest: Effect.fn('Access.createEnvironmentRequest')(function* ({
      actor,
      request,
    }: {
      readonly actor: ActorIdentity;
      readonly request: {
        readonly id: string;
        readonly orgId: string;
        readonly name: string;
        readonly sealedName: string;
        readonly reason: string;
      };
    }) {
      if (actor._tag !== 'Credential' || !isLogin(actor)) {
        return yield* new OwnerRequiredError({
          message:
            actor._tag === 'Owner'
              ? 'An environment request is a CLI login’s. The owner creates an environment in the dashboard.'
              : 'A service account cannot ask for an environment. Ask from a CLI login: `baymutt ask create-environment`.',
        });
      }
      const org = yield* memberOrg(actor, request.orgId);
      if (!org.areNamesSealed) return yield* namesNotSealed(org.slug);
      if (yield* environmentExists(request)) {
        return yield* yield* nameTaken({ ...request, orgSlug: org.slug });
      }
      const now = yield* Clock.currentTimeMillis;
      // Counted before the write, so two at once can overshoot by one: a cap on growth.
      if (
        (yield* waitingBesides({ accountId: actor.accountId, ...request, now })) >= WAITING_LIMIT
      ) {
        return yield* new LimitReachedError({
          limit: WAITING_LIMIT,
          message: `Up to ${WAITING_LIMIT} environment requests wait for the owner at once. Cancel one with \`baymutt ask cancel <id>\`, or wait for the owner to answer.`,
        });
      }
      const by = encodeActor(actorOf(actor));
      const took = sql`EXISTS (SELECT 1 FROM environment_request
        WHERE id = ${request.id} AND created_at = ${now} AND created_by = ${by})`;
      const [inserted] = yield* sql
        .batch([
          sql`INSERT OR IGNORE INTO environment_request
                (id, org_id, name, sealed_name, reason, status, created_by, created_at)
              SELECT ${request.id}, ${request.orgId}, ${request.name}, ${request.sealedName},
                ${request.reason}, 'pending', ${by}, ${now}
              WHERE NOT ${isTaken(request)}
              RETURNING id`,
          // A new request replaces the earlier one for the same name: the owner sees one.
          sql`UPDATE environment_request SET status = 'rejected', resolved_at = ${now}
              WHERE org_id = ${request.orgId} AND name = ${request.name} AND status = 'pending'
                AND created_at > ${now - ENVIRONMENT_REQUEST_WAIT_MS} AND id != ${request.id}
                AND ${took}`,
          yield* audit.entry(
            {
              orgId: request.orgId,
              actor: actorOf(actor),
              action: 'environment-request.create',
              environmentId: request.id,
              environmentName: request.name,
              environmentSealedName: request.sealedName,
              detail: request.reason,
            },
            took,
          ),
        ])
        .pipe(Effect.orDie);
      if ((inserted ?? []).length === 0) {
        if (yield* environmentExists(request)) {
          return yield* yield* nameTaken({ ...request, orgSlug: org.slug });
        }
        return yield* new AlreadyExistsError({
          message: 'An environment request with this id exists. Make a new id and try again.',
        });
      }
      return yield* visible(actor, request.id).pipe(Effect.orDie);
    }),

    rejectEnvironmentRequest: Effect.fn('Access.rejectEnvironmentRequest')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      // A CLI login sees only those it made, so one it reaches is its own to withdraw.
      const request = yield* visible(actor, id);
      if (actor._tag === 'Owner' && (yield* memberOrg(actor, request.orgId)).role !== 'owner') {
        return yield* new OwnerRequiredError({
          message: `Only an owner of ${request.orgSlug} or the CLI login that asked rejects an environment request.`,
        });
      }
      if (request.status !== 'pending') return yield* spent(request);
      const now = yield* Clock.currentTimeMillis;
      const waiting = isWaiting(sql, id, now);
      // Logged first, while it is still waiting.
      const [, rejected] = yield* sql
        .batch([
          yield* audit.entry(
            {
              orgId: request.orgId,
              actor: actorOf(actor),
              action: 'environment-request.reject',
              environmentId: id,
              environmentName: request.name,
              environmentSealedName: request.sealedName,
            },
            waiting,
          ),
          sql`UPDATE environment_request SET status = 'rejected', resolved_at = ${now}
              WHERE id = ${id} AND ${waiting} RETURNING id`,
        ])
        .pipe(Effect.orDie);
      if ((rejected ?? []).length === 0) {
        return yield* spent(yield* visible(actor, id).pipe(Effect.orDie));
      }
      return yield* visible(actor, id).pipe(Effect.orDie);
    }),
  };
};
