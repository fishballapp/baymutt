// How plans are read: the rows of `plan`, `plan_step` and `plan_item`, joined to the environments,
// secrets and keys they name as those are now. A step still pending past the plan's hour reads as
// expired from that moment; what it waits for and whether it can only be rejected are worked out
// here, on every read, from the environments as they are then.
import {
  type ActorIdentity,
  type CredentialGrantSchema,
  NotFoundError,
  PLAN_WAIT_MS,
  type Plan,
  type PlanStep,
  type StepStatus,
} from '@baymutt/api';
import type * as D1Client from '@effect/sql-d1/D1Client';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import { isLogin, orgsOf } from './rows.ts';

export const StepTypeSchema = Schema.Literals(['environments', 'access', 'change', 'secrets']);
export type StepType = typeof StepTypeSchema.Type;

const PlanRowSchema = Schema.Struct({
  id: Schema.String,
  orgId: Schema.String,
  orgSlug: Schema.String,
  reason: Schema.String,
  createdAt: Schema.Finite,
  cancelledAt: Schema.NullOr(Schema.Finite),
  makerId: Schema.String,
  makerName: Schema.String,
  makerPublicKey: Schema.String,
  makerEndorsement: Schema.NullOr(Schema.String),
});
type PlanRow = typeof PlanRowSchema.Type;

const StepRowSchema = Schema.Struct({
  planId: Schema.String,
  position: Schema.Finite,
  type: StepTypeSchema,
  reason: Schema.NullOr(Schema.String),
  status: Schema.Literals(['pending', 'approved', 'applied', 'rejected', 'cancelled', 'expired']),
  note: Schema.NullOr(Schema.String),
  keyId: Schema.NullOr(Schema.String),
  keyEnd: Schema.NullOr(Schema.Literals(['after', 'never', 'keep'])),
  lifetime: Schema.NullOr(Schema.Finite),
  command: Schema.NullOr(Schema.String),
  resolvedAt: Schema.NullOr(Schema.Finite),
  keyName: Schema.NullOr(Schema.String),
  keyPublicKey: Schema.NullOr(Schema.String),
  keyIntent: Schema.NullOr(Schema.Literals(['service-account', 'agent'])),
  keyVoucherOwner: Schema.NullOr(Schema.String),
  keyExpiresAt: Schema.NullOr(Schema.Finite),
  isKeyRevoked: Schema.Finite,
});
export type StepRow = typeof StepRowSchema.Type;

const ItemRowSchema = Schema.Struct({
  planId: Schema.String,
  stepPosition: Schema.Finite,
  position: Schema.Finite,
  op: Schema.Literals([
    'create',
    'delete',
    'restore',
    'read',
    'give-back',
    'set',
    'paste',
    'generate',
    'rollback',
  ]),
  environmentId: Schema.String,
  /** The item's own: the name a `create` gives the environment. */
  itemEnvironmentName: Schema.NullOr(Schema.String),
  itemEnvironmentSealedName: Schema.NullOr(Schema.String),
  secretName: Schema.NullOr(Schema.String),
  /** The item's own: a new value's name, sealed. */
  itemSecretSealedName: Schema.NullOr(Schema.String),
  sealedHint: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.Finite),
  proposedValue: Schema.NullOr(Schema.String),
  /** The environment as it is now, when the plan's org has one with this id. */
  hasEnvironment: Schema.Finite,
  environmentName: Schema.NullOr(Schema.String),
  environmentSealedName: Schema.NullOr(Schema.String),
  isEnvironmentDeleted: Schema.NullOr(Schema.Finite),
  keyVersion: Schema.NullOr(Schema.Finite),
  /** The secret as it is now. */
  hasSecret: Schema.Finite,
  secretSealedName: Schema.NullOr(Schema.String),
  currentVersion: Schema.NullOr(Schema.Finite),
  latestVersion: Schema.NullOr(Schema.Finite),
  /** For a `rollback`: whether the version it names is still kept. */
  hasVersion: Schema.Finite,
});
export type ItemRow = typeof ItemRowSchema.Type;

const HoldingRowSchema = Schema.Struct({
  credentialId: Schema.String,
  environmentId: Schema.String,
  orgId: Schema.String,
  orgSlug: Schema.String,
  environmentName: Schema.String,
  environmentSealedName: Schema.NullOr(Schema.String),
});

const QuerySchema = Schema.Struct({
  accountId: Schema.String,
  id: Schema.NullOr(Schema.String),
  /** The CLI login that made it; null for the owner, who sees every one in their orgs. */
  makerId: Schema.NullOr(Schema.String),
  orgId: Schema.NullOr(Schema.String),
  isPendingOnly: Schema.Boolean,
  /** A plan made at or before this has expired, whatever its steps' rows still say. */
  expiredBy: Schema.Finite,
});
type Query = typeof QuerySchema.Type;

/** What an item needs of its environment for its step to be approved. */
type Need = 'none' | 'live' | 'binned' | 'present';

const NEEDS: Record<StepType, Partial<Record<ItemRow['op'], Need>>> = {
  // A `create` needs its name free, which approving checks: a taken name is an error, not a block.
  environments: { create: 'none', delete: 'live', restore: 'binned' },
  access: { read: 'live' },
  // A key gives back what it holds; an environment removed for good leaves nothing to name.
  change: { read: 'live', 'give-back': 'present' },
  secrets: {
    set: 'live',
    paste: 'live',
    generate: 'live',
    delete: 'live',
    restore: 'live',
    rollback: 'live',
  },
};

/** Whether the secret an item names is as the item needs it, its environment being live. */
const isSecretReady = (item: ItemRow) => {
  if (item.op === 'delete') return item.hasSecret === 1 && item.currentVersion !== null;
  if (item.op === 'restore') return item.hasSecret === 1 && item.currentVersion === null;
  if (item.op === 'rollback') return item.hasVersion === 1;
  return true;
};

const environmentState = (item: ItemRow) => {
  if (item.hasEnvironment === 0) return 'gone';
  return item.isEnvironmentDeleted === 1 ? 'binned' : 'live';
};

/** A plan as the store holds it, for the methods that answer one. */
export type LoadedPlan = {
  readonly plan: Plan;
  readonly steps: ReadonlyArray<StepRow>;
  readonly items: ReadonlyArray<ItemRow>;
};

export const planRows = (sql: D1Client.D1Client) => {
  const matching = ({ accountId, id, makerId, orgId, isPendingOnly, expiredBy }: Query) =>
    sql`p.org_id IN (${orgsOf(sql, accountId)})
      AND (${id} IS NULL OR p.id = ${id})
      AND (${makerId} IS NULL OR p.credential_id = ${makerId})
      AND (${orgId} IS NULL OR p.org_id = ${orgId})
      AND (${isPendingOnly ? 1 : 0} = 0
        OR (p.cancelled_at IS NULL AND p.created_at > ${expiredBy}
          AND EXISTS (SELECT 1 FROM plan_step s WHERE s.plan_id = p.id AND s.status = 'pending')))`;

  const plans = SqlSchema.findAll({
    Request: QuerySchema,
    Result: PlanRowSchema,
    execute: query =>
      sql`SELECT p.id, p.org_id, o.slug AS org_slug, p.reason, p.created_at, p.cancelled_at,
            m.id AS maker_id, m.name AS maker_name, m.public_key AS maker_public_key,
            m.endorsement AS maker_endorsement
          FROM plan p
          JOIN organization o ON o.id = p.org_id
          JOIN credential m ON m.id = p.credential_id
          WHERE ${matching(query)}
          ORDER BY p.created_at`,
  });

  const steps = SqlSchema.findAll({
    Request: QuerySchema,
    Result: StepRowSchema,
    execute: query =>
      sql`SELECT s.plan_id, s.position, s.type, s.reason, s.status, s.note, s.key_id, s.key_end,
            s.lifetime, s.command, s.resolved_at, k.name AS key_name,
            k.public_key AS key_public_key, k.intent AS key_intent, k.key_voucher_owner,
            k.expires_at AS key_expires_at, k.revoked_at IS NOT NULL AS is_key_revoked
          FROM plan_step s
          JOIN plan p ON p.id = s.plan_id
          LEFT JOIN credential k ON k.id = s.key_id
          WHERE ${matching(query)}
          ORDER BY p.created_at, s.position`,
  });

  // An environment of another org reads as one that is not there: a plan reaches its own org only.
  const items = SqlSchema.findAll({
    Request: QuerySchema,
    Result: ItemRowSchema,
    execute: query =>
      sql`SELECT i.plan_id, i.step_position, i.position, i.op, i.environment_id,
            i.environment_name AS item_environment_name,
            i.environment_sealed_name AS item_environment_sealed_name, i.secret_name,
            i.secret_sealed_name AS item_secret_sealed_name, i.sealed_hint, i.version, i.proposed_value,
            e.id IS NOT NULL AS has_environment, e.name AS environment_name,
            e.sealed_name AS environment_sealed_name, e.deleted_at IS NOT NULL AS is_environment_deleted,
            e.key_version, sc.name IS NOT NULL AS has_secret, sc.sealed_name AS secret_sealed_name,
            sc.current_version, sc.latest_version,
            i.op = 'rollback' AND EXISTS (SELECT 1 FROM secret_version v
              WHERE v.environment_id = e.id AND v.name = i.secret_name AND v.version = i.version)
              AS has_version
          FROM plan_item i
          JOIN plan p ON p.id = i.plan_id
          LEFT JOIN environment e ON e.id = i.environment_id AND e.org_id = p.org_id
          LEFT JOIN secret sc ON sc.environment_id = e.id AND sc.name = i.secret_name
          WHERE ${matching(query)}
          ORDER BY p.created_at, i.step_position, i.position`,
  });

  /** What the keys `ids` (a JSON array) hold now, on live environments of the person's orgs. */
  const holdings = SqlSchema.findAll({
    Request: Schema.Struct({ accountId: Schema.String, ids: Schema.String }),
    Result: HoldingRowSchema,
    execute: ({ accountId, ids }) =>
      sql`SELECT g.credential_id, g.environment_id, e.org_id, o.slug AS org_slug,
            e.name AS environment_name, e.sealed_name AS environment_sealed_name
          FROM environment_grant g
          JOIN environment e ON e.id = g.environment_id
          JOIN organization o ON o.id = e.org_id
          WHERE g.credential_id IN (SELECT value FROM json_each(${ids}))
            AND e.deleted_at IS NULL AND e.org_id IN (${orgsOf(sql, accountId)})
          ORDER BY o.slug, e.name`,
  });

  const toPlan = ({
    actor,
    row,
    stepRows,
    itemRows,
    held,
    now,
  }: {
    readonly actor: ActorIdentity;
    readonly row: PlanRow;
    readonly stepRows: ReadonlyArray<StepRow>;
    readonly itemRows: ReadonlyArray<ItemRow>;
    readonly held: ReadonlyArray<typeof HoldingRowSchema.Type>;
    readonly now: number;
  }): Plan => {
    const isOwner = actor._tag === 'Owner';
    const isMaker = actor._tag === 'Credential' && actor.credentialId === row.makerId;
    const expiresAt = row.createdAt + PLAN_WAIT_MS;
    const hasExpired = now >= expiresAt;
    const statusOf = (step: StepRow): StepStatus =>
      step.status === 'pending' && hasExpired ? 'expired' : step.status;
    const statuses = new Map(stepRows.map(step => [step.position, statusOf(step)]));

    /** The names a `create` of this plan gives an environment that has no row yet. */
    const created = new Map(
      itemRows
        .filter(item => item.op === 'create')
        .map(item => [
          item.environmentId,
          { name: item.itemEnvironmentName, sealedName: item.itemEnvironmentSealedName },
        ]),
    );
    const environmentOf = (item: ItemRow) => {
      const names =
        item.op === 'create' || item.hasEnvironment === 0
          ? (created.get(item.environmentId) ?? { name: null, sealedName: null })
          : { name: item.environmentName, sealedName: item.environmentSealedName };
      return {
        environmentId: item.environmentId,
        environmentName: names.name,
        environmentSealedName: names.sealedName,
      };
    };

    /** Earlier steps that create or restore `environmentId`, and so make it live. */
    const bringersOf = (environmentId: string, before: number) =>
      itemRows
        .filter(
          item =>
            item.stepPosition < before &&
            item.environmentId === environmentId &&
            // A secret's restore names an environment too, and brings none back.
            item.secretName === null &&
            (item.op === 'create' || item.op === 'restore'),
        )
        .map(item => item.stepPosition);

    const blockers = (step: StepRow) => {
      if (statusOf(step) !== 'pending') return { waitsFor: [], canOnlyReject: false };
      const waitsFor = new Set<number>();
      const isKeyGone =
        step.keyId !== null &&
        (step.isKeyRevoked === 1 ||
          (step.type === 'change' && step.keyExpiresAt !== null && step.keyExpiresAt <= now));
      const isMissing = itemRows
        .filter(item => item.stepPosition === step.position)
        .some(item => {
          const need = NEEDS[step.type][item.op] ?? 'none';
          const state = environmentState(item);
          if (need === 'none') return false;
          if (need === 'binned') return state !== 'binned';
          if (need === 'present') return state === 'gone';
          if (state === 'live') return step.type === 'secrets' && !isSecretReady(item);
          const pending = bringersOf(item.environmentId, step.position).filter(
            position => statuses.get(position) === 'pending',
          );
          for (const position of pending) waitsFor.add(position);
          return pending.length === 0;
        });
      return {
        waitsFor: [...waitsFor].toSorted((one, other) => one - other),
        canOnlyReject: isKeyGone || isMissing,
      };
    };

    const toStep = (step: StepRow): PlanStep => {
      const status = statusOf(step);
      const own = itemRows.filter(item => item.stepPosition === step.position);
      const common = {
        index: step.position,
        reason: step.reason,
        status,
        note: isOwner || isMaker ? step.note : null,
        resolvedAt: step.status === 'pending' && hasExpired ? expiresAt : step.resolvedAt,
        ...blockers(step),
      };
      const keyOf = () => {
        // The table holds a key for an `access` or `change` step, and the key's row with it.
        if (step.keyId === null || step.keyName === null || step.keyPublicKey === null) {
          throw new Error(`plan ${step.planId} step ${step.position} has no key`);
        }
        return {
          id: step.keyId,
          name: step.keyName,
          publicKey: step.keyPublicKey,
          // Sealed to the account key: only the owner's browser opens it, and only it needs to.
          keyVoucher: isOwner ? step.keyVoucherOwner : null,
        };
      };
      const lifetimeOf = () => {
        if (step.lifetime === null) {
          throw new Error(`plan ${step.planId} step ${step.position} ends with no lifetime`);
        }
        return step.lifetime;
      };
      const ofOp = (op: ItemRow['op']) =>
        own.filter(item => item.op === op).map(item => environmentOf(item));
      switch (step.type) {
        case 'environments':
          return {
            type: 'environments',
            ...common,
            items: own.flatMap(item =>
              item.op === 'create' || item.op === 'delete' || item.op === 'restore'
                ? [{ op: item.op, ...environmentOf(item) }]
                : [],
            ),
          };
        case 'access':
          return {
            type: 'access',
            ...common,
            key: { ...keyOf(), expiresAt: status === 'approved' ? step.keyExpiresAt : null },
            command: step.command,
            end: step.keyEnd === 'after' ? lifetimeOf() : 'never',
            read: ofOp('read'),
          };
        case 'change':
          return {
            type: 'change',
            ...common,
            key: { ...keyOf(), intent: step.keyIntent, expiresAt: step.keyExpiresAt },
            holds: held
              .filter(holding => holding.credentialId === step.keyId)
              .map(({ credentialId: _, ...holding }): typeof CredentialGrantSchema.Type => holding),
            end: step.keyEnd === 'after' ? lifetimeOf() : (step.keyEnd ?? 'keep'),
            read: ofOp('read'),
            giveBack: ofOp('give-back'),
          };
        case 'secrets':
          return { type: 'secrets', ...common, items: own.map(secretItem(status)) };
      }
    };

    const secretItem = (status: StepStatus) => (item: ItemRow) => {
      if (item.secretName === null) {
        throw new Error(`plan ${item.planId} item ${item.position} names no secret`);
      }
      const slot = {
        ...environmentOf(item),
        name: item.secretName,
        sealedName:
          item.op === 'set' || item.op === 'paste' || item.op === 'generate'
            ? item.itemSecretSealedName
            : item.secretSealedName,
      };
      // Null while the environment does not exist: no slot to seal for yet.
      const next =
        item.hasEnvironment === 1
          ? { nextVersion: (item.latestVersion ?? 0) + 1, keyVersion: item.keyVersion }
          : { nextVersion: null, keyVersion: null };
      switch (item.op) {
        case 'set':
          return {
            op: item.op,
            ...slot,
            ...next,
            value: isOwner && status === 'pending' ? item.proposedValue : null,
          };
        case 'paste':
          return {
            op: item.op,
            ...slot,
            ...next,
            sealedHint: isOwner && status === 'pending' ? item.sealedHint : null,
          };
        case 'generate':
          return { op: item.op, ...slot, ...next };
        case 'delete':
        case 'restore':
          return { op: item.op, ...slot };
        case 'rollback':
          if (item.version === null) {
            throw new Error(`plan ${item.planId} item ${item.position} rolls back to no version`);
          }
          return { op: item.op, ...slot, version: item.version };
        default:
          throw new Error(`plan ${item.planId}: a secrets step holds a ${item.op} item`);
      }
    };

    return {
      id: row.id,
      org: { id: row.orgId, slug: row.orgSlug },
      reason: row.reason,
      maker: {
        id: row.makerId,
        name: row.makerName,
        publicKey: row.makerPublicKey,
        endorsement: isOwner ? row.makerEndorsement : null,
      },
      createdAt: row.createdAt,
      expiresAt,
      cancelledAt: row.cancelledAt,
      steps: stepRows.map(toStep),
    };
  };

  /** Plans as they stand now, with the rows they were read from. */
  const load = Effect.fnUntraced(function* (
    actor: ActorIdentity,
    filter: Omit<Query, 'accountId' | 'expiredBy' | 'makerId'>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const query = {
      ...filter,
      accountId: actor.accountId,
      // A CLI login sees the plans it made, and the owner every one in their orgs.
      makerId: actor._tag === 'Credential' ? actor.credentialId : null,
      expiredBy: now - PLAN_WAIT_MS,
    };
    const [planList, stepList, itemList] = yield* Effect.all(
      [plans(query), steps(query), items(query)],
      { concurrency: 3 },
    ).pipe(Effect.orDie);
    const keyIds = stepList.flatMap(step =>
      step.type === 'change' && step.keyId !== null ? [step.keyId] : [],
    );
    const held =
      keyIds.length === 0
        ? []
        : yield* holdings({ accountId: actor.accountId, ids: JSON.stringify(keyIds) }).pipe(
            Effect.orDie,
          );
    return planList.map((row): LoadedPlan => {
      const stepRows = stepList.filter(step => step.planId === row.id);
      const itemRows = itemList.filter(item => item.planId === row.id);
      return {
        plan: toPlan({ actor, row, stepRows, itemRows, held, now }),
        steps: stepRows,
        items: itemRows,
      };
    });
  });

  /** A plan the caller may see: the owner any in their orgs, a CLI login those it made. */
  const visible = Effect.fnUntraced(function* (actor: ActorIdentity, id: string) {
    const notFound = new NotFoundError({ message: 'No plan of yours has this id.' });
    if (actor._tag === 'Credential' && !isLogin(actor)) return yield* notFound;
    const [found] = yield* load(actor, { id, orgId: null, isPendingOnly: false });
    if (found === undefined) return yield* notFound;
    return found;
  });

  const list = Effect.fnUntraced(function* (actor: ActorIdentity, orgId: string | null) {
    if (actor._tag === 'Credential' && !isLogin(actor)) return [];
    const found = yield* load(actor, { id: null, orgId, isPendingOnly: true });
    return found.map(({ plan }) => plan);
  });

  return { visible, list };
};
