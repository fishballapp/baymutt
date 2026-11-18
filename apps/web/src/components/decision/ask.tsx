// What the three ask pages share: reading the ask at the address, the way back to the item it
// waits under, and the Ends a request and a key change offer.
import { Link } from '@tanstack/react-router';
import * as Option from 'effect/Option';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { durationWords, MINUTE_MS } from '../../lib/format.ts';
import { failureMessage, latest } from '../../lib/result.ts';
import { useOrg } from '../org-scope.tsx';
import { buttonClass } from '../ui/button.tsx';
import type { SelectOption } from '../ui/select.tsx';

/**
 * An ask as its page reads it. Only an ask of the org the address names is `found`: one of another
 * org is not at this link, like one that does not exist.
 */
export type AskState<A> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'found'; readonly ask: A };

export const askState = <A, E extends { readonly _tag: string; readonly message: string }>(
  result: AsyncResult.AsyncResult<A, E>,
  isOfOrg: (ask: A) => boolean,
): AskState<A> => {
  const found = latest(result);
  if (found !== null) return isOfOrg(found) ? { kind: 'found', ask: found } : { kind: 'missing' };
  const isNotFound =
    AsyncResult.isFailure(result) &&
    Option.match(AsyncResult.error(result), {
      onNone: () => false,
      onSome: error => error._tag === 'NotFoundError',
    });
  if (isNotFound) return { kind: 'missing' };
  const message = failureMessage(result);
  return message === null ? { kind: 'loading' } : { kind: 'failed', message };
};

/** An outcome's way back to Keys. */
export const SeeKeys = () => (
  <Link
    to="/orgs/$slug/keys"
    params={{ slug: useOrg().slug }}
    className={buttonClass({ size: 'lg' })}
  >
    See keys
  </Link>
);

/** An outcome's way back to Environments. */
export const SeeEnvironments = () => (
  <Link
    to="/orgs/$slug/environments"
    params={{ slug: useOrg().slug }}
    className={buttonClass({ size: 'lg' })}
  >
    See environments
  </Link>
);

/** The ends the owner may pick besides what the agent asked for and no end. */
const LIFETIMES = [15 * MINUTE_MS, 60 * MINUTE_MS, 24 * 60 * MINUTE_MS] as const;

/** A key's lifetime from approval, in milliseconds, as a select's value; or `never`. */
export type Lifetime = 'never' | `${number}`;

export const lifetimeOf = (ms: number): Lifetime => `${ms}`;

/**
 * Ends' durations: 15 minutes, 1 hour and 1 day after approval, plus the agent's ask if different,
 * by length, then Never. The agent's ask (`asked`, null when it asked for none) is marked ", as
 * asked".
 */
export const lifetimeOptions = (asked: Lifetime | null): ReadonlyArray<SelectOption<Lifetime>> => {
  const durations = [
    ...new Set([...LIFETIMES, ...(asked === null || asked === 'never' ? [] : [Number(asked)])]),
  ]
    .toSorted((a, b) => a - b)
    .map(lifetimeOf);
  return [...durations, 'never' as const].map(value => ({
    value,
    label: [
      value === 'never' ? 'Never' : `${durationWords(Number(value))} after approval`,
      value === asked && ', as asked',
    ]
      .filter(Boolean)
      .join(''),
  }));
};

/** When a chosen lifetime ends if approved now: null for no end. */
export const expiresAtOf = (lifetime: Lifetime, now: number): number | null =>
  lifetime === 'never' ? null : now + Number(lifetime);
