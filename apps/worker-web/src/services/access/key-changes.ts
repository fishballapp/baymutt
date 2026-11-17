// Key changes: what `baymutt ask change` makes. The CLI login that asked for an agent's key asks to
// add access to it, give some back, or give it a new end, on the same key. Adding or a new end
// waits for the owner, who approves it whole: the browser wraps to the key exactly what it adds,
// as approving a request does. Giving back alone takes effect at once. Owns `key_change` and
// `key_change_item`.
import {
  type Actor,
  type ActorIdentity,
  AlreadyExistsError,
  InvalidRequestError,
  type KeyChange,
  LinkSpentError,
  NotFoundError,
  OwnerRequiredError,
  REQUEST_WAIT_MS,
} from '@baymutt/api';
import type * as D1Client from '@effect/sql-d1/D1Client';
import { eachIsolated } from '@internal/effect-worker';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import { actorOf } from '../actors.ts';
import type { Audit } from '../audit.ts';
import { isLogin, type Lookups, namesNotSealed, orgsOf, outsideKeyOrg } from './rows.ts';
import { dayOf } from './service-accounts.ts';

/** Who expires a change nobody answered. */
const SYSTEM_ACTOR: Actor = { kind: 'system', id: 'key-changes', name: 'baymutt' };

type Access = { readonly canRead: boolean; readonly canWrite: boolean };

export type KeyChangeAsk = {
  readonly id: string;
  readonly keyId: string;
  readonly reason: string;
  readonly lifetime: number | null;
  readonly add: ReadonlyArray<Access & { readonly environmentId: string }>;
  readonly giveBack: ReadonlyArray<string>;
};

export type KeyChangeApproval = {
  /** Absent keeps the key's end. */
  readonly expiresAt?: number | null;
  readonly grants: ReadonlyArray<{
    readonly environmentId: string;
    readonly readWrap: string | null;
    readonly keyProof: string;
    readonly keyVersion: number;
  }>;
  readonly namesKeyWraps: ReadonlyArray<{ readonly orgId: string; readonly wrap: string }>;
};

const ChangeRowSchema = Schema.Struct({
  id: Schema.String,
  keyId: Schema.String,
  keyName: Schema.String,
  keyIntent: Schema.NullOr(Schema.Literals(['service-account', 'agent'])),
  keyPublicKey: Schema.String,
  keyVoucherOwner: Schema.NullOr(Schema.String),
  keyExpiresAt: Schema.NullOr(Schema.Finite),
  orgId: Schema.String,
  orgSlug: Schema.String,
  reason: Schema.String,
  status: Schema.Literals(['pending', 'approved', 'applied', 'rejected', 'expired']),
  lifetime: Schema.NullOr(Schema.Finite),
  createdAt: Schema.Finite,
  resolvedAt: Schema.NullOr(Schema.Finite),
  makerId: Schema.String,
  makerName: Schema.String,
  makerPublicKey: Schema.String,
  makerEndorsement: Schema.NullOr(Schema.String),
});
type ChangeRow = typeof ChangeRowSchema.Type;

const LocatedSchema = {
  environmentId: Schema.String,
  orgId: Schema.String,
  orgSlug: Schema.String,
  environmentName: Schema.String,
  environmentSealedName: Schema.NullOr(Schema.String),
  canRead: Schema.Finite,
  canWrite: Schema.Finite,
};

const ItemRowSchema = Schema.Struct({
  changeId: Schema.String,
  ...LocatedSchema,
  // Null once the environment was removed for good.
  orgId: Schema.NullOr(Schema.String),
  orgSlug: Schema.NullOr(Schema.String),
  environmentName: Schema.NullOr(Schema.String),
  givesBack: Schema.Finite,
});
type ItemRow = typeof ItemRowSchema.Type;

/** An item whose environment still has a row, as the API shows it. */
const present = (
  item: ItemRow,
): item is ItemRow & { orgId: string; orgSlug: string; environmentName: string } =>
  item.orgId !== null && item.orgSlug !== null && item.environmentName !== null;

const HoldingRowSchema = Schema.Struct({ credentialId: Schema.String, ...LocatedSchema });
type HoldingRow = typeof HoldingRowSchema.Type;

const ChangeQuerySchema = Schema.Struct({
  accountId: Schema.String,
  id: Schema.NullOr(Schema.String),
  makerId: Schema.NullOr(Schema.String),
  isPendingOnly: Schema.Boolean,
  /** A pending change made at or before this has expired, whatever its row still says. */
  expiredBy: Schema.Finite,
});
type ChangeQuery = typeof ChangeQuerySchema.Type;

const accessWords = ({ canRead, canWrite }: Access) =>
  [canRead && 'read', canWrite && 'write'].filter(Boolean).join(' + ');

/** The end an approval leaves a key with, as its log entry says it. */
const endWords = (expiresAt: number | null | undefined) => {
  if (expiresAt === undefined) return 'same end';
  if (expiresAt === null) return 'no end';
  return `until ${dayOf(expiresAt)}`;
};

const located = ({ canRead, canWrite, ...row }: Omit<HoldingRow, 'credentialId'>) => ({
  ...row,
  canRead: canRead !== 0,
  canWrite: canWrite !== 0,
});

export const keyChanges = ({
  sql,
  audit,
  lookups: { approvedServiceAccountIn, ownedOrg },
}: {
  readonly sql: D1Client.D1Client;
  readonly audit: Audit['Service'];
  readonly lookups: Lookups;
}) => {
  const matching = ({ accountId, id, makerId, isPendingOnly, expiredBy }: ChangeQuery) =>
    sql`c.account_id = ${accountId}
      AND (${id} IS NULL OR k.id = ${id})
      AND (${makerId} IS NULL OR c.parent_id = ${makerId})
      AND (${isPendingOnly ? 1 : 0} = 0
        OR (k.status = 'pending' AND k.created_at > ${expiredBy} AND c.revoked_at IS NULL))`;

  const changeRows = SqlSchema.findAll({
    Request: ChangeQuerySchema,
    Result: ChangeRowSchema,
    execute: query =>
      sql`SELECT k.id, c.id AS key_id, c.name AS key_name, c.intent AS key_intent,
            c.public_key AS key_public_key, c.key_voucher_owner, c.expires_at AS key_expires_at,
            c.org_id, ko.slug AS org_slug, k.reason, k.status, k.lifetime, k.created_at, k.resolved_at, p.id AS maker_id,
            p.name AS maker_name, p.public_key AS maker_public_key,
            p.endorsement AS maker_endorsement
          FROM key_change k
          JOIN credential c ON c.id = k.credential_id
          JOIN organization ko ON ko.id = c.org_id
          JOIN credential p ON p.id = c.parent_id
          WHERE ${matching(query)}
          ORDER BY k.created_at`,
  });

  // An environment removed for good has no row left to name it: its item comes back with no org,
  // and the change says it names one (`isMissingEnvironment`), as nothing can approve half of it.
  const itemRows = SqlSchema.findAll({
    Request: ChangeQuerySchema,
    Result: ItemRowSchema,
    execute: query =>
      sql`SELECT i.change_id, i.environment_id, e.org_id, o.slug AS org_slug,
            e.name AS environment_name, e.sealed_name AS environment_sealed_name, i.can_read,
            i.can_write, i.gives_back
          FROM key_change_item i
          JOIN key_change k ON k.id = i.change_id
          JOIN credential c ON c.id = k.credential_id
          LEFT JOIN environment e ON e.id = i.environment_id
          LEFT JOIN organization o ON o.id = e.org_id
          WHERE ${matching(query)}
          ORDER BY o.slug, environment_name`,
  });

  /** What the keys `ids` (a JSON array) hold now, on live environments of the person's orgs. */
  const holdingRows = SqlSchema.findAll({
    Request: Schema.Struct({ accountId: Schema.String, ids: Schema.String }),
    Result: HoldingRowSchema,
    execute: ({ accountId, ids }) =>
      sql`SELECT g.credential_id, g.environment_id, e.org_id, o.slug AS org_slug,
            e.name AS environment_name, e.sealed_name AS environment_sealed_name,
            g.read_wrap IS NOT NULL AS can_read, g.can_write
          FROM environment_grant g
          JOIN environment e ON e.id = g.environment_id
          JOIN organization o ON o.id = e.org_id
          WHERE g.credential_id IN (SELECT value FROM json_each(${ids}))
            AND e.deleted_at IS NULL AND e.org_id IN (${orgsOf(sql, accountId)})
          ORDER BY o.slug, e.name`,
  });

  /** The live environments of the person's orgs among `ids`, with what approving checks. */
  const liveEnvironments = SqlSchema.findAll({
    Request: Schema.Struct({ accountId: Schema.String, ids: Schema.String }),
    Result: Schema.Struct({
      id: Schema.String,
      orgId: Schema.String,
      keyVersion: Schema.Finite,
    }),
    execute: ({ accountId, ids }) =>
      sql`SELECT id, org_id, key_version FROM environment
          WHERE id IN (SELECT value FROM json_each(${ids}))
            AND org_id IN (${orgsOf(sql, accountId)}) AND deleted_at IS NULL`,
  });

  const holdings = (accountId: string, keyIds: ReadonlyArray<string>) =>
    holdingRows({ accountId, ids: JSON.stringify(keyIds) }).pipe(Effect.orDie);

  const toChange = (
    actor: ActorIdentity,
    row: ChangeRow,
    items: ReadonlyArray<ItemRow>,
    held: ReadonlyArray<HoldingRow>,
    expiredBy: number,
  ): KeyChange => {
    const isOwner = actor._tag === 'Owner';
    // Expired the moment its hour is up: the daily run only marks the row.
    const hasExpired =
      row.status === 'expired' || (row.status === 'pending' && row.createdAt <= expiredBy);
    const own = items.filter(item => item.changeId === row.id);
    return {
      id: row.id,
      key: {
        id: row.keyId,
        name: row.keyName,
        intent: row.keyIntent,
        publicKey: row.keyPublicKey,
        // Sealed to the account key: only the owner's browser opens it, and only it needs to.
        keyVoucher: isOwner ? row.keyVoucherOwner : null,
        expiresAt: row.keyExpiresAt,
      },
      org: { id: row.orgId, slug: row.orgSlug },
      reason: row.reason,
      status: hasExpired ? 'expired' : row.status,
      lifetime: row.lifetime,
      holds: held
        .filter(holding => holding.credentialId === row.keyId)
        .map(({ credentialId: _, ...holding }) => located(holding)),
      add: own
        .filter(present)
        .filter(item => item.givesBack === 0)
        .map(({ changeId: _, givesBack: __, ...item }) => located(item)),
      giveBack: own
        .filter(present)
        .filter(item => item.givesBack !== 0)
        .map(({ changeId: _, givesBack: __, ...item }) => located(item)),
      isMissingEnvironment: !own.every(present),
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
    filter: Omit<ChangeQuery, 'expiredBy'>,
  ) {
    const query = { ...filter, expiredBy: (yield* Clock.currentTimeMillis) - REQUEST_WAIT_MS };
    const [rows, items] = yield* Effect.all([changeRows(query), itemRows(query)], {
      concurrency: 2,
    }).pipe(Effect.orDie);
    const held = yield* holdings(actor.accountId, [...new Set(rows.map(row => row.keyId))]);
    return rows.map(row => toChange(actor, row, items, held, query.expiredBy));
  });

  /** A change the caller may see: the owner any, a CLI login those it asked for. */
  const visible = Effect.fnUntraced(function* (actor: ActorIdentity, id: string) {
    const isOtherKey = actor._tag === 'Credential' && !isLogin(actor);
    const [found] = isOtherKey
      ? []
      : yield* find(actor, {
          accountId: actor.accountId,
          id,
          makerId: actor._tag === 'Credential' ? actor.credentialId : null,
          isPendingOnly: false,
        });
    if (found === undefined) {
      return yield* new NotFoundError({ message: 'No key change of yours has this id.' });
    }
    return found;
  });

  const answered = (change: KeyChange) =>
    new LinkSpentError({
      message:
        change.status === 'expired'
          ? 'This key change expired: nobody answered it within an hour. Its key holds what it held; its maker asks again.'
          : `This key change was already ${change.status}.`,
    });

  /** Still waiting for an answer at `now`, on a key that is not revoked. */
  const isPending = (id: string, now: number) =>
    sql`EXISTS (SELECT 1 FROM key_change k JOIN credential c ON c.id = k.credential_id
      WHERE k.id = ${id} AND k.status = 'pending' AND k.created_at > ${now - REQUEST_WAIT_MS}
        AND c.revoked_at IS NULL)`;

  /** Still approvable at `now`: pending, and its key has not ended. Decided inside the batch. */
  const isApprovable = (id: string, now: number) =>
    sql`${isPending(id, now)} AND EXISTS (SELECT 1 FROM key_change k
      JOIN credential c ON c.id = k.credential_id
      WHERE k.id = ${id} AND (c.expires_at IS NULL OR c.expires_at > ${now}))`;

  const hasEnded = (expiresAt: number | null, now: number) =>
    expiresAt !== null && expiresAt <= now;

  const pendingFor = SqlSchema.findAll({
    Request: Schema.Finite,
    Result: Schema.Struct({ id: Schema.String, accountId: Schema.String, name: Schema.String }),
    execute: createdBy =>
      sql`SELECT k.id, c.account_id, c.name FROM key_change k
          JOIN credential c ON c.id = k.credential_id
          WHERE k.status = 'pending' AND k.created_at <= ${createdBy}`,
  });

  /** A refusal that names the change: what is wrong, and that nothing was changed. */
  const invalid = (message: string) => new InvalidRequestError({ message });

  return {
    listKeyChanges: Effect.fn('Access.listKeyChanges')(function* (actor: ActorIdentity) {
      if (actor._tag === 'Credential' && !isLogin(actor)) return [];
      return yield* find(actor, {
        accountId: actor.accountId,
        id: null,
        makerId: actor._tag === 'Credential' ? actor.credentialId : null,
        isPendingOnly: true,
      });
    }),

    getKeyChange: Effect.fn('Access.getKeyChange')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      return yield* visible(actor, id);
    }),

    createKeyChange: Effect.fn('Access.createKeyChange')(function* ({
      actor,
      change,
    }: {
      readonly actor: ActorIdentity;
      readonly change: KeyChangeAsk;
    }) {
      if (actor._tag !== 'Credential' || !isLogin(actor)) {
        return yield* new OwnerRequiredError({
          message:
            actor._tag === 'Owner'
              ? 'A key change is asked for by the CLI login that asked for the key. The owner changes a key’s access under Keys in the dashboard.'
              : 'A key cannot ask to change itself. Ask from the CLI login that asked for it: `baymutt ask change`.',
        });
      }
      const key = yield* approvedServiceAccountIn(actor.accountId, change.keyId).pipe(
        Effect.catchTag('NotFoundError', () => Effect.succeed(null)),
      );
      if (key === null || key.parentId !== actor.credentialId) {
        return yield* new NotFoundError({
          message:
            'No key this CLI login asked for, approved and not revoked, has this id. List them with `baymutt key list`.',
        });
      }
      const now = yield* Clock.currentTimeMillis;
      if (hasEnded(key.expiresAt, now)) {
        return yield* invalid(
          `${key.name} has ended, so it does not change. Ask for a new key with \`baymutt ask access\`.`,
        );
      }

      const addIds = change.add.map(item => item.environmentId);
      const named = [...addIds, ...change.giveBack];
      if (new Set(named).size !== named.length) {
        return yield* invalid('A key change names each environment once.');
      }
      if (change.add.some(({ canRead, canWrite }) => !canRead && !canWrite)) {
        return yield* invalid('Each environment a key change adds is read, write or both.');
      }
      if (change.add.length === 0 && change.giveBack.length === 0 && change.lifetime === null) {
        return yield* invalid('A key change adds access, gives some back, or asks for a new end.');
      }
      const live = yield* liveEnvironments({
        accountId: actor.accountId,
        ids: JSON.stringify(addIds),
      }).pipe(Effect.orDie);
      if (live.length !== addIds.length) {
        return yield* new NotFoundError({
          message:
            'A key change adds an environment that is not a live environment of your orgs. List them with `baymutt env list`; a new one is asked for with `baymutt ask create-environment`.',
        });
      }
      if (live.some(environment => environment.orgId !== key.orgId)) {
        return yield* invalid(
          outsideKeyOrg(
            key.orgSlug ?? 'another org',
            `a key change adds environments of its own org only`,
          ),
        );
      }
      const held = new Map(
        (yield* holdings(actor.accountId, [key.id])).map(holding => [
          holding.environmentId,
          located(holding),
        ]),
      );
      for (const item of change.add) {
        const before = held.get(item.environmentId);
        if ((!item.canRead || before?.canRead) && (!item.canWrite || before?.canWrite)) {
          return yield* invalid(
            `${key.name} already holds ${accessWords(item)} on an environment this change adds to. Add only what it does not hold.`,
          );
        }
      }
      if (change.giveBack.some(environmentId => !held.has(environmentId))) {
        return yield* invalid(
          `A key change gives back an environment ${key.name} does not hold. See what it holds with \`baymutt key list\`.`,
        );
      }
      const [waiting] = yield* find(actor, {
        accountId: actor.accountId,
        id: null,
        makerId: actor.credentialId,
        isPendingOnly: true,
      }).pipe(Effect.map(changes => changes.filter(({ key: { id } }) => id === key.id)));
      if (waiting !== undefined) {
        return yield* new AlreadyExistsError({
          message: `Key change ${waiting.id} to ${key.name} is still waiting for the owner. Wait for it (\`baymutt ask wait ${waiting.id}\`) or withdraw it (\`baymutt ask cancel ${waiting.id}\`) first.`,
        });
      }

      // Giving back needs nobody's approval: it only takes away, so it is done now.
      const isGiveBackOnly = change.add.length === 0 && change.lifetime === null;
      const by = actorOf(actor);
      const made = sql`EXISTS (SELECT 1 FROM key_change
        WHERE id = ${change.id} AND credential_id = ${key.id} AND created_at = ${now})`;
      const itemStatement = (environmentId: string, access: Access, givesBack: boolean) =>
        sql`INSERT INTO key_change_item (change_id, environment_id, can_read, can_write, gives_back)
            SELECT ${change.id}, ${environmentId}, ${access.canRead ? 1 : 0},
              ${access.canWrite ? 1 : 0}, ${givesBack ? 1 : 0}
            WHERE ${made}`;
      const [inserted] = yield* sql
        .batch([
          sql`INSERT INTO key_change (id, credential_id, status, reason, lifetime, created_at, resolved_at)
              VALUES (${change.id}, ${key.id}, ${isGiveBackOnly ? 'applied' : 'pending'},
                ${change.reason}, ${change.lifetime}, ${now}, ${isGiveBackOnly ? now : null})
              ON CONFLICT (id) DO NOTHING
              RETURNING id`,
          ...change.add.map(item => itemStatement(item.environmentId, item, false)),
          ...change.giveBack.map(environmentId =>
            itemStatement(
              environmentId,
              held.get(environmentId) ?? { canRead: false, canWrite: false },
              true,
            ),
          ),
          ...(isGiveBackOnly
            ? yield* Effect.forEach(
                change.giveBack,
                environmentId =>
                  Effect.map(
                    audit.entry(
                      {
                        orgId: held.get(environmentId)?.orgId ?? '',
                        actor: by,
                        action: 'grant.remove',
                        environmentId,
                        detail: key.name,
                      },
                      made,
                    ),
                    entry => [
                      entry,
                      sql`DELETE FROM environment_grant
                          WHERE environment_id = ${environmentId} AND credential_id = ${key.id}
                            AND ${made}`,
                    ],
                  ),
                { concurrency: 1 },
              ).pipe(Effect.map(statements => statements.flat()))
            : [
                yield* audit.entry(
                  {
                    accountId: actor.accountId,
                    actor: by,
                    action: 'key-change.create',
                    detail: key.name,
                  },
                  made,
                ),
              ]),
        ])
        .pipe(Effect.orDie);
      if ((inserted ?? []).length === 0) {
        return yield* new AlreadyExistsError({
          message: 'A key change with this id exists. Ask again: a new one gets a new id.',
        });
      }
      return yield* visible(actor, change.id).pipe(Effect.orDie);
    }),

    approveKeyChange: Effect.fn('Access.approveKeyChange')(function* ({
      actor,
      id,
      approval,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly approval: KeyChangeApproval;
    }) {
      if (actor._tag !== 'Owner') {
        return yield* new OwnerRequiredError({
          message: 'Only the owner approves a key change, from the dashboard.',
        });
      }
      const change = yield* visible(actor, id);
      if (change.status !== 'pending') return yield* answered(change);
      const now = yield* Clock.currentTimeMillis;
      if (hasEnded(change.key.expiresAt, now)) {
        return yield* invalid(
          `${change.key.name} has ended, so it does not change. Reject this; its CLI login asks for a new key.`,
        );
      }
      if (change.isMissingEnvironment) {
        return yield* new NotFoundError({
          message:
            'An environment this key change names was removed for good since, so it cannot be approved. Reject it; the CLI login can ask again.',
        });
      }
      // An end already past would end the key inside the very write that approves it.
      if (
        approval.expiresAt !== undefined &&
        approval.expiresAt !== null &&
        approval.expiresAt <= now
      ) {
        return yield* invalid('A new end is later than now. Pick another.');
      }
      const mismatch = (what: string) =>
        invalid(
          `The approval does not match the key change: ${what}. Read it again and approve what it names.`,
        );
      // Only what the key holds now counts: it is what the change adds to.
      const held = new Map(change.holds.map(holding => [holding.environmentId, holding]));
      const live = new Map(
        (yield* liveEnvironments({
          accountId: actor.accountId,
          ids: JSON.stringify([...change.add, ...change.giveBack].map(item => item.environmentId)),
        }).pipe(Effect.orDie)).map(environment => [environment.id, environment]),
      );
      const grants = new Map(approval.grants.map(grant => [grant.environmentId, grant]));
      if (grants.size !== approval.grants.length || grants.size !== change.add.length) {
        return yield* mismatch('one answer per environment it adds to');
      }
      // What the key holds after it, as this snapshot sees it: for the log only. The batch merges
      // against the grant as it is when it writes.
      const after = new Map<string, Access>();
      for (const item of change.add) {
        const environment = live.get(item.environmentId);
        if (environment === undefined) {
          return yield* new NotFoundError({
            message:
              'An environment this key change adds was deleted since. Reject it; the CLI login can ask again.',
          });
        }
        const grant = grants.get(item.environmentId);
        if (grant === undefined) return yield* mismatch('an answer for each environment it adds');
        const before = held.get(item.environmentId);
        // A read wrap comes only where the change adds read, which the page showed: the browser
        // never wraps a read because the store says the key holds one.
        if ((grant.readWrap !== null) !== item.canRead) {
          return yield* mismatch('read access exactly where it adds read');
        }
        const access = {
          canRead: item.canRead || (before?.canRead ?? false),
          canWrite: item.canWrite || (before?.canWrite ?? false),
        };
        if (grant.keyVersion !== environment.keyVersion) {
          return yield* mismatch('each environment answered for its current key version');
        }
        after.set(item.environmentId, access);
      }
      const orgIds = new Set(change.add.map(item => item.orgId));
      const namesKeyWraps = new Map(approval.namesKeyWraps.map(wrap => [wrap.orgId, wrap.wrap]));
      if (
        namesKeyWraps.size !== approval.namesKeyWraps.length ||
        !orgIds.isSubsetOf(new Set(namesKeyWraps.keys())) ||
        namesKeyWraps.size !== orgIds.size ||
        [...namesKeyWraps.keys()].some(orgId => orgId !== change.org.id)
      ) {
        return yield* mismatch('the names of its key’s org when it adds to it, and of no other');
      }
      for (const orgId of new Set([...orgIds, ...change.giveBack.map(item => item.orgId)])) {
        const org = yield* ownedOrg(actor, orgId, 'approves access to its environments');
        if (orgIds.has(orgId) && !org.areNamesSealed) return yield* namesNotSealed(org.slug);
      }

      const by = actorOf(actor);
      const pending = isApprovable(id, now);
      const keyId = change.key.id;
      const end = endWords(approval.expiresAt);
      // One batch: what it adds, what it gives back, and its end, logged as the environments' own
      // activity shows them, then the change is marked approved. A batch that loses to another
      // answer changes nothing.
      const results = yield* sql
        .batch([
          // Merged with the grant as it is now, not as it was read: where the change adds no read
          // the row keeps its own wrap (none, if it was removed meanwhile), and write is added to,
          // never taken away. So the key gains exactly what the owner approved.
          ...approval.grants.map(
            grant =>
              sql`INSERT INTO environment_grant
                    (environment_id, credential_id, can_write, read_wrap, key_proof, key_version,
                     created_at)
                  SELECT ${grant.environmentId}, ${keyId},
                    ${change.add.find(item => item.environmentId === grant.environmentId)?.canWrite ? 1 : 0},
                    ${grant.readWrap}, ${grant.keyProof}, ${grant.keyVersion}, ${now}
                  WHERE ${pending}
                  ON CONFLICT (environment_id, credential_id) DO UPDATE
                    SET can_write = MAX(environment_grant.can_write, excluded.can_write),
                        read_wrap = CASE
                          WHEN excluded.read_wrap IS NOT NULL THEN excluded.read_wrap
                          WHEN environment_grant.key_version = excluded.key_version
                            THEN environment_grant.read_wrap
                          ELSE NULL END,
                        key_proof = excluded.key_proof, key_version = excluded.key_version`,
          ),
          ...[...namesKeyWraps].map(
            ([orgId, wrap]) =>
              sql`INSERT INTO names_key_wrap (org_id, reader_id, wrap, created_at)
                  SELECT ${orgId}, ${keyId}, ${wrap}, ${now} WHERE ${pending}
                  ON CONFLICT (org_id, reader_id) DO UPDATE SET wrap = excluded.wrap`,
          ),
          ...(yield* Effect.forEach(
            change.giveBack,
            item =>
              Effect.map(
                audit.entry(
                  {
                    orgId: item.orgId,
                    actor: by,
                    action: 'grant.remove',
                    environmentId: item.environmentId,
                    detail: change.key.name,
                  },
                  sql`${pending} AND EXISTS (SELECT 1 FROM environment_grant
                    WHERE environment_id = ${item.environmentId} AND credential_id = ${keyId})`,
                ),
                entry => [
                  entry,
                  sql`DELETE FROM environment_grant
                      WHERE environment_id = ${item.environmentId} AND credential_id = ${keyId}
                        AND ${pending}`,
                ],
              ),
            { concurrency: 1 },
          )).flat(),
          ...(yield* Effect.forEach(
            change.add,
            item =>
              audit.entry(
                {
                  orgId: item.orgId,
                  actor: by,
                  action: 'grant.set',
                  environmentId: item.environmentId,
                  detail: `${change.key.name}: ${accessWords(after.get(item.environmentId) ?? item)}`,
                },
                pending,
              ),
            { concurrency: 1 },
          )),
          yield* audit.entry(
            {
              accountId: actor.accountId,
              actor: by,
              action: 'key-change.approve',
              detail: `${change.key.name}: ${end}`,
            },
            pending,
          ),
          // The end last but one: a new end is later than now, so the predicate still holds after it.
          ...(approval.expiresAt === undefined
            ? []
            : [
                sql`UPDATE credential SET expires_at = ${approval.expiresAt}
                    WHERE id = ${keyId} AND ${pending}`,
              ]),
          sql`UPDATE key_change SET status = 'approved', resolved_at = ${now}
              WHERE id = ${id} AND ${pending} RETURNING id`,
        ])
        .pipe(Effect.orDie);
      if ((results.at(-1) ?? []).length === 0) {
        return yield* answered(yield* visible(actor, id).pipe(Effect.orDie));
      }
      return yield* visible(actor, id).pipe(Effect.orDie);
    }),

    rejectKeyChange: Effect.fn('Access.rejectKeyChange')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      const change = yield* visible(actor, id);
      if (actor._tag === 'Credential' && actor.credentialId !== change.maker.id) {
        return yield* new OwnerRequiredError({
          message: 'Only the owner or the CLI login that asked rejects a key change.',
        });
      }
      if (change.status !== 'pending') return yield* answered(change);
      const now = yield* Clock.currentTimeMillis;
      const pending = isPending(id, now);
      const [, rejected] = yield* sql
        .batch([
          yield* audit.entry(
            {
              accountId: actor.accountId,
              actor: actorOf(actor),
              action: 'key-change.reject',
              detail: change.key.name,
            },
            pending,
          ),
          sql`UPDATE key_change SET status = 'rejected', resolved_at = ${now}
              WHERE id = ${id} AND ${pending} RETURNING id`,
        ])
        .pipe(Effect.orDie);
      if ((rejected ?? []).length === 0) {
        return yield* answered(yield* visible(actor, id).pipe(Effect.orDie));
      }
      return yield* visible(actor, id).pipe(Effect.orDie);
    }),

    /**
     * The daily run's part. A change nobody answered in `REQUEST_WAIT_MS` has expired already, as
     * everything that reads it sees: here its row says so, and the log. Its key is left as it is.
     */
    sweepKeyChanges: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cutoff = now - REQUEST_WAIT_MS;
      const unanswered = yield* pendingFor(cutoff).pipe(Effect.orDie);
      yield* eachIsolated({
        sweep: 'unanswered key change',
        rows: unanswered,
        run: change =>
          Effect.gen(function* () {
            const onlyIf = sql`EXISTS (SELECT 1 FROM key_change
              WHERE id = ${change.id} AND status = 'pending' AND created_at <= ${cutoff})`;
            yield* sql
              .batch([
                yield* audit.entry(
                  {
                    accountId: change.accountId,
                    actor: SYSTEM_ACTOR,
                    action: 'key-change.expire',
                    detail: change.name,
                  },
                  onlyIf,
                ),
                sql`UPDATE key_change SET status = 'expired', resolved_at = ${now}
                    WHERE id = ${change.id} AND ${onlyIf}`,
              ])
              .pipe(Effect.orDie);
          }),
      });
      yield* Effect.logInfo('key changes swept', { expired: unanswered.length });
      return { expired: unanswered.length };
    }).pipe(Effect.withSpan('Access.sweepKeyChanges')),
  };
};
