// `baymutt ask wait` and `ask cancel`: an ask this login sent, followed to the owner's answers.
// Each step is finished and printed as it is answered, whatever the others wait for: an approved
// key is checked and handed out, a changed one is checked against what was asked here, a refused
// key is removed. What each step ended as is noted in the ask's record, so a later wait prints it
// again and never finishes a step twice. One process follows an ask at a time (`ask-lock.ts`).
import type { Ask, AskStep } from '@baymutt/api';
import { openNote } from '@baymutt/keys';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Ref from 'effect/Ref';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import { holdingAsk } from './ask-lock.ts';
import {
  type AskedStep,
  askUrl,
  checkAnswer,
  forgetAsk,
  type KeptAsk,
  keepAsk,
  readAsk,
} from './asks.ts';
import {
  answerFor,
  crypto_,
  describeFailure,
  EXIT_CODES,
  kindOfExitCode,
  type UsageError,
  usage,
} from './errors.ts';
import { addressesOf, checkReads, forgetKey, handOut, keyFileOf } from './key-files.ts';
import { print, printLine } from './output.ts';
import { ServiceAccount } from './service-account.ts';

const POLL_EVERY = Duration.seconds(2);

/** A step that will not be approved: what the agent is told, and the key it made goes. */
const REFUSED = {
  rejected: 'the owner rejected it',
  cancelled: 'it was withdrawn with `baymutt ask cancel`',
  expired: 'nobody answered it within an hour of the ask',
} as const;
const isRefused = (status: string): status is keyof typeof REFUSED =>
  Object.hasOwn(REFUSED, status);

/** What a step's line says when it ended in a failure here, as it is kept in the record. */
const EndedErrorSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  exitCode: Schema.Number,
});

/** One step's line, as `ask wait` prints it. */
type Line = { readonly [field: string]: unknown };

/**
 * The owner's note on `step`, opened with this login's key from the account key it pinned, for this
 * ask, this step and the decision the store reports. One that does not open is never shown.
 */
const noteOf = Effect.fnUntraced(function* (askId: string, step: AskStep) {
  if (step.note === null) return {};
  const unverified = {
    noteError:
      'The owner’s note on this step could not be verified as theirs, so it is not shown. Ask the owner what it said.',
  };
  const { status } = step;
  if (status !== 'approved' && status !== 'rejected') return unverified;
  const { key, pinnedAccount } = yield* ServiceAccount;
  const account = yield* pinnedAccount;
  const ciphertext = step.note;
  return yield* crypto_(() =>
    openNote({
      loginKey: key.privateKey,
      accountPublicKey: account.publicKey,
      step: { askId, stepIndex: step.index, decision: status },
      ciphertext,
    }),
  ).pipe(
    Effect.map(note => ({ note })),
    Effect.orElseSucceed(() => unverified),
  );
});

/** The key file of `keyId`, if this computer holds it: what decides how far a change is checked. */
const keyFileHere = Effect.fn('askAnswers.keyFileHere')(function* (keyId: string) {
  const fs = yield* FileSystem.FileSystem;
  const keyFile = yield* keyFileOf(keyId);
  const token = yield* fs.readFileString(keyFile).pipe(
    Effect.asSome,
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
    Effect.orDie,
  );
  return Option.map(token, text => ({ keyFile, token: text.trim() }));
});

/**
 * A change step that took effect, checked against what was asked here: it changed the key asked
 * for, the key reads every environment it added (opened with the key itself when its file is
 * here), and holds none it gave back. What the store says the step was is not used.
 */
const checkChanged = Effect.fn('askAnswers.checkChanged')(function* (
  asked: Extract<AskedStep, { type: 'change' }>,
  step: Extract<AskStep, { type: 'change' }>,
) {
  const { keyId } = asked;
  const integrity = (what: string) =>
    usage(
      `The store says step ${step.index} ${step.status === 'applied' ? 'took effect' : 'was approved'}, but ${what}. Key ${keyId} may hold what it held before; nothing was taken on the store's word.`,
      'integrity',
    );
  if (step.status === 'applied' && (asked.read.length > 0 || asked.asksNewEnd)) {
    return yield* integrity('only giving back takes effect without the owner');
  }
  const here = yield* keyFileHere(keyId);
  if (Option.isSome(here)) {
    const { keyFile, token } = here.value;
    const listed = yield* checkReads(
      asked.read,
      token,
      integrity(`key ${keyId} does not read what it added with the owner's proof`),
    );
    if (
      asked.giveBack.some(environmentId =>
        listed.some(({ id, canRead }) => id === environmentId && canRead),
      )
    ) {
      return yield* integrity(`key ${keyId} still holds what it gave back`);
    }
    return {
      key: keyId,
      keyFile,
      expiresAt: step.key.expiresAt,
      environments: yield* addressesOf(listed.filter(({ canRead }) => canRead).map(({ id }) => id)),
    };
  }
  // A key whose file is not here, such as a service account's: the owner's proof of each
  // environment opens only with that key, so only the store's own account is checked.
  const { api } = yield* ServiceAccount;
  const { credentials } = yield* api.credentials.list();
  const listed = credentials.find(({ id }) => id === keyId);
  if (listed === undefined) return yield* integrity(`key ${keyId} is not listed`);
  const reads = (environmentId: string) =>
    listed.grants.some(grant => grant.environmentId === environmentId);
  if (!asked.read.every(reads)) {
    return yield* integrity(`the store does not list key ${keyId} reading what it added`);
  }
  if (listed.grants.some(({ environmentId }) => asked.giveBack.includes(environmentId))) {
    return yield* integrity(`the store lists key ${keyId} still holding what it gave back`);
  }
  return {
    key: keyId,
    expiresAt: listed.expiresAt,
    environments: yield* addressesOf(listed.grants.map(({ environmentId }) => environmentId)),
    unchecked:
      'This is the store’s account of what the key holds, checked against what was asked here and nothing more. No file of this key is on this computer, so the owner’s proof of each environment and any read it gained were not checked; its next load is what proves it.',
  };
});

/** What a step the owner approved, or that took effect, ends as here: its key checked and handed out. */
const finish = Effect.fnUntraced(function* (asked: AskedStep, step: AskStep) {
  if (asked.type === 'access' && step.type === 'access') {
    const handedOut: Line = yield* handOut({
      keyId: asked.keyId,
      read: asked.read,
      expiresAt: step.key.expiresAt,
    });
    return handedOut;
  }
  if (asked.type === 'change' && step.type === 'change') {
    const changed: Line = yield* checkChanged(asked, step);
    return changed;
  }
  const nothing: Line = {};
  return nothing;
});

type Ended = {
  readonly line: Line;
  /** Kept in the record: the step is finished and is never finished again. */
  readonly isEnded: boolean;
  /** Why it did not go through: refused by the owner, or failed to finish here. */
  readonly failure: {
    readonly code: string;
    readonly message: string;
    readonly kind: UsageError['kind'];
  } | null;
};

/** One step as it stands: finished here if it was answered, and the line it prints. */
const endStep = Effect.fnUntraced(function* (
  ask: Ask,
  { asked, ended }: KeptAsk['steps'][number],
  step: AskStep,
) {
  const base = {
    index: step.index,
    type: step.type,
    status: step.status,
    ...(yield* noteOf(ask.id, step)),
  };
  const refusal = (status: keyof typeof REFUSED) => ({
    code: 'UsageError',
    message: `Step ${step.index} did not go through: ${REFUSED[status]}.`,
    kind: 'noAccess' as const,
  });
  if (ended !== undefined) {
    const handed = Schema.decodeUnknownOption(EndedErrorSchema)(ended.error);
    // The failure it ended with is told again, as it was.
    const failure = (() => {
      if (Option.isSome(handed)) {
        const { code, message, exitCode } = handed.value;
        return { code, message, kind: kindOfExitCode(exitCode) };
      }
      return isRefused(step.status) ? refusal(step.status) : null;
    })();
    return { line: { ...ended, ...base }, isEnded: true, failure } satisfies Ended;
  }
  if (step.status === 'pending') {
    return { line: base, isEnded: false, failure: null } satisfies Ended;
  }
  if (isRefused(step.status)) {
    if (asked.type === 'access') yield* forgetKey(asked.keyId);
    return { line: base, isEnded: true, failure: refusal(step.status) } satisfies Ended;
  }
  return yield* finish(asked, step).pipe(
    Effect.map(
      (finished): Ended => ({ line: { ...base, ...finished }, isEnded: true, failure: null }),
    ),
    // A step that could not be finished here is that step's end only. A key not proven is tried
    // again by the next wait; a key already taken away (the command failed and it was revoked, or
    // its file is gone) has nothing to try again, so the failure is the step's end, told again as
    // it was.
    Effect.catch(
      Effect.fnUntraced(function* (error) {
        const failure = yield* describeFailure(error);
        const isKeyGone =
          asked.type === 'access' &&
          !(yield* FileSystem.FileSystem.pipe(
            Effect.flatMap(fs => Effect.flatMap(keyFileOf(asked.keyId), file => fs.exists(file))),
            Effect.orDie,
          ));
        return {
          line: {
            ...base,
            error: {
              code: failure.code,
              message: failure.message,
              exitCode: EXIT_CODES[failure.kind],
            },
          },
          isEnded: isKeyGone,
          failure,
        } satisfies Ended;
      }),
    ),
  );
});

/** Forgets the keys of `kept`'s `access` steps not handed out: the ask is gone, or never arrived. */
const forgetUnfinished = (kept: KeptAsk) =>
  Effect.forEach(
    kept.steps,
    ({ asked, ended }) =>
      asked.type === 'access' && ended === undefined ? forgetKey(asked.keyId) : Effect.void,
    { discard: true },
  );

/** The ask `id` this login kept, or a refusal that says why there is none. */
const keptAsk = Effect.fn('askAnswers.kept')(function* (id: string) {
  const kept = yield* readAsk(id);
  if (Option.isNone(kept)) {
    return yield* usage(
      `Ask ${id} was not asked on this computer, or \`baymutt ask wait\` already finished every step of it.`,
      'notFound',
    );
  }
  return kept.value;
});

/** The store has no ask `id`: what was kept for it goes, and the agent asks again. */
const gone = Effect.fnUntraced(function* (kept: KeptAsk) {
  yield* forgetUnfinished(kept);
  yield* forgetAsk(kept.id);
  return yield* usage(
    `Ask ${kept.id} never reached the store, or the store no longer has it, so the owner cannot answer it. The keys it would have made were removed from this computer; run \`baymutt ask\` again.`,
    'notFound',
  );
});

/** Ask `id` as the store has it now; None when it no longer has it. */
const latestOf = Effect.fnUntraced(function* (id: string) {
  const { api } = yield* ServiceAccount;
  return yield* api.asks.get({ params: { id } }).pipe(
    answerFor(id),
    Effect.asSome,
    Effect.catchTag('NotFoundError', () => Effect.succeedNone),
  );
});

/**
 * Follows ask `id` for up to `timeoutMs`, as one process on this computer (a second is refused).
 * Each step is finished and its line printed the moment the owner answers it, so a key is in hand
 * while the owner is still on the steps after it. Fails unless every step went through: with 9
 * while one still waits at the end, with the code of a step that could not be finished here,
 * else with 4.
 */
export const waitForAsk = (id: string, timeoutMs: number) =>
  Effect.scoped(Effect.andThen(holdingAsk(id), followAsk(id, timeoutMs)));

/** What has been finished so far in one wait: the record, and each step's end as printed. */
type Progress = {
  readonly record: KeptAsk;
  readonly ends: ReadonlyArray<Ended | undefined>;
};

/** `waitForAsk` for a process that already holds the ask: `ask` takes it before it prints the link. */
export const followAsk = Effect.fn('askAnswers.follow')(function* (id: string, timeoutMs: number) {
  const kept = yield* keptAsk(id);
  // Each answer is checked as it arrives: one about another ask stops the wait at once.
  const latest = Effect.gen(function* () {
    const answer = yield* latestOf(id);
    if (Option.isNone(answer)) return Option.none<Ask>();
    return Option.some(yield* checkAnswer(kept, answer.value));
  });
  const progress = yield* Ref.make<Progress>({
    record: kept,
    ends: kept.steps.map(() => undefined),
  });

  /**
   * One step, finished and printed if it was answered and this wait has not done so. The record is
   * kept after each, not once at the end: a wait stopped between two steps has already handed out
   * the first, and the next wait must print it as it ended, not hand it out again.
   */
  const finishAnswered = Effect.fnUntraced(function* (ask: Ask, step: AskStep, index: number) {
    const { record, ends } = yield* Ref.get(progress);
    const keptStep = record.steps[index];
    if (keptStep === undefined) {
      return yield* Effect.die(`ask ${id} was checked to have step ${index}`);
    }
    if (ends[index] !== undefined) return;
    if (keptStep.ended === undefined && step.status === 'pending') return;
    const end = yield* endStep(ask, keptStep, step);
    const next: KeptAsk =
      end.isEnded && keptStep.ended === undefined
        ? {
            id,
            steps: record.steps.map((recorded, at) =>
              at === index ? { ...recorded, ended: end.line } : recorded,
            ),
          }
        : record;
    if (next !== record) yield* keepAsk(next);
    yield* Ref.set(progress, {
      record: next,
      ends: ends.map((existing, at) => (at === index ? end : existing)),
    });
    yield* printLine({ ask: id, ...end.line });
  });

  const advance = Effect.gen(function* () {
    const current = yield* latest;
    if (Option.isSome(current)) {
      const ask = current.value;
      yield* Effect.forEach(ask.steps, (step, index) => finishAnswered(ask, step, index), {
        concurrency: 1,
        discard: true,
      });
    }
    return current;
  });
  const isSettled = (current: Option.Option<Ask>) =>
    Option.isNone(current) || current.value.steps.every(step => step.status !== 'pending');
  // Bounded by the schedule, never by interrupting: a step being handed to its command is not cut off.
  const last = yield* timeoutMs === 0
    ? advance
    : advance.pipe(
        Effect.repeat({
          schedule: Schedule.spaced(POLL_EVERY).pipe(
            Schedule.upTo({ duration: Duration.millis(timeoutMs) }),
          ),
          until: isSettled,
        }),
      );
  if (Option.isNone(last)) return yield* gone(kept);
  const ask = last.value;

  // What still waits is told at the end, once.
  yield* Effect.forEach(
    ask.steps,
    Effect.fnUntraced(function* (step, index) {
      const { record, ends } = yield* Ref.get(progress);
      const keptStep = record.steps[index];
      if (ends[index] !== undefined || keptStep === undefined) return;
      yield* printLine({ ask: id, ...(yield* endStep(ask, keptStep, step)).line });
    }),
    { discard: true },
  );
  const { record, ends } = yield* Ref.get(progress);
  if (record.steps.every(({ ended: line }) => line !== undefined)) yield* forgetAsk(id);

  const waiting = ask.steps.filter(step => step.status === 'pending');
  if (waiting.length > 0) {
    return yield* usage(
      `${waiting.length} of ${ask.steps.length} steps still wait for the owner at ${yield* askUrl(ask)} (each waits an hour from when it was asked). Run \`baymutt ask wait ${id}\` to keep waiting; the steps answered so far are done.`,
      'differs',
    );
  }
  const failed = ends.flatMap((end, index) =>
    end?.failure === undefined || end.failure === null ? [] : [{ index, failure: end.failure }],
  );
  const [first] = failed;
  if (first === undefined) return;
  return yield* usage(
    failed.length === 1
      ? first.failure.message
      : `${failed.length} of ${ask.steps.length} steps did not go through: ${failed.map(({ index }) => index).join(', ')}. Each one's line on stdout says why.`,
    // A step that failed here says more than one the owner refused.
    (failed.find(({ failure }) => failure.kind !== 'noAccess') ?? first).failure.kind,
  );
});

/**
 * Removes the keys of `kept`'s refused `access` steps, and its record once no answered step is
 * left for `ask wait` to finish. Answers whether one is.
 */
const clearRefused = Effect.fnUntraced(function* (kept: KeptAsk, answer: Ask) {
  const ask = yield* checkAnswer(kept, answer);
  yield* Effect.forEach(
    ask.steps,
    (step, index) => {
      const asked = kept.steps[index]?.asked;
      return asked?.type === 'access' && isRefused(step.status)
        ? forgetKey(asked.keyId)
        : Effect.void;
    },
    { discard: true },
  );
  const isOpen = ask.steps.some(
    (step, index) =>
      (step.status === 'approved' || step.status === 'applied') &&
      kept.steps[index]?.ended === undefined &&
      (step.type === 'access' || step.type === 'change'),
  );
  if (!isOpen) yield* forgetAsk(kept.id);
  return isOpen;
});

/**
 * Withdraws ask `id`: every step still pending is cancelled, and the keys it would have made go.
 * A step already answered stays answered; one approved and not yet finished is kept for `ask wait`.
 */
export const cancelAsk = Effect.fn('askAnswers.cancel')(function* (id: string) {
  const kept = yield* readAsk(id);
  const { api } = yield* ServiceAccount;
  const cancelled = yield* api.asks.cancel({ params: { id } }).pipe(
    answerFor(id),
    Effect.asSome,
    Effect.catchTag('NotFoundError', error =>
      Option.isSome(kept) ? Effect.succeedNone : Effect.fail(error),
    ),
    // Nothing is left to withdraw; what was refused is cleared all the same.
    Effect.tapErrorTag('LinkSpentError', () =>
      Option.isNone(kept)
        ? Effect.void
        : latestOf(id).pipe(
            Effect.flatMap(ask =>
              Option.isNone(ask) ? Effect.void : clearRefused(kept.value, ask.value),
            ),
            Effect.ignore,
          ),
    ),
  );
  if (Option.isNone(cancelled)) {
    if (Option.isSome(kept)) return yield* gone(kept.value);
    return;
  }
  const ask = cancelled.value;
  const isOpen = Option.isSome(kept) ? yield* clearRefused(kept.value, ask) : false;
  yield* print({
    id,
    status: 'cancelled',
    url: yield* askUrl(ask),
    steps: ask.steps.map(({ index, type, status }) => ({ index, type, status })),
    ...(isOpen
      ? {
          next: `Some steps were answered before the ask was withdrawn: run \`baymutt ask wait ${id}\` to finish them.`,
        }
      : {}),
  });
});
