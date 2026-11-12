import { describe, expect, it } from '@effect/vitest';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { Kv } from './kv';
import { fakeKv } from './testing';

const RecordSchema = Schema.Struct({ n: Schema.Number });

describe('Kv', () => {
  it.effect(
    'reads back what it put; an absent key and a record that no longer decodes read as absent',
    () => {
      const namespace = fakeKv();
      namespace.store.set('old', JSON.stringify({ n: 'an older shape' }));
      return Effect.gen(function* () {
        const kv = yield* Kv;
        yield* kv.put({ key: 'k', schema: RecordSchema, value: { n: 1 }, ttl: '1 minute' });

        expect(yield* kv.get('k', RecordSchema)).toEqual(Option.some({ n: 1 }));
        expect(yield* kv.get('missing', RecordSchema)).toEqual(Option.none());
        expect(yield* kv.get('old', RecordSchema)).toEqual(Option.none());

        yield* kv.remove('k');
        expect(yield* kv.get('k', RecordSchema)).toEqual(Option.none());
      }).pipe(Effect.provide(Kv.layer(namespace)));
    },
  );

  it.effect(
    'a read the binding rejects is a KvError; a write or delete it rejects (a 429) is a defect',
    () =>
      Effect.gen(function* () {
        const kv = yield* Kv;
        const read = yield* Effect.flip(kv.get('k', RecordSchema));
        expect(read._tag).toBe('KvError');
        for (const call of [
          kv.put({ key: 'k', schema: RecordSchema, value: { n: 1 }, ttl: '1 minute' }),
          kv.remove('k'),
        ]) {
          const exit = yield* Effect.exit(call);
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
        }
      }).pipe(Effect.provide(Kv.layer(fakeKv({ fail: true })))),
  );
});
