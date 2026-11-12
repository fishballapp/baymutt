/**
 * Short-lived records in Workers KV — an upload waiting for its parts, an OAuth state, a cached
 * read — each JSON under its schema with a TTL. Effect's `KeyValueStore` has no TTL,
 * so it doesn't fit. A record that no longer decodes reads as absent: it can only be one we wrote
 * under an older shape, and every caller treats absent as expired.
 *
 * A write or delete that rejects is a fault — a defect. KV takes one write per key per second and
 * rejects the next with a 429, so a write the caller can do without (a cache fill) says so at its
 * call site with `Effect.ignoreCause`. A read that rejects is a {@link KvError}: a cache read falls
 * back to the source, every other caller makes it a defect (`Effect.orDie`).
 */
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

/** A KV read the binding refused. */
export class KvError extends Schema.TaggedError<KvError>()('KvError', {
  key: Schema.String,
  cause: Schema.Defect(),
}) {}

export class Kv extends Context.Service<
  Kv,
  {
    readonly get: <A, I>(
      key: string,
      schema: Schema.Codec<A, I>,
    ) => Effect.Effect<Option.Option<A>, KvError>;
    readonly put: <A, I>(record: {
      readonly key: string;
      readonly schema: Schema.Codec<A, I>;
      readonly value: A;
      readonly ttl: Duration.Input;
    }) => Effect.Effect<void>;
    readonly remove: (key: string) => Effect.Effect<void>;
  }
>()('@internal/effect-worker/Kv') {
  static readonly layer = (namespace: KVNamespace) =>
    Layer.succeed(
      Kv,
      Kv.of({
        get: Effect.fn('Kv.get')(function* <A, I>(key: string, schema: Schema.Codec<A, I>) {
          const raw = yield* Effect.tryPromise({
            try: () => namespace.get(key),
            catch: cause => new KvError({ key, cause }),
          });
          if (raw === null) return Option.none<A>();
          return Schema.decodeUnknownOption(Schema.fromJsonString(schema))(raw);
        }),

        put: Effect.fn('Kv.put')(function* <A, I>({
          key,
          schema,
          value,
          ttl,
        }: {
          readonly key: string;
          readonly schema: Schema.Codec<A, I>;
          readonly value: A;
          readonly ttl: Duration.Input;
        }) {
          // We encode our own values; one that doesn't encode is a bug.
          const json = yield* Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
            Effect.orDie,
          );
          yield* Effect.tryPromise(() =>
            namespace.put(key, json, { expirationTtl: Duration.toSeconds(ttl) }),
          ).pipe(Effect.orDie);
        }),

        remove: Effect.fn('Kv.remove')(function* (key: string) {
          yield* Effect.tryPromise(() => namespace.delete(key)).pipe(Effect.orDie);
        }),
      }),
    );
}
