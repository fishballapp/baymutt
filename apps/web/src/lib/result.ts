import * as Option from 'effect/Option';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';

// Once settled (not while it runs again): the error's own `message`, which for an API error names
// its specifics, or `fallback` for a defect (a lost connection, a response that fails its schema).
export const failureMessage = <A, E extends { readonly message: string }>(
  result: AsyncResult.AsyncResult<A, E>,
  fallback = 'Something went wrong on our side. Nothing was changed; try again.',
): string | null =>
  AsyncResult.isFailure(result) && !result.waiting
    ? Option.match(AsyncResult.error(result), {
        onNone: () => fallback,
        onSome: ({ message }) => message,
      })
    : null;

/** The value it last held, kept through a refresh and a failed one. */
export const latest = <A, E>(result: AsyncResult.AsyncResult<A, E>): A | null =>
  Option.getOrNull(AsyncResult.value(result));

/**
 * A store failure shows in its field's error place until that field is edited: every form wraps
 * its fields' setters in this, so the message goes once the owner starts correcting the input.
 */
export const clearsFailure =
  (result: AsyncResult.AsyncResult<unknown, unknown>, reset: (reset: typeof Atom.Reset) => void) =>
  <A>(set: (value: A) => void) =>
  (value: A) => {
    set(value);
    if (AsyncResult.isFailure(result)) reset(Atom.Reset);
  };
