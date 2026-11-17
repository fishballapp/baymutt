// Orgs: what environments belong to. The organization plugin owns the `organization` and `member`
// rows and creates them; baymutt reads them, and deletes an org that holds nothing.
import {
  type ActorIdentity,
  AlreadyExistsError,
  InvalidRequestError,
  NotEmptyError,
  NotFoundError,
  type Org,
  OwnerRequiredError,
  type UnsealedNames,
} from '@baymutt/api';
import type * as D1Client from '@effect/sql-d1/D1Client';
import * as Arr from 'effect/Array';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import type { Auth } from '../../platform/auth.ts';
import { actorOf } from '../actors.ts';
import type { Audit } from '../audit.ts';
import { areNamesSealedIn, isLogin, type Lookups, mayListNamesIn, namesNotSealed } from './rows.ts';

const OrgRowSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  role: Schema.String,
  environmentCount: Schema.Finite,
  areNamesSealed: Schema.Finite,
  // The plugin stores a date as text; D1 answers it as written.
  createdAt: Schema.String,
});

// biome-ignore lint/plugin/no-date: this Worker has no Temporal (the runtime gains one at compatibility date 2026-12-01), and parsing the plugin's ISO timestamp is all this needs.
const epochMillis = (iso: string) => new Date(iso).getTime();

/**
 * How many names one statement of `sealNames` rewrites. Each travels in one JSON parameter (D1 binds
 * 100 at most, and keeps a value under 2 MB): a name is under 500 bytes of it.
 */
const SEAL_CHUNK = 1000;

type SealedEnvironmentName = {
  readonly id: string;
  readonly name: string;
  readonly sealedName: string;
};

type SealedSecretName = {
  readonly environmentId: string;
  readonly unsealedName: string;
  readonly name: string;
  readonly sealedName: string;
};

export const orgs = ({
  sql,
  audit,
  auth,
  lookups: { underLimit, ownedOrg, serviceAccountIn },
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
              WHERE e.org_id = o.id AND e.deleted_at IS NULL) AS environment_count,
            EXISTS (SELECT 1 FROM names_key_wrap n WHERE n.org_id = o.id) AS are_names_sealed
          FROM organization o
          JOIN member m ON m.organizationId = o.id
          JOIN store_account a ON a.user_id = m.userId AND a.id = ${accountId}
          WHERE ${credentialId} IS NULL
            OR o.id IN (SELECT e.org_id FROM environment e
                        JOIN environment_grant g ON g.environment_id = e.id
                        WHERE g.credential_id = ${credentialId} AND e.deleted_at IS NULL)
          ORDER BY o.slug`,
  });

  const toOrg = ({
    role: _,
    createdAt,
    areNamesSealed,
    ...row
  }: typeof OrgRowSchema.Type): Org => ({
    ...row,
    areNamesSealed: areNamesSealed !== 0,
    createdAt: epochMillis(createdAt),
  });

  /**
   * Every name the org still stores as written: its environments' (live, binned, or named only by
   * the activity) and their secrets' (live, binned, on a paste link, or named only by the activity).
   * Empty once the org's names are sealed.
   */
  const unsealedEnvironmentNames = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String, name: Schema.String }),
    execute: orgId =>
      sql`SELECT id, name FROM environment WHERE org_id = ${orgId} AND sealed_name IS NULL
          UNION
          SELECT environment_id, environment_name FROM activity_event
          WHERE org_id = ${orgId} AND environment_id IS NOT NULL
            AND environment_name IS NOT NULL AND environment_sealed_name IS NULL
          ORDER BY 1`,
  });

  const unsealedSecretNames = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ environmentId: Schema.String, name: Schema.String }),
    execute: orgId =>
      sql`SELECT s.environment_id, s.name FROM secret s
          JOIN environment e ON e.id = s.environment_id
          WHERE e.org_id = ${orgId} AND s.sealed_name IS NULL
          UNION
          SELECT p.environment_id, p.name FROM paste_link p
          JOIN environment e ON e.id = p.environment_id
          WHERE e.org_id = ${orgId} AND p.sealed_name IS NULL
          UNION
          SELECT environment_id, secret_name FROM activity_event
          WHERE org_id = ${orgId} AND environment_id IS NOT NULL
            AND secret_name IS NOT NULL AND secret_sealed_name IS NULL
          ORDER BY 1, 2`,
  });

  const unsealedNames = Effect.fnUntraced(function* (orgId: string) {
    const [environments, secrets] = yield* Effect.all(
      [unsealedEnvironmentNames(orgId), unsealedSecretNames(orgId)],
      { concurrency: 2 },
    ).pipe(Effect.orDie);
    return { environments, secrets } satisfies UnsealedNames;
  });

  /** Every stored copy of each name, rewritten while the org's names are not sealed yet. */
  const rewriteStatements = ({
    orgId,
    environments,
    secrets,
    notSealed,
  }: {
    readonly orgId: string;
    readonly environments: ReadonlyArray<SealedEnvironmentName>;
    readonly secrets: ReadonlyArray<SealedSecretName>;
    readonly notSealed: ReturnType<typeof areNamesSealedIn>;
  }) => [
    ...Arr.chunksOf(environments, SEAL_CHUNK).flatMap(chunk => {
      const names = sql`(SELECT json_extract(value, '$.id') AS id,
          json_extract(value, '$.name') AS name, json_extract(value, '$.sealedName') AS sealed_name
        FROM json_each(${JSON.stringify(chunk)}))`;
      return [
        sql`UPDATE environment SET name = j.name, sealed_name = j.sealed_name FROM ${names} AS j
            WHERE environment.id = j.id AND environment.org_id = ${orgId}
              AND environment.sealed_name IS NULL AND ${notSealed}`,
        sql`UPDATE activity_event
            SET environment_name = j.name, environment_sealed_name = j.sealed_name FROM ${names} AS j
            WHERE activity_event.org_id = ${orgId} AND activity_event.environment_id = j.id
              AND activity_event.environment_sealed_name IS NULL AND ${notSealed}`,
      ];
    }),
    ...Arr.chunksOf(secrets, SEAL_CHUNK).flatMap(chunk => {
      const names = sql`(SELECT json_extract(value, '$.environmentId') AS environment_id,
          json_extract(value, '$.unsealedName') AS unsealed_name,
          json_extract(value, '$.name') AS name, json_extract(value, '$.sealedName') AS sealed_name
        FROM json_each(${JSON.stringify(chunk)}))`;
      // Each pair was checked to be one of the org's own. A secret's name is its key, and its
      // versions refer to it: the row is copied under the new name, its versions move to the copy,
      // and the old row goes, so no foreign key is ever broken.
      return [
        sql`INSERT INTO secret
              (environment_id, name, sealed_name, current_version, latest_version, updated_at,
               updated_by, write_id, purge_at)
            SELECT s.environment_id, j.name, j.sealed_name, s.current_version, s.latest_version,
              s.updated_at, s.updated_by, s.write_id, s.purge_at
            FROM secret s JOIN ${names} AS j
              ON s.environment_id = j.environment_id AND s.name = j.unsealed_name
            WHERE s.sealed_name IS NULL AND ${notSealed}`,
        sql`UPDATE secret_version SET name = j.name FROM ${names} AS j
            WHERE secret_version.environment_id = j.environment_id
              AND secret_version.name = j.unsealed_name AND ${notSealed}`,
        sql`DELETE FROM secret
            WHERE sealed_name IS NULL
              AND EXISTS (SELECT 1 FROM ${names} AS j
                          WHERE j.environment_id = secret.environment_id
                            AND j.unsealed_name = secret.name)
              AND ${notSealed}`,
        sql`UPDATE paste_link SET name = j.name, sealed_name = j.sealed_name FROM ${names} AS j
            WHERE paste_link.environment_id = j.environment_id AND paste_link.name = j.unsealed_name
              AND paste_link.sealed_name IS NULL
              AND ${notSealed}`,
        sql`UPDATE activity_event
            SET secret_name = j.name, secret_sealed_name = j.sealed_name FROM ${names} AS j
            WHERE activity_event.org_id = ${orgId}
              AND activity_event.environment_id = j.environment_id
              AND activity_event.secret_name = j.unsealed_name
              AND activity_event.secret_sealed_name IS NULL AND ${notSealed}`,
      ];
    }),
  ];

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

    unsealedNames: Effect.fn('Access.unsealedNames')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      yield* ownedOrg(actor, id, 'seals its names');
      return yield* unsealedNames(id);
    }),

    sealNames: Effect.fn('Access.sealNames')(function* ({
      actor,
      id,
      wraps,
      environments,
      secrets,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly wraps: ReadonlyArray<{ readonly readerId: string; readonly wrap: string }>;
      readonly environments: ReadonlyArray<SealedEnvironmentName>;
      readonly secrets: ReadonlyArray<SealedSecretName>;
    }) {
      const org = yield* ownedOrg(actor, id, 'seals its names');
      const alreadySealed = new AlreadyExistsError({
        message: `The names in ${org.slug} are already sealed.`,
      });
      if (org.areNamesSealed) return yield* alreadySealed;
      const mismatch = (what: string) =>
        new InvalidRequestError({
          message: `Sealing names ${what}. Read the org's unsealed names again and seal exactly those.`,
        });
      const stored = yield* unsealedNames(id);
      const environmentKeys = new Set(environments.map(({ id: environmentId }) => environmentId));
      if (
        environmentKeys.size !== environments.length ||
        environmentKeys.symmetricDifference(new Set(stored.environments.map(({ id }) => id)))
          .size !== 0
      ) {
        return yield* mismatch('covers each environment of the org once and no other');
      }
      const secretKey = (environmentId: string, name: string) => `${environmentId}/${name}`;
      const secretKeys = new Set(
        secrets.map(({ environmentId, unsealedName }) => secretKey(environmentId, unsealedName)),
      );
      if (
        secretKeys.size !== secrets.length ||
        secretKeys.symmetricDifference(
          new Set(stored.secrets.map(({ environmentId, name }) => secretKey(environmentId, name))),
        ).size !== 0
      ) {
        return yield* mismatch('covers each secret name of the org once and no other');
      }
      const readers = new Set(wraps.map(({ readerId }) => readerId));
      if (readers.size !== wraps.length || !readers.has(actor.accountId)) {
        return yield* mismatch(
          'covers your account, each of its CLI logins and each key of this org once',
        );
      }
      for (const readerId of readers) {
        if (readerId === actor.accountId) continue;
        const reader = yield* serviceAccountIn(actor.accountId, readerId).pipe(
          Effect.catchTag('NotFoundError', () =>
            Effect.fail(
              mismatch('covers only your account and the CLI logins and keys that still work'),
            ),
          ),
        );
        if (!mayListNamesIn(reader, id)) {
          return yield* mismatch(`covers no key of another org than ${org.slug}`);
        }
      }
      const now = yield* Clock.currentTimeMillis;
      const notSealed = sql`NOT ${areNamesSealedIn(sql, id)}`;
      // One batch, every statement while the org has no names key: each stored copy of each name
      // is rewritten, the log says so, and the wraps go in last, which is what makes it sealed.
      const results = yield* sql
        .batch([
          ...rewriteStatements({ orgId: id, environments, secrets, notSealed }),
          yield* audit.entry(
            {
              orgId: id,
              actor: actorOf(actor),
              action: 'names.seal',
              detail: `${environments.length} environments, ${secrets.length} secret names`,
            },
            notSealed,
          ),
          sql`INSERT INTO names_key_wrap (org_id, reader_id, wrap, created_at)
              SELECT ${id}, json_extract(value, '$.readerId'), json_extract(value, '$.wrap'), ${now}
              FROM json_each(${JSON.stringify(wraps)})
              WHERE ${notSealed}
              RETURNING reader_id`,
        ])
        .pipe(Effect.orDie);
      if ((results.at(-1) ?? []).length === 0) return yield* alreadySealed;
      const sealed = (yield* list(actor)).find(found => found.id === id);
      if (sealed === undefined) return yield* Effect.die(`org ${id} vanished after sealing`);
      return sealed;
    }),

    putNamesKeyWrap: Effect.fn('Access.putNamesKeyWrap')(function* ({
      actor,
      id,
      readerId,
      wrap,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly readerId: string;
      readonly wrap: string;
    }) {
      const org = yield* ownedOrg(actor, id, 'hands its names key on');
      if (!org.areNamesSealed) return yield* namesNotSealed(org.slug);
      if (readerId !== actor.accountId) {
        const reader = yield* serviceAccountIn(actor.accountId, readerId);
        if (!mayListNamesIn(reader, id)) {
          return yield* new InvalidRequestError({
            message: `${reader.name} is a key of another org, so it does not list the names in ${org.slug}.`,
          });
        }
      }
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO names_key_wrap (org_id, reader_id, wrap, created_at)
          VALUES (${id}, ${readerId}, ${wrap}, ${now})
          ON CONFLICT (org_id, reader_id) DO UPDATE SET wrap = excluded.wrap`.pipe(Effect.orDie);
      return { readerId };
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
