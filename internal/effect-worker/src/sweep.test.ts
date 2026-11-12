import { describe, expect, it } from '@effect/vitest';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as TestClock from 'effect/testing/TestClock';
import { eachIsolated, ROW_TIMEOUT } from './sweep';
import { captureLogs } from './testing';

describe('eachIsolated', () => {
  it.effect(
    'logs a row that fails or hangs — each distinctly — and carries on with the rest',
    () => {
      const { logs, layer } = captureLogs();
      return Effect.gen(function* () {
        const hanging = yield* Deferred.make<void>();
        const done: string[] = [];
        const work: Record<string, Effect.Effect<void, string>> = {
          hangs: Deferred.succeed(hanging, undefined).pipe(Effect.andThen(Effect.never)),
          fails: Effect.fail('upstream 503'),
          works: Effect.sync(() => void done.push('works')),
        };
        const sweep = yield* Effect.forkChild(
          eachIsolated({
            sweep: 'test sweep',
            rows: Object.keys(work).map(id => ({ id })),
            run: ({ id }) => work[id] ?? Effect.die(`no work for ${id}`),
          }),
        );
        yield* Deferred.await(hanging);
        yield* TestClock.adjust(ROW_TIMEOUT);
        yield* Fiber.join(sweep);

        expect(done).toEqual(['works']);
        expect(logs).toEqual([
          {
            level: 'Error',
            message: 'test sweep timed out',
            annotations: { id: 'hangs', timeout: ROW_TIMEOUT },
            cause: '',
          },
          {
            level: 'Error',
            message: 'test sweep failed',
            annotations: { id: 'fails' },
            cause: expect.stringContaining('upstream 503'),
          },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );
});
