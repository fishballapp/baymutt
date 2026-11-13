/**
 * What 0.5.0 clients read, which the deploy depends on: the plugin built from a commit loads
 * baymutt's own secrets from the Worker that is live, and for one release those are different
 * versions. Both shapes are written out here as 0.5.0 sent them (`git show 711d81342:` the API's
 * `projects.ts` and `secrets.ts`), so renaming a field in the API cannot move them.
 * Gone with `http/api/legacy.ts`.
 */
import { describe, expect, it } from 'vitest';
import { call, ok, storeWorld } from '../test-store.ts';
import { keyLike, sealedLike } from '../test-support.ts';

const setup = async () => {
  const world = await storeWorld();
  const environmentId = await world.environment('app/production');
  const login = await world.pair('laptop', { environments: [environmentId] });
  await world.write(environmentId, 'API_KEY', 1);
  return { ...world, environmentId, login };
};

describe('the routes a 0.5.0 load calls', () => {
  it('list environments as `projects`, with the fields 0.5.0 sent', async () => {
    const { w, accountId, environmentId, login } = await setup();

    expect(await call(w, 'GET', '/projects', login.headers)).toEqual({
      status: 200,
      body: {
        projects: [
          {
            id: environmentId,
            accountId,
            name: 'app/production',
            publicKey: keyLike('p'),
            keyVersion: 1,
            createdAt: expect.any(Number),
            createdBy: { kind: 'owner', id: expect.any(String), name: 'Owner' },
            secretCount: 1,
            keyProof: sealedLike('key-proof'),
            canRead: true,
            canWrite: true,
          },
        ],
      },
    });
  });

  it('load an environment as a bundle with `project`, with the fields 0.5.0 sent', async () => {
    const { w, accountId, environmentId, login } = await setup();

    expect(await call(w, 'GET', `/projects/${environmentId}/bundle`, login.headers)).toEqual({
      status: 200,
      body: {
        project: {
          id: environmentId,
          accountId,
          name: 'app/production',
          publicKey: keyLike('p'),
          keyVersion: 1,
        },
        wrap: sealedLike('login-wrap'),
        readerId: login.id,
        secrets: [
          {
            name: 'API_KEY',
            version: 1,
            keyVersion: 1,
            ciphertext: sealedLike('API_KEY-v1', 96),
          },
        ],
      },
    });
  });

  it('refuse as `/environments` does, with the same error body', async () => {
    const { w, environmentId, pair } = await setup();
    const stranger = await pair('stranger');

    const legacy = await call(w, 'GET', `/projects/${environmentId}/bundle`, stranger.headers);
    const current = await call(w, 'GET', `/environments/${environmentId}/bundle`, stranger.headers);

    expect(legacy.status).toBe(403);
    expect(legacy).toEqual(current);
  });

  it('log a load as `environment.load`, like `/environments`', async () => {
    const { w, environmentId, login, owner } = await setup();
    await call(w, 'GET', `/projects/${environmentId}/bundle`, login.headers);

    const { events } = await ok<{ events: { action: string }[] }>(w, 'GET', '/audit', owner);

    expect(events.map(({ action }) => action)).toContain('environment.load');
  });
});
