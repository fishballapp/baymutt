// Plans: how a CLI login asks the owner for anything. `baymutt ask` sends one plan: a reason and
// ordered steps, all in one org. The owner decides each step whole, on one page, and may leave a
// note for the agent. A step that needs an environment an earlier step makes waits for that one.
// Nothing a plan names happens before its step is approved, but for a step that only gives access
// back.

import { coded, ErrorMessageSchema } from '@internal/effect-api';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import {
  CredentialGrantSchema,
  KeyOrgSchema,
  newCredential,
  ServiceAccountVouchersSchema,
} from './credentials.ts';
import {
  AlreadyExistsError,
  LimitReachedError,
  LinkSpentError,
  NamesNotSealedError,
  NotFoundError,
  VersionConflictError,
} from './errors.ts';
import {
  base64,
  CiphertextSchema,
  DescriptionSchema,
  ExpirySchema,
  IdSchema,
  KeyProofSchema,
  LabelSchema,
  MAX_VALUE_BYTES,
  NameIndexSchema,
  OrgNamesKeyWrapSchema,
  PublicKeySchema,
  SealedNameSchema,
  SealedSchema,
  StoredEnvironmentNameSchema,
  StoredSecretNameSchema,
  TimestampSchema,
  VersionSchema,
  VoucherSchema,
  WrapSchema,
} from './fields.ts';
import { Authenticated, Credentials, OwnerRequiredError } from './guards.ts';

/** How long a plan waits for the owner, in milliseconds. A step unanswered by then has expired. */
export const PLAN_WAIT_MS = 3600 * 1000;

export const MAX_PLAN_STEPS = 20;
export const MAX_STEP_ITEMS = 50;
/** Across every step: a plan is one write, and each value it proposes is a statement of it. */
export const MAX_PLAN_ITEMS = 200;

/** How long a key works once approved, as its maker asks for it: a minute to ten years. */
export const LifetimeSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 60_000, maximum: 315_360_000_000 }),
).annotate({ description: 'Milliseconds from the approval.' });

/** The command a key will be piped into, as the terminal tells it. A claim, shown as one. */
export const CommandSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
).annotate({
  description: 'The command the key is piped into once approved, as its maker tells it.',
});

/** When a new key is to end: a lifetime from the approval, or never. */
export const KeyEndSchema = Schema.Union([Schema.Literal('never'), LifetimeSchema]).annotate({
  description: 'Milliseconds from the approval, or `never`.',
});

/** When a changed key is to end: as `KeyEndSchema`, or `keep` for the end it has. */
export const NewKeyEndSchema = Schema.Union([
  Schema.Literal('keep'),
  Schema.Literal('never'),
  LifetimeSchema,
]).annotate({
  description: 'Milliseconds from the approval, `never`, or `keep` for the end it has.',
});

/** A value a CLI login proposes for a secret, in a vouched box to the owner's account key. */
export const ProposedValueSchema = base64(MAX_VALUE_BYTES + 60).annotate({
  description:
    'A value the CLI login that asked sealed to the owner’s account key, base64. Only the owner’s vault opens it; the store cannot open or make one.',
});

/** Where the owner finds a value to paste: up to 500 characters (1500 bytes) in a vouched box. */
export const SealedHintSchema = base64(1500 + 60).annotate({
  description:
    'Where the owner finds the value to paste, sealed by the CLI login that asked to the owner’s account key, base64. Only the owner’s vault opens it; the store cannot open or make one.',
});

/** What the owner tells the agent when deciding a step: up to 2 KiB of text in a vouched box. */
export const SealedNoteSchema = base64(2048 + 60).annotate({
  description:
    'The owner’s note on a step, sealed by the owner’s account key to the CLI login that asked, base64. The store cannot open or make one.',
});

export const StepStatusSchema = Schema.Literals([
  'pending',
  'approved',
  /** It only gave access back, which needs no approval. */
  'applied',
  'rejected',
  /** Its maker withdrew the plan before it was answered. */
  'cancelled',
  /** Nobody answered it within `PLAN_WAIT_MS` of the plan's `createdAt`. */
  'expired',
]);
export type StepStatus = typeof StepStatusSchema.Type;

// ── What a plan asks for (`POST /plans`) ────────────────────────────────────────────────────────

const stepReason = {
  /** Why this step, when it needs a why of its own; the plan's reason stands otherwise. */
  reason: Schema.optionalKey(DescriptionSchema),
};

const newEnvironmentsStep = Schema.Struct({
  type: Schema.Literal('environments'),
  ...stepReason,
  items: Schema.NonEmptyArray(
    Schema.Union([
      Schema.Struct({
        op: Schema.Literal('create'),
        /** The id the environment is to have. Later steps of this plan name it by this id. */
        environmentId: IdSchema,
        name: NameIndexSchema,
        sealedName: SealedNameSchema,
      }),
      Schema.Struct({
        /** `delete` puts a live environment in the bin; `restore` takes one out of it. */
        op: Schema.Literals(['delete', 'restore']),
        environmentId: Schema.String,
      }),
    ]),
  ).check(Schema.isMaxLength(MAX_STEP_ITEMS)),
});

const newAccessStep = Schema.Struct({
  type: Schema.Literal('access'),
  ...stepReason,
  /** A new key that holds nothing until this step is approved, vouched for by the login that asks. */
  key: Schema.Struct({ ...newCredential, vouchers: ServiceAccountVouchersSchema }),
  /** Null for a key its maker keeps in a file; the command it is piped into otherwise. */
  command: Schema.NullOr(CommandSchema),
  end: KeyEndSchema,
  /** Environments to read, each once. */
  read: Schema.NonEmptyArray(Schema.String).check(Schema.isMaxLength(MAX_STEP_ITEMS)),
});

const newChangeStep = Schema.Struct({
  type: Schema.Literal('change'),
  ...stepReason,
  /** A key this CLI login asked for, of the plan's org, approved and not ended. */
  keyId: Schema.String,
  end: NewKeyEndSchema,
  /** Environments to add, to read. */
  read: Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_STEP_ITEMS)),
  /** Environments the key holds and gives back. */
  giveBack: Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_STEP_ITEMS)),
});

const newSlot = {
  environmentId: Schema.String,
  /** The secret's name, as its index and sealed: the secret need not exist yet. */
  name: NameIndexSchema,
  sealedName: SealedNameSchema,
};

const newSecretsStep = Schema.Struct({
  type: Schema.Literal('secrets'),
  ...stepReason,
  /** Each secret once. */
  items: Schema.NonEmptyArray(
    Schema.Union([
      Schema.Struct({ op: Schema.Literal('set'), ...newSlot, value: ProposedValueSchema }),
      Schema.Struct({
        op: Schema.Literal('paste'),
        ...newSlot,
        /** Where the owner finds the value, such as "Stripe dashboard, Developers, API keys". */
        sealedHint: Schema.optionalKey(SealedHintSchema),
      }),
      Schema.Struct({ op: Schema.Literal('generate'), ...newSlot }),
      Schema.Struct({
        /** `delete` puts a secret in the bin; `restore` takes one out of it. */
        op: Schema.Literals(['delete', 'restore']),
        environmentId: Schema.String,
        name: StoredSecretNameSchema,
      }),
      Schema.Struct({
        op: Schema.Literal('rollback'),
        environmentId: Schema.String,
        name: StoredSecretNameSchema,
        version: VersionSchema,
      }),
    ]),
  ).check(Schema.isMaxLength(MAX_STEP_ITEMS)),
});

export const NewPlanSchema = Schema.Struct({
  id: IdSchema,
  orgId: Schema.String,
  /** The task, in its maker's words. A claim. */
  reason: DescriptionSchema,
  steps: Schema.NonEmptyArray(
    Schema.Union([newEnvironmentsStep, newAccessStep, newChangeStep, newSecretsStep]),
  ).check(Schema.isMaxLength(MAX_PLAN_STEPS)),
}).annotate({ identifier: 'NewPlan' });
export type NewPlan = typeof NewPlanSchema.Type;

// ── A plan as it stands (`GET /plans/:id`) ──────────────────────────────────────────────────────

/** An environment an item names. Its names are null once it was removed for good. */
const planEnvironment = {
  environmentId: Schema.String,
  environmentName: Schema.NullOr(StoredEnvironmentNameSchema),
  environmentSealedName: Schema.NullOr(SealedNameSchema),
};

const step = {
  /** Its place in the plan, from 0. */
  index: Schema.Int,
  /** Its own why; null when the plan's reason stands. */
  reason: Schema.NullOr(DescriptionSchema),
  status: StepStatusSchema,
  /** The owner's note. For the owner and the CLI login that asked; null for anyone else. */
  note: Schema.NullOr(SealedNoteSchema),
  resolvedAt: Schema.NullOr(TimestampSchema),
  /**
   * Earlier steps, still pending, that create or restore an environment this one needs. It
   * cannot be approved while there is one.
   */
  waitsFor: Schema.Array(Schema.Int),
  /**
   * Something it needs is gone and no pending step brings it: an environment whose step was
   * rejected, or one removed for good; a key that has ended. It can only be rejected.
   */
  canOnlyReject: Schema.Boolean,
};

const slot = {
  ...planEnvironment,
  name: StoredSecretNameSchema,
  sealedName: Schema.NullOr(SealedNameSchema),
};

/** The slot a new value is sealed for. Null while the environment does not exist yet. */
const nextSlot = {
  nextVersion: Schema.NullOr(VersionSchema),
  keyVersion: Schema.NullOr(Schema.Int),
};

const keyMaker = Schema.Struct({
  id: Schema.String,
  name: LabelSchema,
  publicKey: PublicKeySchema,
  /** The vault's endorsement of its key, for the owner. */
  endorsement: Schema.NullOr(SealedSchema),
});

export const EnvironmentsStepSchema = Schema.Struct({
  type: Schema.Literal('environments'),
  ...step,
  items: Schema.Array(
    Schema.Struct({ op: Schema.Literals(['create', 'delete', 'restore']), ...planEnvironment }),
  ),
}).annotate({ identifier: 'EnvironmentsStep' });

export const AccessStepSchema = Schema.Struct({
  type: Schema.Literal('access'),
  ...step,
  /** The key it makes: a service account once approved. */
  key: Schema.Struct({
    id: IdSchema,
    name: LabelSchema,
    publicKey: PublicKeySchema,
    /** Its maker vouching for `publicKey` to the owner. Null for any other caller. */
    keyVoucher: Schema.NullOr(VoucherSchema),
    /** When the approved key stops working; null while pending, and for one with no end. */
    expiresAt: Schema.NullOr(TimestampSchema),
  }),
  command: Schema.NullOr(CommandSchema),
  end: KeyEndSchema,
  read: Schema.Array(Schema.Struct(planEnvironment)),
}).annotate({ identifier: 'AccessStep' });

export const ChangeStepSchema = Schema.Struct({
  type: Schema.Literal('change'),
  ...step,
  /** The key it changes, as it is now. */
  key: Schema.Struct({
    id: Schema.String,
    name: LabelSchema,
    intent: Schema.NullOr(Schema.Literals(['service-account', 'agent'])),
    publicKey: PublicKeySchema,
    /** Its maker vouching for `publicKey` to the owner. Null for any other caller. */
    keyVoucher: Schema.NullOr(VoucherSchema),
    /** When it stops working now; null for never. */
    expiresAt: Schema.NullOr(TimestampSchema),
  }),
  /** What the key holds now. */
  holds: Schema.Array(CredentialGrantSchema),
  end: NewKeyEndSchema,
  read: Schema.Array(Schema.Struct(planEnvironment)),
  giveBack: Schema.Array(Schema.Struct(planEnvironment)),
}).annotate({ identifier: 'ChangeStep' });

export const SecretsStepSchema = Schema.Struct({
  type: Schema.Literal('secrets'),
  ...step,
  items: Schema.Array(
    Schema.Union([
      Schema.Struct({
        op: Schema.Literal('set'),
        ...slot,
        ...nextSlot,
        /** For the owner, while the step is pending; null otherwise. */
        value: Schema.NullOr(ProposedValueSchema),
      }),
      Schema.Struct({
        op: Schema.Literal('paste'),
        ...slot,
        ...nextSlot,
        /** For the owner, while the step is pending; null otherwise, and when there is none. */
        sealedHint: Schema.NullOr(SealedHintSchema),
      }),
      Schema.Struct({ op: Schema.Literal('generate'), ...slot, ...nextSlot }),
      Schema.Struct({ op: Schema.Literals(['delete', 'restore']), ...slot }),
      Schema.Struct({ op: Schema.Literal('rollback'), ...slot, version: VersionSchema }),
    ]),
  ),
}).annotate({ identifier: 'SecretsStep' });

export const PlanStepSchema = Schema.Union([
  EnvironmentsStepSchema,
  AccessStepSchema,
  ChangeStepSchema,
  SecretsStepSchema,
]);
export type PlanStep = typeof PlanStepSchema.Type;

export const PlanSchema = Schema.Struct({
  id: IdSchema,
  org: KeyOrgSchema,
  /** The task, in its maker's words. A claim. */
  reason: DescriptionSchema,
  /** The CLI login that asked. */
  maker: keyMaker,
  createdAt: TimestampSchema,
  /** `createdAt` plus `PLAN_WAIT_MS`: a step still pending then has expired. */
  expiresAt: TimestampSchema,
  cancelledAt: Schema.NullOr(TimestampSchema),
  steps: Schema.Array(PlanStepSchema),
}).annotate({ identifier: 'Plan' });
export type Plan = typeof PlanSchema.Type;

// ── The owner's answer to one step ──────────────────────────────────────────────────────────────

const answer = {
  /** What the owner tells the agent, sealed to the CLI login that asked. */
  note: Schema.optionalKey(SealedNoteSchema),
};

/** The owner's proof of an environment's key, and the key wrapped to the reader. */
const readGrant = Schema.Struct({
  environmentId: Schema.String,
  readWrap: WrapSchema,
  keyProof: KeyProofSchema,
  keyVersion: Schema.Int,
});

export const ApproveStepPayloadSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('environments'),
    ...answer,
    /** One per `create` item: the key pair the owner's browser made for it. */
    creates: Schema.Array(
      Schema.Struct({
        environmentId: IdSchema,
        publicKey: PublicKeySchema,
        /** The private key wrapped to the owner's account key: their member copy. */
        memberWrap: WrapSchema,
        /** The owner's proof of `publicKey`, to their own account. */
        memberProof: KeyProofSchema,
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal('access'),
    ...answer,
    /** When the key stops working: the owner's choice, whatever was asked for. Null for no end. */
    expiresAt: Schema.NullOr(ExpirySchema),
    /** One per environment it reads. */
    grants: Schema.Array(readGrant),
    /** The names key of the plan's org, wrapped to the new key. */
    namesKeyWraps: Schema.Array(OrgNamesKeyWrapSchema),
  }),
  Schema.Struct({
    type: Schema.Literal('change'),
    ...answer,
    /** When the key stops working: the owner's choice. Null for no end; absent keeps its end. */
    expiresAt: Schema.optionalKey(Schema.NullOr(ExpirySchema)),
    /** One per environment it adds. */
    grants: Schema.Array(readGrant),
    /** The names key of the key's org when it adds to it, wrapped to the changed key. */
    namesKeyWraps: Schema.Array(OrgNamesKeyWrapSchema),
  }),
  Schema.Struct({
    type: Schema.Literal('secrets'),
    ...answer,
    /**
     * One per `set`, `paste` and `generate` item, sealed by the owner's browser to the
     * environment's key: the proposed value as the vault opened it, the pasted one, or a new
     * random one.
     */
    values: Schema.Array(
      Schema.Struct({
        /** The item's place in the step, from 0. */
        item: Schema.Int,
        /** One above the secret's latest version (1 for a new name): the slot it was sealed for. */
        version: VersionSchema,
        keyVersion: Schema.Int,
        ciphertext: CiphertextSchema,
      }),
    ),
  }),
]).annotate({ identifier: 'ApproveStepPayload' });
export type ApproveStepPayload = typeof ApproveStepPayloadSchema.Type;

/** Something the step needs is not there: a step it waits for is undecided, or what it names is gone. */
export class StepNotApprovableError extends Schema.TaggedError<StepNotApprovableError>()(
  'StepNotApprovableError',
  { message: ErrorMessageSchema },
  { httpApiStatus: 409 },
) {}

const planParam = { id: Schema.String };
const stepParams = {
  ...planParam,
  index: Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
};

export class PlansGroup extends HttpApiGroup.make('plans')
  .add(
    HttpApiEndpoint.get('list', '/plans', {
      query: {
        orgId: Schema.optionalKey(Schema.String).annotate({ description: 'One org’s plans.' }),
      },
      success: Schema.Struct({ plans: Schema.Array(PlanSchema) }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List plans waiting for the owner',
        description:
          'Those with a step still pending. The owner sees every one in their orgs; a CLI login sees those it made.',
      }),
    ),
    HttpApiEndpoint.get('get', '/plans/:id', {
      params: planParam,
      success: PlanSchema,
      error: coded(NotFoundError),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Get a plan',
        description:
          'Answered or not, to the owner or the CLI login that made it. It is how a terminal learns what the owner decided, step by step.',
      }),
    ),
    HttpApiEndpoint.post('create', '/plans', {
      payload: NewPlanSchema,
      success: PlanSchema.pipe(HttpApiSchema.status(201)),
      error: [
        coded(OwnerRequiredError),
        coded(AlreadyExistsError),
        coded(NotFoundError),
        coded(LimitReachedError),
        coded(NamesNotSealedError),
      ],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Ask the owner',
        description:
          'A CLI login only, in an org of its person whose names are sealed. Every environment a step names exists, or an earlier step of the plan creates or restores it. Nothing happens until the owner approves a step, but for a `change` step that only gives access back, which takes effect at once (`applied`). A step left unanswered for an hour expires.',
      }),
    ),
    HttpApiEndpoint.post('approveStep', '/plans/:id/steps/:index/approve', {
      params: stepParams,
      payload: ApproveStepPayloadSchema,
      success: PlanSchema,
      error: [
        coded(NotFoundError),
        coded(OwnerRequiredError),
        coded(LinkSpentError),
        coded(StepNotApprovableError),
        coded(AlreadyExistsError),
        coded(VersionConflictError),
        coded(LimitReachedError),
      ],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Approve a step',
        description:
          'Owner only. Everything the step names happens in one write, exactly as asked; for a key, the owner changes only when it ends. `LinkSpentError` when it was already answered, withdrawn or has expired; `StepNotApprovableError` while a step it waits for is undecided, or when what it names is gone; `VersionConflictError` when a secret was written since the page read it.',
      }),
    ),
    HttpApiEndpoint.post('rejectStep', '/plans/:id/steps/:index/reject', {
      params: stepParams,
      payload: Schema.Struct(answer),
      success: PlanSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError), coded(LinkSpentError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Reject a step',
        description:
          'Owner only. Nothing the step names happens; a key it would have made is revoked.',
      }),
    ),
    HttpApiEndpoint.delete('cancel', '/plans/:id', {
      params: planParam,
      success: PlanSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError), coded(LinkSpentError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Withdraw a plan',
        description:
          'The CLI login that made it. Every step still pending is cancelled; one already answered stays answered. `LinkSpentError` when none is pending.',
      }),
    ),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Plans' })) {}
