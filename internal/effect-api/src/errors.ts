/**
 * An error is a `Schema.TaggedError` class declared once with the API's definition. The server
 * fails with it and the derived client decodes the body back into it, so both ends `catchTag` it.
 * On the wire its tag is named `code`: `{ "code": …, "message": …, …fields }`.
 */

import * as Schema from 'effect/Schema';

/** What a developer or dashboard user reads: what went wrong and how to fix it, naming the
 * specifics the error's fields carry, so a client that shows only this still says enough. */
export const ErrorMessageSchema = Schema.String.annotate({
  description:
    'What went wrong and how to fix it, for a person to read. Match on `code`, not on this text.',
});

const wireSchemas = new WeakMap<object, unknown>();

const toWire = <
  S extends Schema.Top & {
    readonly fields: { readonly _tag: Schema.Top; readonly message: Schema.Top };
    readonly identifier: string;
  },
>(
  error: S,
) =>
  error.pipe(
    Schema.encodeKeys({ _tag: 'code' }),
    Schema.annotateEncoded({ identifier: error.identifier }),
  );

/**
 * An API error as an endpoint or guard declares it, with its `_tag` named `code` on the wire and
 * in the spec. One schema per class, however many endpoints declare it: two schemas with one
 * identifier would become two spec components (`X_1`, `X_2`).
 */
export const coded = <S extends Parameters<typeof toWire>[0]>(
  error: S,
): ReturnType<typeof toWire<S>> => {
  const known = wireSchemas.get(error);
  if (known !== undefined) {
    // ponytail: the map can't type its value by its key; it only ever holds `toWire(error)`.
    return known as ReturnType<typeof toWire<S>>;
  }
  const wire = toWire(error);
  wireSchemas.set(error, wire);
  return wire;
};
