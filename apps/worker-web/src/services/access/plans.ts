// Plans: what `baymutt ask` makes. A CLI login asks the owner for anything in one org at once: a
// reason and ordered steps (create, delete or restore environments; a new key that reads; a change
// to a key it asked for; values to set, paste, generate, delete, roll back or restore). The owner
// approves or rejects each step whole; nothing a step names happens before, but for a change that
// only gives access back. Owns `plan`, `plan_step` and `plan_item`.
import {
  type Actor,
  type ActorIdentity,
  AlreadyExistsError,
  type ApproveStepPayload,
  InvalidRequestError,
  LIMITS,
  LimitReachedError,
  LinkSpentError,
  MAX_PLAN_ITEMS,
  type NewPlan,
  NotFoundError,
  OwnerRequiredError,
  PLAN_WAIT_MS,
  type PlanStep,
  StepNotApprovableError,
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
import { secretWrites } from '../secret-writes.ts';
import { planApprovals, stepWords } from './plan-approvals.ts';
import { type ItemRow, planRows, StepTypeSchema } from './plan-rows.ts';
import { isLogin, type Lookups, namesNotSealed, outsideKeyOrg } from './rows.ts';
import { credentialTaken, insertCredential, revokeStatements } from './service-accounts.ts';

/** Who expires a step nobody answered, or rejects one nobody is left to answer. */
const SYSTEM_ACTOR: Actor = { kind: 'system', id: 'plans', name: 'baymutt' };

/** How long a plan is kept once its last step closed. */
const KEEP_MS = 7 * 24 * 3600 * 1000;

type ItemOp = ItemRow['op'];

/** One item of a new plan as its row is written, and the path an error names it by. */
type NewItem = {
  readonly path: string;
  readonly stepPosition: number;
  readonly position: number;
  readonly op: ItemOp;
  readonly environmentId: string;
  readonly environmentName: string | null;
  readonly environmentSealedName: string | null;
  readonly secretName: string | null;
  readonly secretSealedName: string | null;
  readonly sealedHint: string | null;
  readonly version: number | null;
  readonly proposedValue: string | null;
};

type NewStep = NewPlan['steps'][number];

const blankItem = {
  environmentName: null,
  environmentSealedName: null,
  secretName: null,
  secretSealedName: null,
  sealedHint: null,
  version: null,
  proposedValue: null,
};

/** A step's items as rows, in the order the step lists them. */
const itemsOf = (step: NewStep, stepPosition: number): ReadonlyArray<NewItem> => {
  const at = (field: string, position: number) => `steps[${stepPosition}].${field}[${position}]`;
  switch (step.type) {
    case 'environments':
      return step.items.map((item, position) => ({
        ...blankItem,
        path: at('items', position),
        stepPosition,
        position,
        op: item.op,
        environmentId: item.environmentId,
        ...(item.op === 'create'
          ? { environmentName: item.name, environmentSealedName: item.sealedName }
          : {}),
      }));
    case 'access':
      return step.read.map((environmentId, position) => ({
        ...blankItem,
        path: at('read', position),
        stepPosition,
        position,
        op: 'read' as const,
        environmentId,
      }));
    case 'change':
      return [
        ...step.read.map((environmentId, position) => ({
          ...blankItem,
          path: at('read', position),
          stepPosition,
          position,
          op: 'read' as const,
          environmentId,
        })),
        ...step.giveBack.map((environmentId, position) => ({
          ...blankItem,
          path: at('giveBack', position),
          stepPosition,
          position: step.read.length + position,
          op: 'give-back' as const,
          environmentId,
        })),
      ];
    case 'secrets':
      return step.items.map((item, position) => ({
        ...blankItem,
        path: at('items', position),
        stepPosition,
        position,
        op: item.op,
        environmentId: item.environmentId,
        secretName: item.name,
        ...('sealedName' in item ? { secretSealedName: item.sealedName } : {}),
        ...('sealedHint' in item ? { sealedHint: item.sealedHint ?? null } : {}),
        ...('version' in item ? { version: item.version } : {}),
        ...('value' in item ? { proposedValue: item.value } : {}),
      }));
  }
};

/** Whether a change step changes nothing but taking access away, which needs no approval. */
const isGiveBackOnly = (step: NewStep) =>
  step.type === 'change' && step.read.length === 0 && step.end === 'keep';

const answered = (step: PlanStep) =>
  new LinkSpentError({
    message: (() => {
      if (step.status === 'expired') {
        return 'This step expired: nobody answered it within an hour of the plan. Its CLI login asks again.';
      }
      if (step.status === 'cancelled') {
        return 'This step was withdrawn: its CLI login cancelled the plan.';
      }
      return `This step was already ${step.status}.`;
    })(),
  });

export const plans = ({
  sql,
  audit,
  lookups,
}: {
  readonly sql: D1Client.D1Client;
  readonly audit: Audit['Service'];
  readonly lookups: Lookups;
}) => {
  const { memberOrg, ownedOrg, approvedServiceAccountIn, underLimit, nameTaken, noChangeWaiting } =
    lookups;
  const { visible, list } = planRows(sql);
  const writes = secretWrites({ sql, audit });
  const { approval, createTaken } = planApprovals({ sql, audit, writes, lookups });

  const environmentRows = SqlSchema.findAll({
    Request: Schema.Struct({ ids: Schema.String, orgId: Schema.String, names: Schema.String }),
    Result: Schema.Struct({
      id: Schema.String,
      orgId: Schema.String,
      name: Schema.String,
      isDeleted: Schema.Finite,
    }),
    // By id in any org, as an id a `create` takes must be free everywhere; by name in this one.
    execute: ({ ids, orgId, names }) =>
      sql`SELECT id, org_id, name, deleted_at IS NOT NULL AS is_deleted FROM environment
          WHERE id IN (SELECT value FROM json_each(${ids}))
            OR (org_id = ${orgId} AND name IN (SELECT value FROM json_each(${names})))`,
  });

  const secretRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      environmentId: Schema.String,
      name: Schema.String,
      currentVersion: Schema.NullOr(Schema.Finite),
    }),
    execute: slots =>
      sql`SELECT s.environment_id, s.name, s.current_version FROM secret s
          JOIN json_each(${slots}) j ON s.environment_id = json_extract(j.value, '$[0]')
            AND s.name = json_extract(j.value, '$[1]')`,
  });

  const versionRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      environmentId: Schema.String,
      name: Schema.String,
      version: Schema.Finite,
    }),
    execute: versions =>
      sql`SELECT v.environment_id, v.name, v.version FROM secret_version v
          JOIN json_each(${versions}) j ON v.environment_id = json_extract(j.value, '$[0]')
            AND v.name = json_extract(j.value, '$[1]') AND v.version = json_extract(j.value, '$[2]')`,
  });

  const takenCredentials = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String }),
    execute: ids =>
      sql`SELECT id FROM credential WHERE id IN (SELECT value FROM json_each(${ids}))`,
  });

  /** What a key holds now on live environments: what a change adds to and gives back from. */
  const grantsOf = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ environmentId: Schema.String, canRead: Schema.Finite }),
    execute: keyId =>
      sql`SELECT g.environment_id, g.read_wrap IS NOT NULL AS can_read FROM environment_grant g
          JOIN environment e ON e.id = g.environment_id
          WHERE g.credential_id = ${keyId} AND e.deleted_at IS NULL`,
  });

  /** Plans of an org with a step still waiting for the owner. */
  const waitingPlans = SqlSchema.findAll({
    Request: Schema.Struct({ orgId: Schema.String, expiredBy: Schema.Finite }),
    Result: Schema.Struct({ count: Schema.Finite }),
    execute: ({ orgId, expiredBy }) =>
      sql`SELECT COUNT(*) AS count FROM plan p
          WHERE p.org_id = ${orgId} AND p.cancelled_at IS NULL AND p.created_at > ${expiredBy}
            AND EXISTS (SELECT 1 FROM plan_step s WHERE s.plan_id = p.id AND s.status = 'pending')`,
  });

  /**
   * Steps still pending that the daily run closes: those past their plan's hour, and those of a
   * plan whose CLI login has ended, which nobody is left to answer.
   */
  const stepsToClose = SqlSchema.findAll({
    Request: Schema.Finite,
    Result: Schema.Struct({
      id: Schema.String,
      orgId: Schema.String,
      position: Schema.Finite,
      type: StepTypeSchema,
      keyName: Schema.NullOr(Schema.String),
      hasExpired: Schema.Finite,
    }),
    execute: now =>
      sql`SELECT p.id, p.org_id, s.position, s.type, k.name AS key_name,
            p.created_at <= ${now - PLAN_WAIT_MS} AS has_expired
          FROM plan p JOIN plan_step s ON s.plan_id = p.id
          JOIN credential m ON m.id = p.credential_id
          LEFT JOIN credential k ON k.id = s.key_id
          WHERE s.status = 'pending'
            AND (p.created_at <= ${now - PLAN_WAIT_MS}
              OR (m.expires_at IS NOT NULL AND m.expires_at <= ${now}))
          ORDER BY p.id, s.position`,
  });

  /** A step still waiting at `now`: pending, in a plan neither withdrawn nor past its hour. */
  const isStepPending = (planId: string, position: number, now: number) =>
    sql`EXISTS (SELECT 1 FROM plan_step s JOIN plan p ON p.id = s.plan_id
      WHERE s.plan_id = ${planId} AND s.position = ${position} AND s.status = 'pending'
        AND p.cancelled_at IS NULL AND p.created_at > ${now - PLAN_WAIT_MS})`;

  /** The steps the answer `answerId` took out of pending. */
  const answeredBy = (planId: string, answerId: string) =>
    sql`SELECT position FROM plan_step WHERE plan_id = ${planId} AND answer_id = ${answerId}`;

  const hasAnswered = (planId: string, answerId: string) =>
    sql`EXISTS (${answeredBy(planId, answerId)})`;

  /**
   * What closing steps unapproved writes beside their status: their proposed values and hints go, and a key
   * an `access` step made is revoked, as a rejected request's is. All only if `answerId` took.
   */
  const closingStatements = (planId: string, answerId: string, now: number) => [
    sql`UPDATE plan_item SET proposed_value = NULL, sealed_hint = NULL
        WHERE plan_id = ${planId} AND step_position IN (${answeredBy(planId, answerId)})`,
    ...revokeStatements(sql, {
      ids: sql`SELECT key_id FROM plan_step
        WHERE plan_id = ${planId} AND answer_id = ${answerId} AND type = 'access'`,
      now,
      onlyIf: hasAnswered(planId, answerId),
    }),
  ];

  const ownersStep = Effect.fnUntraced(function* (
    actor: ActorIdentity,
    id: string,
    index: number,
    what: string,
  ) {
    if (actor._tag !== 'Owner') {
      return yield* new OwnerRequiredError({
        message: `Only the owner ${what}, from the dashboard.`,
      });
    }
    const loaded = yield* visible(actor, id);
    yield* ownedOrg(actor, loaded.plan.org.id, what);
    const step = loaded.plan.steps[index];
    const row = loaded.steps[index];
    if (step === undefined || row === undefined) {
      return yield* new NotFoundError({
        message: `This plan has ${loaded.plan.steps.length} steps, numbered from 0.`,
      });
    }
    return { loaded, step, row };
  });

  /** Why a step cannot be approved now, or nothing when it can. */
  const notApprovable = (step: PlanStep) => {
    if (step.waitsFor.length > 0) {
      return new StepNotApprovableError({
        message: `Step ${step.index} waits for step ${step.waitsFor.join(', ')}, which creates or restores an environment it names. Approve or reject that first.`,
      });
    }
    if (step.canOnlyReject) {
      return new StepNotApprovableError({
        message: `Something step ${step.index} needs is gone: an environment whose step was rejected or that was removed, a secret that moved, or a key that ended or was revoked. It can only be rejected; the CLI login asks again.`,
      });
    }
    return null;
  };

  /** Why an approval's batch did not take, read again after it. */
  const failure = Effect.fnUntraced(function* (
    actor: ActorIdentity,
    id: string,
    index: number,
    answer: ApproveStepPayload,
  ) {
    const loaded = yield* visible(actor, id).pipe(Effect.orDie);
    const { plan } = loaded;
    const items = loaded.items.filter(item => item.stepPosition === index);
    const step = plan.steps[index];
    if (step === undefined) return yield* Effect.die(`plan ${id} lost step ${index}`);
    if (step.status !== 'pending') return yield* answered(step);
    const blocked = notApprovable(step);
    if (blocked !== null) return yield* blocked;
    if (answer.type === 'environments') {
      const taken = yield* createTaken({ loaded, items });
      if (taken !== null) return yield* taken;
    }
    if (answer.type === 'secrets' && step.type === 'secrets') {
      for (const value of answer.values) {
        const item = step.items[value.item];
        if (item !== undefined && 'nextVersion' in item && item.nextVersion !== value.version) {
          return yield* yield* writes.conflict(item);
        }
      }
    }
    return yield* new StepNotApprovableError({
      message: `What step ${index} names changed while it was being approved. Read the plan again.`,
    });
  });

  return {
    listPlans: Effect.fn('Access.listPlans')(function* ({
      actor,
      orgId,
    }: {
      readonly actor: ActorIdentity;
      readonly orgId: string | null;
    }) {
      return yield* list(actor, orgId);
    }),

    getPlan: Effect.fn('Access.getPlan')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      return (yield* visible(actor, id)).plan;
    }),

    createPlan: Effect.fn('Access.createPlan')(function* ({
      actor,
      plan,
    }: {
      readonly actor: ActorIdentity;
      readonly plan: NewPlan;
    }) {
      if (actor._tag !== 'Credential' || !isLogin(actor)) {
        return yield* new OwnerRequiredError({
          message:
            actor._tag === 'Owner'
              ? 'A plan is a CLI login’s: it asks the owner. The owner does what a plan would from the dashboard.'
              : 'A key cannot ask the owner. Ask from a CLI login: `baymutt ask`.',
        });
      }
      const login = actor.credentialId;
      const org = yield* memberOrg(actor, plan.orgId);
      if (!org.areNamesSealed) return yield* namesNotSealed(org.slug);
      const invalid = (message: string) => new InvalidRequestError({ message });
      const items = plan.steps.flatMap((step, position) => itemsOf(step, position));
      if (items.length > MAX_PLAN_ITEMS) {
        return yield* invalid(
          `A plan names up to ${MAX_PLAN_ITEMS} things across its steps, and this one names ${items.length}. Ask for the rest in another plan.`,
        );
      }

      const creates = items.filter(item => item.op === 'create');
      const environments = yield* environmentRows({
        ids: JSON.stringify([...new Set(items.map(item => item.environmentId))]),
        orgId: plan.orgId,
        names: JSON.stringify(creates.map(item => item.environmentName)),
      }).pipe(Effect.orDie);
      /** An environment of the plan's org, as it is now. */
      const inOrg = (environmentId: string) =>
        environments.find(row => row.id === environmentId && row.orgId === plan.orgId);
      /** Whether an earlier step creates or restores it, which leaves it live once approved. */
      const isBrought = (environmentId: string, before: number) =>
        items.some(
          item =>
            item.stepPosition < before &&
            item.environmentId === environmentId &&
            // A secret's restore names an environment too, and brings none back.
            item.secretName === null &&
            (item.op === 'create' || item.op === 'restore'),
        );

      const slotsNamed = items.filter(
        item => item.op === 'delete' || item.op === 'restore' || item.op === 'rollback',
      );
      const [secrets, versions] = yield* Effect.all(
        [
          secretRows(JSON.stringify(slotsNamed.map(item => [item.environmentId, item.secretName]))),
          versionRows(
            JSON.stringify(
              slotsNamed
                .filter(item => item.op === 'rollback')
                .map(item => [item.environmentId, item.secretName, item.version]),
            ),
          ),
        ],
        { concurrency: 2 },
      ).pipe(Effect.orDie);

      for (const [index, step] of plan.steps.entries()) {
        const own = items.filter(item => item.stepPosition === index);
        const named = own.map(item =>
          step.type === 'secrets'
            ? `${item.environmentId}\u0000${item.secretName}`
            : item.environmentId,
        );
        if (new Set(named).size !== named.length) {
          return yield* invalid(
            step.type === 'secrets'
              ? `steps[${index}]: a step names each secret once.`
              : `steps[${index}]: a step names each environment once.`,
          );
        }
        for (const item of own) {
          const environment = inOrg(item.environmentId);
          if (item.op === 'create') {
            const earlier = creates.filter(other => other.stepPosition < index);
            if (
              earlier.some(
                other =>
                  other.environmentId === item.environmentId ||
                  other.environmentName === item.environmentName,
              )
            ) {
              return yield* new AlreadyExistsError({
                message: `${item.path}: an earlier step creates an environment with this id or name.`,
              });
            }
            // Two of one name in a step would make one and be approved as both.
            if (
              own.some(
                other =>
                  other !== item &&
                  other.op === 'create' &&
                  other.environmentName === item.environmentName,
              )
            ) {
              return yield* new AlreadyExistsError({
                message: `${item.path}: this step already creates an environment with this name.`,
              });
            }
            if (
              environments.some(
                row =>
                  row.id === item.environmentId ||
                  (row.orgId === plan.orgId && row.name === item.environmentName),
              )
            ) {
              return yield* yield* nameTaken({
                id: item.environmentId,
                orgId: plan.orgId,
                orgSlug: org.slug,
                name: item.environmentName ?? '',
              });
            }
            continue;
          }
          if (item.op === 'restore' && step.type === 'environments') {
            if (environment?.isDeleted !== 1) {
              return yield* new NotFoundError({
                message: `${item.path}: no environment in the bin of ${org.slug} has this id. See the bin with \`baymutt bin list\`.`,
              });
            }
            continue;
          }
          if (item.op === 'give-back') continue;
          if (environment?.isDeleted !== 0 && !isBrought(item.environmentId, index)) {
            return yield* new NotFoundError({
              message: `${item.path}: no live environment of ${org.slug} has this id, and no earlier step creates or restores it. List them with \`baymutt env list\`.`,
            });
          }
          if (item.op === 'delete' || item.op === 'restore' || item.op === 'rollback') {
            if (step.type !== 'secrets') continue;
            const secret = secrets.find(
              row => row.environmentId === item.environmentId && row.name === item.secretName,
            );
            const isReady = (() => {
              if (item.op === 'delete') {
                return secret !== undefined && secret.currentVersion !== null;
              }
              if (item.op === 'restore') {
                return secret !== undefined && secret.currentVersion === null;
              }
              return versions.some(
                row =>
                  row.environmentId === item.environmentId &&
                  row.name === item.secretName &&
                  row.version === item.version,
              );
            })();
            if (!isReady) {
              return yield* new NotFoundError({
                message: (() => {
                  if (item.op === 'delete') {
                    return `${item.path}: this environment has no secret by this name to delete. List them with \`baymutt secret list <environment>\`.`;
                  }
                  if (item.op === 'restore') {
                    return `${item.path}: no secret by this name is in this environment’s bin. See it with \`baymutt bin list\`.`;
                  }
                  return `${item.path}: this secret has no version ${item.version}. See its history with \`baymutt secret history\`.`;
                })(),
              });
            }
          }
        }
        if (step.type !== 'change') continue;
        const key = yield* approvedServiceAccountIn(actor.accountId, step.keyId).pipe(
          Effect.catchTag('NotFoundError', () => Effect.succeed(null)),
        );
        if (key === null || key.parentId !== login) {
          return yield* new NotFoundError({
            message: `steps[${index}].keyId: no key this CLI login asked for, approved and not revoked, has this id. List them with \`baymutt key list\`.`,
          });
        }
        if (key.orgId !== plan.orgId) {
          return yield* invalid(
            `steps[${index}]: ${outsideKeyOrg(key.orgSlug ?? 'another org', 'a plan changes keys of its own org only')}`,
          );
        }
        const now = yield* Clock.currentTimeMillis;
        if (key.expiresAt !== null && key.expiresAt <= now) {
          return yield* invalid(
            `steps[${index}]: ${key.name} has ended, so it does not change. Ask for a new key in an \`access\` step.`,
          );
        }
        if (
          plan.steps.some(
            (other, position) =>
              position !== index && other.type === 'change' && other.keyId === step.keyId,
          )
        ) {
          return yield* invalid(`steps[${index}]: a plan changes each key in one step.`);
        }
        yield* noChangeWaiting(key);
        if (step.read.length === 0 && step.giveBack.length === 0 && step.end === 'keep') {
          return yield* invalid(
            `steps[${index}]: a change reads more, gives some back, or asks for a new end.`,
          );
        }
        const held = new Map(
          (yield* grantsOf(key.id).pipe(Effect.orDie)).map(grant => [
            grant.environmentId,
            grant.canRead === 1,
          ]),
        );
        for (const item of own) {
          if (item.op === 'read' && held.get(item.environmentId) === true) {
            return yield* invalid(`${item.path}: ${key.name} already reads this environment.`);
          }
          if (item.op === 'give-back' && !held.has(item.environmentId)) {
            return yield* invalid(
              `${item.path}: ${key.name} does not hold this environment. See what it holds with \`baymutt key list\`.`,
            );
          }
        }
      }

      const accessSteps = plan.steps.flatMap(step => (step.type === 'access' ? [step] : []));
      const keyIds = accessSteps.map(step => step.key.id);
      if (new Set(keyIds).size !== keyIds.length) {
        return yield* invalid('Each `access` step makes a key of its own: give each a new id.');
      }
      if ((yield* takenCredentials(JSON.stringify(keyIds)).pipe(Effect.orDie)).length > 0) {
        return yield* credentialTaken();
      }
      if (accessSteps.length > 0) {
        yield* underLimit(actor.accountId, 'serviceAccounts', accessSteps.length);
      }
      // Counted before the write, so two at once can overshoot by one: a cap on growth.
      const [waiting] = yield* waitingPlans({
        orgId: plan.orgId,
        expiredBy: (yield* Clock.currentTimeMillis) - PLAN_WAIT_MS,
      }).pipe(Effect.orDie);
      if ((waiting?.count ?? 0) >= LIMITS.waitingPlansPerOrg) {
        return yield* new LimitReachedError({
          limit: LIMITS.waitingPlansPerOrg,
          message: `Up to ${LIMITS.waitingPlansPerOrg} plans wait for the owner in one org at once. Withdraw one with \`baymutt ask cancel <id>\`, or wait for the owner to answer.`,
        });
      }

      const now = yield* Clock.currentTimeMillis;
      const by = actorOf(actor);
      const made = sql`EXISTS (SELECT 1 FROM plan
        WHERE id = ${plan.id} AND credential_id = ${login} AND created_at = ${now})`;
      const keyOf = (step: NewStep) => {
        if (step.type === 'access') return step.key.id;
        if (step.type === 'change') return step.keyId;
        return null;
      };
      const endOf = (step: NewStep) => {
        if (step.type !== 'access' && step.type !== 'change') {
          return { keyEnd: null, lifetime: null };
        }
        if (typeof step.end === 'number') return { keyEnd: 'after', lifetime: step.end };
        return { keyEnd: step.end, lifetime: null };
      };
      const stepRows = plan.steps.map((step, position) => ({
        position,
        type: step.type,
        reason: step.reason ?? null,
        status: isGiveBackOnly(step) ? 'applied' : 'pending',
        keyId: keyOf(step),
        ...endOf(step),
        command: step.type === 'access' ? step.command : null,
        resolvedAt: isGiveBackOnly(step) ? now : null,
      }));
      const field = (name: string) => sql`json_extract(j.value, ${`$.${name}`})`;
      // A proposed value is bound on its own: a list of them could outgrow one parameter.
      const withValue = items.filter(item => item.proposedValue !== null);
      const itemStatement = (rows: Statement.Fragment) =>
        sql`INSERT OR IGNORE INTO plan_item
              (plan_id, step_position, position, op, environment_id, environment_name,
               environment_sealed_name, secret_name, secret_sealed_name, sealed_hint, version,
               proposed_value)
            SELECT ${plan.id}, ${field('stepPosition')}, ${field('position')}, ${field('op')},
              ${field('environmentId')}, ${field('environmentName')},
              ${field('environmentSealedName')}, ${field('secretName')},
              ${field('secretSealedName')}, ${field('sealedHint')}, ${field('version')},
              ${field('proposedValue')}
            FROM ${rows} WHERE ${made}`;
      const giveBacks = plan.steps.flatMap((step, position) =>
        isGiveBackOnly(step) && step.type === 'change'
          ? step.giveBack.map(environmentId => ({ keyId: step.keyId, position, environmentId }))
          : [],
      );
      const keyNames = new Map(
        yield* Effect.forEach(
          [...new Set(giveBacks.map(giveBack => giveBack.keyId))],
          keyId =>
            approvedServiceAccountIn(actor.accountId, keyId).pipe(
              Effect.orDie,
              Effect.map(key => [keyId, key.name] as const),
            ),
          { concurrency: 1 },
        ),
      );

      // One batch: the plan, the keys its `access` steps make (which hold nothing until their step
      // is approved), its steps and items, and what a give-back-only change does at once.
      const [inserted] = yield* sql
        .batch([
          sql`INSERT INTO plan (id, org_id, credential_id, reason, created_at)
              SELECT ${plan.id}, ${plan.orgId}, ${login}, ${plan.reason}, ${now}
              WHERE NOT EXISTS (SELECT 1 FROM credential
                                WHERE id IN (SELECT value FROM json_each(${JSON.stringify(keyIds)})))
                -- The login may have been revoked since this request was recognised: a plan made
                -- after that would outlive it, with a key nothing revokes.
                AND EXISTS (SELECT 1 FROM credential WHERE id = ${login} AND revoked_at IS NULL)
              ON CONFLICT (id) DO NOTHING
              RETURNING id`,
          ...accessSteps.map(({ key: { vouchers, ...key }, command, reason }) =>
            insertCredential(sql, {
              accountId: actor.accountId,
              credential: { ...key, description: reason ?? plan.reason },
              now,
              parentId: login,
              vouchers,
              // A key piped into a command is for another system, one kept in a file for the agent.
              intent: command === null ? 'agent' : 'service-account',
              orgId: plan.orgId,
              onlyIf: made,
            }),
          ),
          sql`INSERT OR IGNORE INTO plan_step
                (plan_id, position, type, reason, status, key_id, key_end, lifetime, command,
                 resolved_at)
              SELECT ${plan.id}, ${field('position')}, ${field('type')}, ${field('reason')},
                ${field('status')}, ${field('keyId')}, ${field('keyEnd')}, ${field('lifetime')},
                ${field('command')}, ${field('resolvedAt')}
              FROM json_each(${JSON.stringify(stepRows)}) j WHERE ${made}`,
          itemStatement(
            sql`json_each(${JSON.stringify(
              items.filter(item => item.proposedValue === null).map(({ path: _, ...item }) => item),
            )}) j`,
          ),
          ...withValue.map(({ path: _, ...item }) =>
            itemStatement(sql`json_each(json_array(json(${JSON.stringify(item)}))) j`),
          ),
          ...(yield* Effect.forEach(
            giveBacks,
            Effect.fnUntraced(function* ({ keyId, environmentId }) {
              return [
                yield* audit.entry(
                  {
                    orgId: plan.orgId,
                    actor: by,
                    action: 'grant.remove',
                    environmentId,
                    detail: keyNames.get(keyId) ?? keyId,
                  },
                  sql`${made} AND EXISTS (SELECT 1 FROM environment_grant
                    WHERE environment_id = ${environmentId} AND credential_id = ${keyId})`,
                ),
                sql`DELETE FROM environment_grant
                    WHERE environment_id = ${environmentId} AND credential_id = ${keyId}
                      AND ${made}`,
              ];
            }),
            { concurrency: 1 },
          )).flat(),
          yield* audit.entry(
            { orgId: plan.orgId, actor: by, action: 'plan.create', detail: plan.reason },
            made,
          ),
        ])
        .pipe(Effect.orDie);
      if ((inserted ?? []).length === 0) {
        if ((yield* takenCredentials(JSON.stringify(keyIds)).pipe(Effect.orDie)).length > 0) {
          return yield* credentialTaken();
        }
        return yield* new AlreadyExistsError({
          message: 'A plan with this id exists. Ask again: a new plan gets a new id.',
        });
      }
      return (yield* visible(actor, plan.id).pipe(Effect.orDie)).plan;
    }),

    approveStep: Effect.fn('Access.approveStep')(function* ({
      actor,
      id,
      index,
      answer,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly index: number;
      readonly answer: ApproveStepPayload;
    }) {
      const { loaded, step, row } = yield* ownersStep(actor, id, index, 'approves a plan’s step');
      if (step.status !== 'pending') return yield* answered(step);
      const blocked = notApprovable(step);
      if (blocked !== null) return yield* blocked;
      if (answer.type !== step.type) {
        return yield* new InvalidRequestError({
          message: `Step ${index} is a \`${step.type}\` step, and this approves a \`${answer.type}\` one. Read the plan again.`,
        });
      }
      const now = yield* Clock.currentTimeMillis;
      const answerId = crypto.randomUUID();
      const took = sql`EXISTS (SELECT 1 FROM plan_step
        WHERE plan_id = ${id} AND position = ${index} AND answer_id = ${answerId})`;
      const by = actorOf(actor);
      const { precondition, effects, detail } = yield* approval(
        {
          loaded,
          step,
          row,
          items: loaded.items.filter(item => item.stepPosition === index),
          actor: by,
          accountId: actor.accountId,
          now,
          took,
        },
        answer,
      );
      // One batch. The first statement decides it, before anything is written: the step is still
      // pending and everything it names is as approving it needs. The rest is conditioned on that.
      const [approved] = yield* sql
        .batch([
          sql`UPDATE plan_step
              SET status = 'approved', resolved_at = ${now}, note = ${answer.note ?? null},
                answer_id = ${answerId}
              WHERE plan_id = ${id} AND position = ${index} AND ${isStepPending(id, index, now)}
                AND ${precondition}
              RETURNING position`,
          sql`UPDATE plan_item SET proposed_value = NULL, sealed_hint = NULL
              WHERE plan_id = ${id} AND step_position = ${index} AND ${took}`,
          ...effects,
          yield* audit.entry(
            { orgId: loaded.plan.org.id, actor: by, action: 'step.approve', detail },
            took,
          ),
        ])
        .pipe(Effect.orDie);
      if ((approved ?? []).length === 0) return yield* failure(actor, id, index, answer);
      return (yield* visible(actor, id).pipe(Effect.orDie)).plan;
    }),

    rejectStep: Effect.fn('Access.rejectStep')(function* ({
      actor,
      id,
      index,
      note,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly index: number;
      readonly note: string | null;
    }) {
      const { loaded, step, row } = yield* ownersStep(actor, id, index, 'rejects a plan’s step');
      if (step.status !== 'pending') return yield* answered(step);
      const now = yield* Clock.currentTimeMillis;
      const answerId = crypto.randomUUID();
      const [rejected] = yield* sql
        .batch([
          sql`UPDATE plan_step
              SET status = 'rejected', resolved_at = ${now}, note = ${note}, answer_id = ${answerId}
              WHERE plan_id = ${id} AND position = ${index} AND ${isStepPending(id, index, now)}
              RETURNING position`,
          ...closingStatements(id, answerId, now),
          yield* audit.entry(
            {
              orgId: loaded.plan.org.id,
              actor: actorOf(actor),
              action: 'step.reject',
              detail: stepWords(row),
            },
            hasAnswered(id, answerId),
          ),
        ])
        .pipe(Effect.orDie);
      if ((rejected ?? []).length === 0) {
        const after = (yield* visible(actor, id).pipe(Effect.orDie)).plan.steps[index];
        return yield* after === undefined ? Effect.die(`plan ${id} lost a step`) : answered(after);
      }
      return (yield* visible(actor, id).pipe(Effect.orDie)).plan;
    }),

    cancelPlan: Effect.fn('Access.cancelPlan')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      if (actor._tag === 'Owner') {
        return yield* new OwnerRequiredError({
          message:
            'A plan is withdrawn by the CLI login that made it. The owner rejects its steps instead.',
        });
      }
      // A CLI login sees only the plans it made, so one it reaches is its own to withdraw.
      const { plan } = yield* visible(actor, id);
      const spent = new LinkSpentError({
        message: 'No step of this plan still waits: each was answered, withdrawn or has expired.',
      });
      if (!plan.steps.some(step => step.status === 'pending')) return yield* spent;
      const now = yield* Clock.currentTimeMillis;
      const answerId = crypto.randomUUID();
      const took = hasAnswered(id, answerId);
      const [cancelled] = yield* sql
        .batch([
          sql`UPDATE plan_step SET status = 'cancelled', resolved_at = ${now}, answer_id = ${answerId}
              WHERE plan_id = ${id} AND status = 'pending'
                AND EXISTS (SELECT 1 FROM plan WHERE id = ${id} AND cancelled_at IS NULL
                  AND created_at > ${now - PLAN_WAIT_MS})
              RETURNING position`,
          sql`UPDATE plan SET cancelled_at = ${now} WHERE id = ${id} AND ${took}`,
          ...closingStatements(id, answerId, now),
          yield* audit.entry(
            {
              orgId: plan.org.id,
              actor: actorOf(actor),
              action: 'plan.cancel',
              detail: plan.reason,
            },
            took,
          ),
        ])
        .pipe(Effect.orDie);
      if ((cancelled ?? []).length === 0) return yield* spent;
      return (yield* visible(actor, id).pipe(Effect.orDie)).plan;
    }),

    /**
     * The daily run's part. A step nobody answered within `PLAN_WAIT_MS` of its plan has expired
     * already, as everything that reads it sees: here its row says so, its proposed values and
     * hints go, and a key it would have made is revoked. A step of a plan whose CLI login has ended is rejected
     * the same way, as revoking the login does. A plan whose last step closed 7 days ago goes.
     */
    sweepPlans: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const byPlan = Map.groupBy(yield* stepsToClose(now).pipe(Effect.orDie), step => step.id);
      const plans = [...byPlan].map(([id, steps]) => ({
        id,
        steps,
        hasExpired: steps.some(step => step.hasExpired === 1),
      }));
      yield* eachIsolated({
        sweep: 'plan to close',
        rows: plans,
        run: ({ id, steps, hasExpired }) =>
          Effect.gen(function* () {
            const answerId = crypto.randomUUID();
            const isDue = hasExpired
              ? sql`p.created_at <= ${now - PLAN_WAIT_MS}`
              : sql`m.expires_at IS NOT NULL AND m.expires_at <= ${now}`;
            yield* sql
              .batch([
                sql`UPDATE plan_step
                    SET status = ${hasExpired ? 'expired' : 'rejected'}, resolved_at = ${now},
                      answer_id = ${answerId}
                    WHERE plan_id = ${id} AND status = 'pending'
                      AND EXISTS (SELECT 1 FROM plan p JOIN credential m ON m.id = p.credential_id
                        WHERE p.id = ${id} AND ${isDue})`,
                ...closingStatements(id, answerId, now),
                ...(yield* Effect.forEach(
                  steps,
                  step =>
                    audit.entry(
                      {
                        orgId: step.orgId,
                        actor: SYSTEM_ACTOR,
                        action: hasExpired ? 'step.expire' : 'step.reject',
                        detail: stepWords(step),
                      },
                      sql`EXISTS (SELECT 1 FROM plan_step WHERE plan_id = ${id}
                        AND position = ${step.position} AND answer_id = ${answerId})`,
                    ),
                  { concurrency: 1 },
                )),
              ])
              .pipe(Effect.orDie);
          }),
      });
      const removed = yield* sql`DELETE FROM plan WHERE NOT EXISTS (SELECT 1 FROM plan_step
          WHERE plan_id = plan.id AND (status = 'pending' OR resolved_at > ${now - KEEP_MS}))
          RETURNING id`.pipe(Effect.orDie);
      const counts = {
        expired: plans.filter(plan => plan.hasExpired).length,
        rejected: plans.filter(plan => !plan.hasExpired).length,
        removed: removed.length,
      };
      yield* Effect.logInfo('plans swept', counts);
      return counts;
    }).pipe(Effect.withSpan('Access.sweepPlans')),
  };
};
