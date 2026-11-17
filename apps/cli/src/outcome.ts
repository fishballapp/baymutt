// How waiting on one ask ended, before anything is printed: `ask wait` prints one result for a
// single id, and one line per id for several.
import type { UsageError } from './errors.ts';

/** What a command prints on stdout: always a JSON object that names its ask by `id`. */
export type Result = {
  readonly id: string;
  readonly status: string;
  readonly [field: string]: unknown;
};

export type Outcome =
  /** The owner said yes: what `ask wait` prints, and exit 0. */
  | { readonly kind: 'granted'; readonly result: Result }
  /** The owner said no, or nobody did in time, or the store forgot it. Only the failure is printed. */
  | { readonly kind: 'refused'; readonly status: string; readonly failure: UsageError }
  /** Still open when the timeout came: what it is waiting as, and exit 9. */
  | { readonly kind: 'unanswered'; readonly result: Result; readonly failure: UsageError };
