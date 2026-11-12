// Owns `audit_event`. An entry is a statement its caller puts in the same batch as the write it
// records, so the log and the change land together or not at all. Ids are monotonic ULIDs: two
// entries of one millisecond still sort in the order they were made.
import type { Actor, ActorIdentity, AuditAction, AuditEvent } from '@baymutt/api';
import { AuditActionSchema } from '@baymutt/api';
import * as D1Client from '@effect/sql-d1/D1Client';
import { monotonicUlid } from '@std/ulid';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import type * as Statement from 'effect/sql/Statement';
import { ActorJsonSchema, encodeActor } from './actors.ts';

export type AuditEntry = {
  readonly accountId: string;
  readonly actor: Actor;
  readonly action: AuditAction;
  readonly projectId?: string | null;
  readonly projectName?: string | null;
  readonly secretName?: string | null;
  readonly version?: number | null;
  readonly detail?: string | null;
};

const EventRowSchema = Schema.Struct({
  id: Schema.String,
  at: Schema.Finite,
  actor: ActorJsonSchema,
  action: AuditActionSchema,
  projectId: Schema.NullOr(Schema.String),
  projectName: Schema.NullOr(Schema.String),
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
    /** Newest first. The owner reads the account's; a service account reads what it did itself. */
    readonly list: (query: {
      readonly actor: ActorIdentity;
      readonly projectId?: string | undefined;
      readonly before?: string | undefined;
      readonly limit?: number | undefined;
    }) => Effect.Effect<{
      readonly events: ReadonlyArray<AuditEvent>;
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
          projectId: Schema.NullOr(Schema.String),
          before: Schema.NullOr(Schema.String),
          limit: Schema.Finite,
        }),
        Result: EventRowSchema,
        execute: ({ accountId, actorId, projectId, before, limit }) =>
          sql`SELECT id, at, actor, action, project_id, project_name, secret_name, version, detail
              FROM audit_event
              WHERE account_id = ${accountId}
                AND (${actorId} IS NULL OR json_extract(actor, '$.id') = ${actorId})
                AND (${projectId} IS NULL OR project_id = ${projectId})
                AND (${before} IS NULL OR id < ${before})
              ORDER BY id DESC LIMIT ${limit}`,
      });

      return Audit.of({
        entry: Effect.fn('Audit.entry')(function* (entry: AuditEntry, onlyIf?: Statement.Fragment) {
          const now = yield* Clock.currentTimeMillis;
          return sql`INSERT INTO audit_event
              (id, account_id, at, actor, action, project_id, project_name, secret_name, version, detail)
            SELECT ${monotonicUlid(now)}, ${entry.accountId}, ${now}, ${encodeActor(entry.actor)},
              ${entry.action}, ${entry.projectId ?? null}, ${entry.projectName ?? null},
              ${entry.secretName ?? null}, ${entry.version ?? null}, ${entry.detail ?? null}
            WHERE ${onlyIf ?? sql`1 = 1`}`;
        }),

        list: Effect.fn('Audit.list')(function* ({ actor, projectId, before, limit }) {
          const size = limit ?? DEFAULT_PAGE;
          const rows = yield* page({
            accountId: actor.accountId,
            actorId: actor._tag === 'ServiceAccount' ? actor.credentialId : null,
            projectId: projectId ?? null,
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
