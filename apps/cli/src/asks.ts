// An ask from the terminal's side, once sent: what this computer kept of it, and where the owner
// answers it. `baymutt ask` keeps, before it sends, what each step asked for in an owner-only file
// beside the keys (`<ask id>.ask`); `ask wait` checks the store's answer against that record,
// never against what the store says the ask was, and notes there each step it has finished.
import type { Ask } from '@baymutt/api';
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

const KeptAskSchema = Schema.Struct({
  id: Schema.String,
  steps: Schema.Array(
    Schema.Struct({
      asked: AskedStepSchema,
      /** What `ask wait` printed when it finished the step: printed again, never done twice. */
      ended: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});
export type KeptAsk = typeof KeptAskSchema.Type;
const KeptAskFileSchema = Schema.fromJsonString(KeptAskSchema);

/** `id` as typed, refused unless it is an id: it reaches the store's paths and this computer's files. */
export const checkedId = (id: string) =>
  isId(id)
    ? Effect.succeed(id)
    : Effect.fail(usage(`${id} is not the id of an ask: \`baymutt ask\` printed a UUID.`));

/** Where an ask's record is kept: only ever for an id, as a key file is. */
const recordFileOf = Effect.fn('asks.recordFile')(function* (id: string) {
  if (!isId(id)) return yield* usage(`${id} is not the id of an ask.`);
  return `${yield* keyFileOf(id)}.ask`;
});

/**
 * Keeps what an ask asks for, before it is sent, and again as `ask wait` finishes its steps. The
 * record is written whole beside itself and renamed over, so a kill or a full disk in the middle
 * leaves the record as it was, never half of one that no wait could decode.
 */
export const keepAsk = Effect.fn('asks.keep')(function* (ask: KeptAsk) {
  const fs = yield* FileSystem.FileSystem;
  const { keysDirectory } = yield* Settings;
  yield* fs.makeDirectory(keysDirectory, { recursive: true, mode: 0o700 }).pipe(Effect.orDie);
  const text = yield* Schema.encodeEffect(KeptAskFileSchema)(ask).pipe(Effect.orDie);
  const file = yield* recordFileOf(ask.id);
  const beside = `${file}.${crypto.randomUUID()}.tmp`;
  yield* fs.writeFileString(beside, `${text}\n`, { mode: 0o600 }).pipe(
    Effect.andThen(fs.rename(beside, file)),
    Effect.tapError(() => Effect.ignore(fs.remove(beside))),
    Effect.orDie,
  );
});

/** What ask `id` asked, as kept here; None when it was asked elsewhere or its record is gone. */
export const readAsk = Effect.fn('asks.read')(function* (id: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* recordFileOf(id);
  const text = yield* fs.readFileString(file).pipe(
    Effect.asSome,
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
    Effect.orDie,
  );
  if (Option.isNone(text)) return Option.none<KeptAsk>();
  const kept = yield* Schema.decodeEffect(KeptAskFileSchema)(text.value).pipe(
    Effect.catchTag('SchemaError', () =>
      Effect.fail(usage(`This file is not an ask baymutt kept: ${file}. Fix or delete it.`)),
    ),
  );
  return Option.some(kept);
});

/** Forgets an ask's record, once nothing in it is left to finish. */
export const forgetAsk = Effect.fn('asks.forget')(function* (id: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(yield* recordFileOf(id)).pipe(
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.void),
    Effect.orDie,
  );
});

/** Where the owner answers an ask: its page under the org it asks in. */
export const askUrl = Effect.fn('asks.url')(function* ({ id, org }: Pick<Ask, 'id' | 'org'>) {
  const { origin } = yield* Settings;
  return `${origin}/orgs/${org.slug}/ask/${id}`;
});

/** The key a step makes or changes, or null for one with no key. */
const keyOf = (step: { readonly type: string; readonly key?: { readonly id: string } }) =>
  step.key?.id ?? null;

/**
 * The store's answer about `kept`, refused unless it is that ask: the same id, and the same steps
 * in the same order, each of the same type and making or changing the same key. Files here are
 * found by those ids, so an answer about another ask could hand out or remove what is not its own.
 */
export const checkAnswer = (kept: KeptAsk, ask: Ask) => {
  const isSame =
    ask.id === kept.id &&
    ask.steps.length === kept.steps.length &&
    ask.steps.every((step, index) => {
      const asked = kept.steps[index]?.asked;
      if (asked === undefined || asked.type !== step.type || step.index !== index) return false;
      if (asked.type !== 'access' && asked.type !== 'change') return true;
      return keyOf(step) === asked.keyId;
    });
  return isSame
    ? Effect.succeed(ask)
    : Effect.fail(
        new IntegrityError({
          message: `The store answered about ask ${kept.id} with steps that are not the ones asked here. Nothing here was touched.`,
        }),
      );
};

/**
 * What `baymutt ask` tells the agent once it has sent the ask, in the first thing it prints. The
 * CLI cannot tell a foreground run from a background one, so one paragraph serves both: what to do
 * with the link now, and how a run that was cut off is picked up.
 */
export const nextAfterSending = ({
  id,
  isPending,
  shouldWait,
}: {
  readonly id: string;
  readonly isPending: boolean;
  readonly shouldWait: boolean;
}) => {
  if (!isPending) {
    return shouldWait
      ? 'Nothing waits for the owner: this command prints what each step ended as and what each key holds now, then ends.'
      : `Nothing waits for the owner. Run \`baymutt ask wait ${id}\` to check what each key holds now.`;
  }
  if (shouldWait) {
    return `Send the owner the link now: they see only your reply to them, not this output, so end that reply with the link, alone on its last line, without waiting for this command. This command is still running: it waits for the owner and prints one line per step as they answer it. If your tool call blocked until it ended, it should have been run in the background. If it is stopped first, \`baymutt ask wait ${id}\` picks up every answer and key; nothing is lost.`;
  }
  return `The owner sees only your reply to them, not this output: end that reply with the link, alone on its last line. Each step waits an hour for them. Run \`baymutt ask wait ${id}\` in the background, or after that reply, never before it: a wait that blocks first hides the link.`;
};
