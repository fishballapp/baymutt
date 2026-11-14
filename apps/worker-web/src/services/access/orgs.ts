// Orgs: what environments belong to. The organization plugin owns the `organization` and `member`
// rows and creates them; baymutt reads them, and deletes an org that holds nothing.
import {
  type ActorIdentity,
  NotEmptyError,
  NotFoundError,
  type Org,
  OwnerRequiredError,
} from '@baymutt/api';
import type * as D1Client from '@effect/sql-d1/D1Client';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import type { Auth } from '../../platform/auth.ts';
import { actorOf } from '../actors.ts';
import type { Audit } from '../audit.ts';
import { isLogin, type Lookups } from './rows.ts';

const OrgRowSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  role: Schema.String,
  environmentCount: Schema.Finite,
  // The plugin stores a date as text; D1 answers it as written.
  createdAt: Schema.String,
});

// biome-ignore lint/plugin/no-date: this Worker has no Temporal (the runtime gains one at compatibility date 2026-12-01), and parsing the plugin's ISO timestamp is all this needs.
const epochMillis = (iso: string) => new Date(iso).getTime();

export const orgs = ({
  sql,
  audit,
  auth,
  lookups: { underLimit },
}: {
  readonly sql: D1Client.D1Client;
  readonly audit: Audit['Service'];
  readonly auth: Auth['Service'];
  readonly lookups: Lookups;
}) => {
  /**
   * The person's orgs, for the owner and a CLI login; for a service account, the orgs of the
   * environments it holds.
   */
  const rows = SqlSchema.findAll({
    Request: Schema.Struct({
      accountId: Schema.String,
      credentialId: Schema.NullOr(Schema.String),
    }),
    Result: OrgRowSchema,
    execute: ({ accountId, credentialId }) =>
      sql`SELECT o.id, o.name, o.slug, m.role, o.createdAt AS created_at,
            (SELECT COUNT(*) FROM environment e
              WHERE e.org_id = o.id AND e.deleted_at IS NULL) AS environment_count
          FROM organization o
          JOIN member m ON m.organizationId = o.id
          JOIN store_account a ON a.user_id = m.userId AND a.id = ${accountId}
          WHERE ${credentialId} IS NULL
            OR o.id IN (SELECT e.org_id FROM environment e
                        JOIN environment_grant g ON g.environment_id = e.id
                        WHERE g.credential_id = ${credentialId} AND e.deleted_at IS NULL)
          ORDER BY o.slug`,
  });

  const toOrg = ({ role: _, createdAt, ...row }: typeof OrgRowSchema.Type): Org => ({
    ...row,
    createdAt: epochMillis(createdAt),
  });

  const list = Effect.fn('Access.listOrgs')(function* (actor: ActorIdentity) {
    const found = yield* rows({
      accountId: actor.accountId,
      credentialId: actor._tag === 'Credential' && !isLogin(actor) ? actor.credentialId : null,
    }).pipe(Effect.orDie);
    return found.map(toOrg);
  });

  return {
    listOrgs: list,

    createOrg: Effect.fn('Access.createOrg')(function* ({
      actor,
      name,
      slug,
    }: {
      readonly actor: ActorIdentity;
      readonly name: string;
      readonly slug: string;
    }) {
      if (actor._tag !== 'Owner') {
        return yield* new OwnerRequiredError({
          message: 'Orgs are made by a person signed in to the dashboard, under Account.',
        });
      }
      yield* underLimit(actor.accountId, 'orgs');
      const [account] = yield* sql<{ readonly userId: string }>`SELECT user_id FROM store_account
          WHERE id = ${actor.accountId}`.pipe(Effect.orDie);
      if (account === undefined) return yield* Effect.die(`account ${actor.accountId} vanished`);
      // The plugin writes the org and its owner member; the log entry follows on its own, since the
      // plugin's writes are not this Worker's batch. A failure between them leaves an org
      // without its entry: accepted, as nothing is lost but the line.
      const { id } = yield* auth.createOrg({ userId: account.userId, name, slug });
      yield* sql
        .batch([
          yield* audit.entry({
            orgId: id,
            actor: actorOf(actor),
            action: 'org.create',
            detail: slug,
          }),
        ])
        .pipe(Effect.orDie);
      const created = (yield* list(actor)).find(org => org.id === id);
      if (created === undefined) return yield* Effect.die(`org ${id} vanished after its write`);
      return created;
    }),

    removeOrg: Effect.fn('Access.removeOrg')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      if (actor._tag !== 'Owner') {
        return yield* new OwnerRequiredError({
          message: 'Only an owner of the org deletes it, from the dashboard.',
        });
      }
      const [org] = yield* rows({ accountId: actor.accountId, credentialId: null }).pipe(
        Effect.orDie,
        Effect.map(found => found.filter(row => row.id === id)),
      );
      if (org === undefined) {
        return yield* new NotFoundError({ message: 'No org of yours has this id.' });
      }
      if (org.role !== 'owner') {
        return yield* new OwnerRequiredError({
          message: `Only an owner of ${org.slug} deletes it.`,
        });
      }
      // Whatever its environments' state: one in the bin still holds secrets. The schema refuses
      // too (no cascade from an org to its environments); this says why.
      const held = sql`EXISTS (SELECT 1 FROM environment WHERE org_id = ${id})`;
      const [deleted] = yield* sql
        .batch([
          sql`DELETE FROM organization WHERE id = ${id} AND NOT ${held} RETURNING id`,
          // The org's own entries go with it; this one is the person's.
          yield* audit.entry(
            {
              accountId: actor.accountId,
              actor: actorOf(actor),
              action: 'org.delete',
              detail: `${org.name} (${org.slug})`,
            },
            sql`NOT ${held}`,
          ),
        ])
        .pipe(Effect.orDie);
      if ((deleted ?? []).length === 0) {
        return yield* new NotEmptyError({
          message: `${org.slug} still holds environments, in the bin or not. Delete them and remove them for good from the Bin first.`,
        });
      }
      return { deleted: true };
    }),
  };
};
