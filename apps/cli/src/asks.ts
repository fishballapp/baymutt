// `baymutt ask wait`: follows what was asked of the owner, of any kind, to its answer. One id
// answers as it always has; several are waited on together, and each is reported as it is answered.
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import { settleEnvironmentRequest } from './environment-requests.ts';
import { answerFor, describeFailure, EXIT_CODES, type UsageError, usage } from './errors.ts';
import type { Outcome } from './outcome.ts';
import { print, printLine } from './output.ts';
import { settlePasteLink } from './paste-links.ts';
import { forgetRequestKey, isId, keyFileOf, settleRequest } from './requests.ts';
import { ServiceAccount } from './service-account.ts';

/**
 * What an ask's `next` says about the link it prints. The owner sees only the agent's reply to
 * them, not its tool output, and a wait that blocks first keeps the agent from replying.
 */
export const handOver = (id: string) =>
  `The owner sees only your reply to them, not this output: end that reply with the link, alone on its last line. It waits an hour for them. Run \`baymutt ask wait ${id}\` in the background, or after that reply, never before it: a wait that blocks first hides the link. Asks made together can share one wait: \`baymutt ask wait <id> <id>\`.`;

/** `id` as typed, refused unless it is an id: it reaches the store's paths and this computer's files. */
export const checkedId = (id: string) =>
  isId(id)
    ? Effect.succeed(id)
    : Effect.fail(usage(`${id} is not an id that \`baymutt ask\` printed: those are UUIDs.`));

/** Nothing this key asked has `id`. A key kept here for it is a request that never reached the store. */
export const notAsked = Effect.fn('asks.notAsked')(function* (id: string) {
  const fs = yield* FileSystem.FileSystem;
  const isKept = yield* fs.exists(yield* keyFileOf(id)).pipe(Effect.orDie);
  if (!isKept) return yield* usage(`Nothing this key asked has the id ${id}.`, 'notFound');
  yield* forgetRequestKey(id);
  return yield* usage(
    `Request ${id} never reached the store, so the owner never saw it. Its key was removed from this computer: run \`baymutt ask access\` again.`,
    'notFound',
  );
});

/** What kind of ask `id` is, found by asking the store for each in turn, and waits for its answer. */
const settleOne = Effect.fn('asks.settleOne')(function* (id: string, timeout: number) {
  const { api } = yield* ServiceAccount;
  const request = yield* api.requests.get({ params: { id } }).pipe(
    answerFor(id),
    Effect.asSome,
    Effect.catchTag('NotFoundError', () => Effect.succeedNone),
  );
  if (Option.isSome(request)) return yield* settleRequest(request.value, timeout);
  const environmentRequest = yield* api.environmentRequests.get({ params: { id } }).pipe(
    answerFor(id),
    Effect.asSome,
    Effect.catchTag('NotFoundError', () => Effect.succeedNone),
  );
  if (Option.isSome(environmentRequest)) {
    return yield* settleEnvironmentRequest(environmentRequest.value, timeout);
  }
  const pasteLink = yield* api.pasteLinks.get({ params: { id } }).pipe(
    answerFor(id),
    Effect.asSome,
    Effect.catchTag('NotFoundError', () => Effect.succeedNone),
  );
  if (Option.isNone(pasteLink)) return yield* notAsked(id);
  return yield* settlePasteLink(id, timeout);
});

type Failure = {
  readonly code: string;
  readonly message: string;
  readonly kind: UsageError['kind'];
};

/** One ask's end, as the waiting of several needs it: the line it prints, and why it was not granted. */
type Ended = {
  readonly id: string;
  readonly status: string;
  readonly line: object;
  /** Null when the owner granted it. */
  readonly failure: Failure | null;
  /** Still open at the timeout: the agent waits again for it. */
  readonly isOpen: boolean;
};

const describe = (failure: Failure) => ({
  code: failure.code,
  message: failure.message,
  exitCode: EXIT_CODES[failure.kind],
});

const usageFailure = (error: UsageError): Failure => ({
  code: error._tag,
  message: error.message,
  kind: error.kind,
});

/**
 * One ask's end. Anything that stops one ask (a store that cannot be reached, a key that was not
 * proven, a command that failed) is that ask's end only: the others are still waited on.
 */
const endOne = (id: string, timeout: number) =>
  settleOne(id, timeout).pipe(
    Effect.map((outcome: Outcome): Ended => {
      if (outcome.kind === 'granted') {
        return {
          id,
          status: outcome.result.status,
          line: outcome.result,
          failure: null,
          isOpen: false,
        };
      }
      const failure = usageFailure(outcome.failure);
      return outcome.kind === 'unanswered'
        ? { id, status: 'pending', line: outcome.result, failure, isOpen: true }
        : {
            id,
            status: outcome.status,
            line: { id, status: outcome.status, error: describe(failure) },
            failure,
            isOpen: false,
          };
    }),
    Effect.catch(error =>
      Effect.map(
        describeFailure(error),
        (failure): Ended => ({
          id,
          status: 'failed',
          line: { id, status: 'failed', error: describe(failure) },
          failure,
          isOpen: false,
        }),
      ),
    ),
    Effect.tap(({ line }) => printLine(line)),
  );

/**
 * Waits up to `timeout` seconds for the owner to answer every one of `ids`.
 *
 * One id prints its result as one JSON object and fails with the reason when it was not granted.
 * Several print one JSON line per id as each is answered (a failed one carries its `error`),
 * then fail unless all were granted: with 9 if any is still open, else with the first of them, in
 * the order given, that was not granted.
 */
export const waitForAsks = Effect.fn('asks.wait')(function* (
  typed: ReadonlyArray<string>,
  timeout: number,
) {
  const ids = [...new Set(yield* Effect.forEach(typed, checkedId))];
  const [only, ...others] = ids;
  if (only !== undefined && others.length === 0) {
    const outcome = yield* settleOne(only, timeout);
    if (outcome.kind === 'refused') return yield* outcome.failure;
    yield* print(outcome.result);
    if (outcome.kind === 'unanswered') return yield* outcome.failure;
    return;
  }
  const ended = yield* Effect.forEach(ids, id => endOne(id, timeout), { concurrency: 'unbounded' });
  const notGranted = ended.flatMap(one =>
    one.failure === null ? [] : [{ ...one, failure: one.failure }],
  );
  const first = notGranted.find(one => one.isOpen) ?? notGranted[0];
  if (first === undefined) return;
  const open = notGranted.filter(one => one.isOpen).map(one => one.id);
  const keepWaiting =
    open.length === 0
      ? ''
      : ` Run \`baymutt ask wait ${open.join(' ')}\` to keep waiting for the open ones.`;
  return yield* usage(
    `${notGranted.length} of ${ended.length} asks were not granted: ${notGranted
      .map(one => `${one.id} ${one.status}`)
      .join(', ')}. Each one's line on stdout says why.${keepWaiting}`,
    first.failure.kind,
  );
});
