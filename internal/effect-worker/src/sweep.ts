/**
 * Row isolation for the cron sweeps (each service's sweep method, run from jobs/cron.ts): one row's
 * failing or hanging work never stops the rest of its batch. Rows are decoded by the listing query, so
 * a row that fails to decode fails its whole batch.
 */
import * as Effect from 'effect/Effect';

/** Bound on one row's work — its upstream calls run outside any Workflow step, so nothing else
 * bounds them, and a hung one would stall every row after it. */
export const ROW_TIMEOUT = '30 seconds';

/** Run `run` over each row in turn, isolating failures: a row that fails or outlasts
 * {@link ROW_TIMEOUT} is logged (by id — connection rows carry token ciphertext) and left for a later
 * tick. */
export const eachIsolated = Effect.fn('sweep.eachIsolated')(function* <
  A extends { readonly id: string },
  E,
  R,
>({
  sweep,
  rows,
  run,
}: {
  /** Names the sweep in the log of a failed row. */
  readonly sweep: string;
  readonly rows: readonly A[];
  readonly run: (row: A) => Effect.Effect<void, E, R>;
}) {
  yield* Effect.forEach(
    rows,
    row =>
      run(row).pipe(
        Effect.timeoutOrElse({
          duration: ROW_TIMEOUT,
          orElse: () =>
            Effect.logError(`${sweep} timed out`).pipe(
              Effect.annotateLogs({ id: row.id, timeout: ROW_TIMEOUT }),
            ),
        }),
        Effect.catchCause(cause =>
          Effect.logError(`${sweep} failed`, cause).pipe(Effect.annotateLogs({ id: row.id })),
        ),
      ),
    { concurrency: 1, discard: true },
  );
});
