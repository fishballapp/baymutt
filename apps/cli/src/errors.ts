// Every failure reaches the caller the same way: one JSON line on stderr, and an exit code that
// says what kind it was. The caller is usually an agent, so the message says what to do next.
import { VaultError } from '@baymutt/keys';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as HttpClientError from 'effect/http/HttpClientError';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as PlatformError from 'effect/PlatformError';
import * as Runtime from 'effect/Runtime';
import * as Schema from 'effect/Schema';

/** What each exit code means. Stable: scripts and agents branch on them. */
export const EXIT_CODES = {
  failure: 1,
  usage: 2,
  notLoggedIn: 3,
  noAccess: 4,
  notFound: 5,
  conflict: 6,
  unreachable: 7,
  integrity: 8,
  differs: 9,
} as const;
type ExitKind = keyof typeof EXIT_CODES;

/** The command was used wrongly, or this computer is not logged in for it. */
export class UsageError extends Schema.TaggedError<UsageError>()('UsageError', {
  message: Schema.String,
  kind: Schema.Literals(['usage', 'notLoggedIn', 'noAccess', 'notFound', 'integrity', 'differs']),
}) {}

export const usage = (message: string, kind: UsageError['kind'] = 'usage') =>
  new UsageError({ message, kind });

/** Something from the store, or a key, that did not authenticate. Nothing built on it is used. */
export class IntegrityError extends Schema.TaggedError<IntegrityError>()('IntegrityError', {
  message: Schema.String,
}) {}

/** Already printed. Carries only the exit code out of the program. */
export class Reported extends Schema.TaggedError<Reported>()('Reported', {
  exitCode: Schema.Int,
}) {
  readonly [Runtime.errorExitCode]: number = this.exitCode;
}

const ApiErrorBodySchema = Schema.Struct({ code: Schema.String, message: Schema.String });

const API_ERROR_KINDS: { readonly [code: string]: ExitKind } = {
  UnauthorizedError: 'notLoggedIn',
  AccountRequiredError: 'notLoggedIn',
  NoAccessError: 'noAccess',
  OwnerRequiredError: 'noAccess',
  NotFoundError: 'notFound',
  AlreadyExistsError: 'conflict',
  VersionConflictError: 'conflict',
  LinkSpentError: 'conflict',
  LimitReachedError: 'conflict',
  InvalidRequestError: 'usage',
};

type Failure = { readonly code: string; readonly message: string; readonly kind: ExitKind };

/** A failure as its code, a message that says what to do next, and what kind it is. */
export const describeFailure = (
  error: Error & { readonly _tag: string },
): Effect.Effect<Failure> => {
  if (error instanceof UsageError) {
    return Effect.succeed({ code: error._tag, message: error.message, kind: error.kind });
  }
  if (error instanceof IntegrityError) {
    return Effect.succeed({ code: error._tag, message: error.message, kind: 'integrity' });
  }
  if (PlatformError.isPlatformError(error) || Schema.isSchemaError(error)) {
    return Effect.succeed({ code: error._tag, message: error.message, kind: 'failure' });
  }
  if (HttpClientError.isHttpClientError(error)) {
    const { request, response } = error;
    if (response === undefined) {
      return Effect.succeed({
        code: 'Unreachable',
        message: `Could not reach ${new URL(request.url).origin}. Check the connection, and BAYMUTT_URL if it is set.`,
        kind: 'unreachable',
      });
    }
    // A status the endpoint doesn't declare still carries the API's body. Any other body came
    // from outside the Worker: the runtime's bare 500, an edge error page.
    return HttpClientResponse.schemaBodyJson(ApiErrorBodySchema)(response).pipe(
      Effect.map(({ code, message }) => ({
        code,
        message,
        kind: API_ERROR_KINDS[code] ?? 'failure',
      })),
      Effect.orElseSucceed(
        (): Failure => ({
          code: 'Unreachable',
          message: `The store failed with HTTP ${response.status}. Try again in a minute.`,
          kind: 'unreachable',
        }),
      ),
    );
  }
  // An error the endpoint declares arrives decoded into its class, tagged with its `code`.
  return Effect.succeed({
    code: error._tag,
    message: error.message,
    kind: API_ERROR_KINDS[error._tag] ?? 'failure',
  });
};

/** Prints a failure as `{"error":{code,message,exitCode}}` on stderr and exits with its code. */
export const report = <A, E extends Error & { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Reported, R> =>
  Effect.catch(
    effect,
    Effect.fnUntraced(function* (error) {
      const { code, message, kind } = yield* describeFailure(error);
      const exitCode = EXIT_CODES[kind];
      yield* Console.error(JSON.stringify({ error: { code, message, exitCode } }));
      return yield* new Reported({ exitCode });
    }),
  );

/** A promise from `@baymutt/keys`: its rejection is a `VaultError`, or a fault. */
export const crypto_ = <A>(run: () => Promise<A>): Effect.Effect<A, IntegrityError> =>
  Effect.tryPromise(run).pipe(
    Effect.catchTag('UnknownError', ({ cause }) =>
      cause instanceof VaultError
        ? Effect.fail(
            new IntegrityError({
              message: `${cause.message}. Nothing was used. If the key is right, the store answered with something this computer did not seal.`,
            }),
          )
        : Effect.die(cause),
    ),
  );
