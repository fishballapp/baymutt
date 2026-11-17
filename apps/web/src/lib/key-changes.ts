// What the dashboard decides about a key change from what it reads, kept apart from the atoms so
// it is tested on its own.
import type { KeyChange } from '@baymutt/api';

/**
 * Whether the owner can approve `change` at `now`: it waits, its key has not ended (until the
 * nightly sweep revokes it, an ended key still lists), and every environment it names still
 * exists. One that cannot be approved is not counted as waiting; its page offers Reject only.
 */
export const isApprovable = (
  change: Pick<KeyChange, 'status' | 'key' | 'isMissingEnvironment'>,
  now: number,
): boolean =>
  change.status === 'pending' &&
  !change.isMissingEnvironment &&
  (change.key.expiresAt === null || change.key.expiresAt > now);

/** Whether `change` gives back every environment the key holds now, by id. */
export const givesBackAll = (change: Pick<KeyChange, 'holds' | 'giveBack'>): boolean => {
  const givenBack = new Set(change.giveBack.map(({ environmentId }) => environmentId));
  return (
    change.holds.length > 0 &&
    change.holds.every(({ environmentId }) => givenBack.has(environmentId))
  );
};
