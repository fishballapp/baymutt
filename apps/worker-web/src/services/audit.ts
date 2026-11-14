// Owns `activity_event`, the activity log. An entry is a statement its caller puts in the same
// batch as the write it records, so the log and the change land together or not at all. Ids are
// monotonic ULIDs: two entries of one millisecond still sort in the order they were made.
import type { ActivityAction, ActivityEvent, Actor, ActorIdentity } from '@baymutt/api';
import { ActivityActionSchema } from '@baymutt/api';
import * as D1Client from '@effect/sql-d1/D1Client';
import { monotonicUlid } from '@std/ulid';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import type * as Statement from 'effect/sql/Statement';
import { orgsOf } from './access/rows.ts';
import { ActorJsonSchema, encodeActor } from './actors.ts';

/** An entry is an org's, read by its members, or an account's own: never both. */
type Scope =
  | { readonly orgId: string; readonly accountId?: never }
  | { readonly accountId: string; readonly orgId?: never };

export type AuditEntry = Scope & {
  readonly actor: Actor;
  readonly action: ActivityAction;
  readonly environmentId?: string | null;
  readonly environmentName?: string | null;
  readonly secretName?: string | null;
  readonly version?: number | null;
  readonly detail?: string | null;
};

const EventRowSchema = Schema.Struct({
  id: Schema.String,
  at: Schema.Finite,
  actor: ActorJsonSchema,
  action: ActivityActionSchema,
  orgId: Schema.NullOr(Schema.String),
  environmentId: Schema.NullOr(Schema.String),
  environmentName: Schema.NullOr(Schema.String),
  secretName: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.Finite),
  detail: Schema.NullOr(Schema.String),
});

const DEFAULT_PAGE = 50;

export class Audit extends Context.Service<
  Audit,
  {
    /**
     * The insert for one entry. `onlyIf` is a SQL condition evaluated inside the batch, for a
     * write that may not take (a compare-and-swap): the entry is written only when it holds.
     */
    readonly entry: (
      entry: AuditEntry,
      onlyIf?: Statement.Fragment,
    ) => Effect.Effect<Statement.Statement<unknown>>;
    /**
     * Newest first: the entries of the caller's orgs and of its account. The owner reads them all;
     * a credential reads what it did itself. `orgId` narrows the orgs' to one.
     */
    readonly list: (query: {
      readonly actor: ActorIdentity;
      readonly orgId?: string | undefined;
      readonly environmentId?: string | undefined;
      readonly before?: string | undefined;
      readonly limit?: number | undefined;
    }) => Effect.Effect<{
      readonly events: ReadonlyArray<ActivityEvent>;
      readonly nextBefore: string | null;
    }>;
  }
>()('@baymutt/worker-web/services/Audit') {
  static readonly layer = Layer.effect(
    Audit,
    Effect.gen(function* () {
      const sql = yield* D1Client.D1Client;

      const page = SqlSchema.findAll({
        Request: Schema.Struct({
          accountId: Schema.String,
          actorId: Schema.NullOr(Schema.String),
          orgId: Schema.NullOr(Schema.String),
          environmentId: Schema.NullOr(Schema.String),
          before: Schema.NullOr(Schema.String),
          limit: Schema.Finite,
        }),
        Result: EventRowSchema,
        execute: ({ accountId, actorId, orgId, environmentId, before, limit }) =>
          sql`SELECT id, at, actor, action, org_id, environment_id, environment_name,
                secret_name, version, detail
              FROM activity_event
              WHERE (org_id IN (${orgsOf(sql, accountId)}) OR account_id = ${accountId})
                AND (${orgId} IS NULL OR org_id = ${orgId} OR org_id IS NULL)
                AND (${actorId} IS NULL OR json_extract(actor, '$.id') = ${actorId})
                AND (${environmentId} IS NULL OR environment_id = ${environmentId})
                AND (${before} IS NULL OR id < ${before})
              ORDER BY id DESC LIMIT ${limit}`,
      });

      return Audit.of({
        entry: Effect.fn('Audit.entry')(function* (entry: AuditEntry, onlyIf?: Statement.Fragment) {
          const now = yield* Clock.currentTimeMillis;
          return sql`INSERT INTO activity_event
              (id, org_id, account_id, at, actor, action, environment_id, environment_name,
               secret_name, version, detail)
            SELECT ${monotonicUlid(now)}, ${entry.orgId ?? null}, ${entry.accountId ?? null}, ${now},
              ${encodeActor(entry.actor)},
              ${entry.action}, ${entry.environmentId ?? null}, ${entry.environmentName ?? null},
              ${entry.secretName ?? null}, ${entry.version ?? null}, ${entry.detail ?? null}
            WHERE ${onlyIf ?? sql`1 = 1`}`;
        }),

        list: Effect.fn('Audit.list')(function* ({ actor, orgId, environmentId, before, limit }) {
          const size = limit ?? DEFAULT_PAGE;
          const rows = yield* page({
            accountId: actor.accountId,
            actorId: actor._tag === 'Credential' ? actor.credentialId : null,
            orgId: orgId ?? null,
            environmentId: environmentId ?? null,
            before: before ?? null,
            // One more than asked for says whether another page follows.
            limit: size + 1,
          }).pipe(Effect.orDie);
          const events = rows.slice(0, size);
          return {
            events,
            nextBefore: rows.length > size ? (events.at(-1)?.id ?? null) : null,
          };
        }),
      });
    }),
  );
}
