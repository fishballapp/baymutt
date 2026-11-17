import { describe, expect, it } from 'vitest';
import { givesBackAll, isApprovable } from './key-changes.ts';

const at = (environmentId: string) => ({ environmentId });
const NOW = 1_000_000;

describe('givesBackAll', () => {
  it('compares environments, not how many there are', () => {
    // Staging was removed from the key meanwhile: giving it back gives back nothing it holds.
    expect(givesBackAll({ holds: [at('prod')], giveBack: [at('staging')] } as never)).toBe(false);
    expect(givesBackAll({ holds: [at('prod')], giveBack: [at('prod')] } as never)).toBe(true);
    expect(givesBackAll({ holds: [at('prod'), at('dev')], giveBack: [at('prod')] } as never)).toBe(
      false,
    );
  });

  it('is false for a key that holds nothing', () => {
    expect(givesBackAll({ holds: [], giveBack: [] } as never)).toBe(false);
  });
});

describe('isApprovable', () => {
  const waiting = { status: 'pending', key: { expiresAt: null }, isMissingEnvironment: false };

  it('is a waiting change on a key that still works, naming only what exists', () => {
    expect(isApprovable(waiting as never, NOW)).toBe(true);
    expect(isApprovable({ ...waiting, key: { expiresAt: NOW + 1 } } as never, NOW)).toBe(true);
  });

  it('is not one whose key has ended, one naming an environment removed for good, or an answered one', () => {
    expect(isApprovable({ ...waiting, key: { expiresAt: NOW } } as never, NOW)).toBe(false);
    expect(isApprovable({ ...waiting, isMissingEnvironment: true } as never, NOW)).toBe(false);
    expect(isApprovable({ ...waiting, status: 'approved' } as never, NOW)).toBe(false);
  });
});
