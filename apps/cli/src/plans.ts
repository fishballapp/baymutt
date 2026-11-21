// A plan from the terminal's side, once sent: what this computer kept of it, and where the owner
// answers it. `baymutt ask` keeps, before it sends, what each step asked for in an owner-only file
// beside the keys (`<plan id>.plan`); `ask wait` checks the store's answer against that record,
// never against what the store says the plan was, and notes there each step it has finished.
import type { Plan } from '@baymutt/api';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { IntegrityError, usage } from './errors.ts';
import { isId, keyFileOf } from './key-files.ts';
import { Settings } from './settings.ts';

const ids = Schema.Array(Schema.String);

/** What one step asked for, as typed here: what its answer is checked against. */
const AskedStepSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('environments') }),
  Schema.Struct({ type: Schema.Literal('access'), keyId: Schema.String, read: ids }),
  Schema.Struct({
    type: Schema.Literal('change'),
    keyId: Schema.String,
    read: ids,
    giveBack: ids,
    asksNewEnd: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal('secrets') }),
]);
export type AskedStep = typeof AskedStepSchema.Type;

const KeptPlanSchema = Schema.Struct({
  id: Schema.String,
  steps: Schema.Array(
    Schema.Struct({
      asked: AskedStepSchema,
      /** What `ask wait` printed when it finished the step: printed again, never done twice. */
      ended: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});
export type KeptPlan = typeof KeptPlanSchema.Type;
const KeptPlanFileSchema = Schema.fromJsonString(KeptPlanSchema);

/** `id` as typed, refused unless it is an id: it reaches the store's paths and this computer's files. */
export const checkedId = (id: string) =>
  isId(id)
    ? Effect.succeed(id)
    : Effect.fail(usage(`${id} is not the id of a plan: \`baymutt ask\` printed a UUID.`));

/** Where a plan's record is kept: only ever for an id, as a key file is. */
const recordFileOf = Effect.fn('plans.recordFile')(function* (id: string) {
  if (!isId(id)) return yield* usage(`${id} is not the id of a plan.`);
  return `${yield* keyFileOf(id)}.plan`;
});

/** Keeps what a plan asks, before it is sent, and again as `ask wait` finishes its steps. */
export const keepPlan = Effect.fn('plans.keep')(function* (plan: KeptPlan) {
  const fs = yield* FileSystem.FileSystem;
  const { keysDirectory } = yield* Settings;
  yield* fs.makeDirectory(keysDirectory, { recursive: true, mode: 0o700 }).pipe(Effect.orDie);
  const text = yield* Schema.encodeEffect(KeptPlanFileSchema)(plan).pipe(Effect.orDie);
  yield* fs
    .writeFileString(yield* recordFileOf(plan.id), `${text}\n`, { mode: 0o600 })
    .pipe(Effect.orDie);
});

/** What plan `id` asked, as kept here; None when it was asked elsewhere or its record is gone. */
export const readPlan = Effect.fn('plans.read')(function* (id: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* recordFileOf(id);
  const text = yield* fs.readFileString(file).pipe(
    Effect.asSome,
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
    Effect.orDie,
  );
  if (Option.isNone(text)) return Option.none<KeptPlan>();
  const kept = yield* Schema.decodeEffect(KeptPlanFileSchema)(text.value).pipe(
    Effect.catchTag('SchemaError', () =>
      Effect.fail(usage(`This file is not a plan baymutt kept: ${file}. Fix or delete it.`)),
    ),
  );
  return Option.some(kept);
});

/** Forgets a plan's record, once nothing in it is left to finish. */
export const forgetPlan = Effect.fn('plans.forget')(function* (id: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(yield* recordFileOf(id)).pipe(
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.void),
    Effect.orDie,
  );
});

/** Where the owner answers a plan: its page under the org it asks in. */
export const planUrl = Effect.fn('plans.url')(function* ({ id, org }: Pick<Plan, 'id' | 'org'>) {
  const { origin } = yield* Settings;
  return `${origin}/orgs/${org.slug}/ask/${id}`;
});

/** The key a step makes or changes, or null for one with no key. */
const keyOf = (step: { readonly type: string; readonly key?: { readonly id: string } }) =>
  step.key?.id ?? null;

/**
 * The store's answer about `kept`, refused unless it is that plan: the same id, and the same steps
 * in the same order, each of the same type and making or changing the same key. Files here are
 * found by those ids, so an answer about another plan could hand out or remove what is not its own.
 */
export const checkAnswer = (kept: KeptPlan, plan: Plan) => {
  const isSame =
    plan.id === kept.id &&
    plan.steps.length === kept.steps.length &&
    plan.steps.every((step, index) => {
      const asked = kept.steps[index]?.asked;
      if (asked === undefined || asked.type !== step.type || step.index !== index) return false;
      if (asked.type !== 'access' && asked.type !== 'change') return true;
      return keyOf(step) === asked.keyId;
    });
  return isSame
    ? Effect.succeed(plan)
    : Effect.fail(
        new IntegrityError({
          message: `The store answered about plan ${kept.id} with steps that are not the ones asked here. Nothing here was touched.`,
        }),
      );
};

/** What an `ask` tells the agent about the link it prints, and the wait that follows. */
export const handOver = (id: string) =>
  `The owner sees only your reply to them, not this output: end that reply with the link, alone on its last line. Each step waits an hour for them. Run \`baymutt ask wait ${id}\` in the background, or after that reply, never before it: a wait that blocks first hides the link.`;
