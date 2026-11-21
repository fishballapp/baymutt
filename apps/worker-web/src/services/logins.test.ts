/** Any CLI login or service account may expire; both carry what their maker said they are for. */
import { describe, expect, it } from 'vitest';
import { call, NAMES_KEY_WRAP, ok, storeWorld } from '../test-store.ts';
import { keyLike, sealedLike } from '../test-support.ts';

const DAY = 24 * 3600 * 1000;

describe('expiry', () => {
  it('refuses an expired CLI login and every service account it asked for, until the owner extends it', async () => {
    const world = await storeWorld();
    const { w, owner, pair, environment, serviceAccount } = world;
    const environmentId = await environment('app/production');
    const login = await pair('laptop');
    const ci = await serviceAccount([environmentId], { maker: login });

    await ok(w, 'PUT', `/credentials/${login.id}/expiry`, owner, { expiresAt: Date.now() - 1 });

    for (const { headers } of [login, ci]) {
      expect(await call(w, 'GET', '/environments', headers)).toMatchObject({
        status: 401,
        body: { code: 'UnauthorizedError' },
      });
    }
    expect((await call(w, 'GET', '/me', login.headers)).body).toMatchObject({
      message: expect.stringContaining('expired'),
    });
    expect((await call(w, 'GET', '/me', ci.headers)).body).toMatchObject({
      message: expect.stringContaining('The CLI login that asked for this key expired'),
    });
    // Still listed, so the owner can see it and extend it.
    expect(await call(w, 'GET', '/credentials', owner)).toMatchObject({
      body: { credentials: [{ id: login.id, expiresAt: expect.any(Number) }, { id: ci.id }] },
    });

    const later = Date.now() + 30 * DAY;
    expect(
      await call(w, 'PUT', `/credentials/${login.id}/expiry`, owner, { expiresAt: later }),
    ).toMatchObject({ status: 200, body: { id: login.id, expiresAt: later } });

    expect(await call(w, 'GET', '/environments', login.headers)).toMatchObject({ status: 200 });
    expect(await call(w, 'GET', `/environments/${environmentId}/bundle`, ci.headers)).toMatchObject(
      { status: 200 },
    );
    const { events } = await ok<{ events: { action: string; detail: string | null }[] }>(
      w,
      'GET',
      '/activity',
      owner,
    );
    expect(events.filter(({ action }) => action === 'credential.expiry')).toHaveLength(2);
  });

  it('refuses a key whose expiry was set when it was made or approved, once it passes', async () => {
    const world = await storeWorld();
    const { w, pair, serviceAccount, environment } = world;
    const expired = await pair('laptop', { expiresAt: Date.now() - 1 });
    const live = await pair('server', { expiresAt: Date.now() + DAY });
    const ci = await serviceAccount([await environment('app')], {
      maker: live,
      expiresAt: Date.now() + DAY,
    });
    // As the end the owner approved has passed: an approval refuses an end already past.
    w.sqlite
      .prepare('UPDATE credential SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, ci.id);

    expect(await call(w, 'GET', '/me', expired.headers)).toMatchObject({ status: 401 });
    expect(await call(w, 'GET', '/me', live.headers)).toMatchObject({ status: 200 });
    expect(await call(w, 'GET', '/me', ci.headers)).toMatchObject({ status: 401 });
  });

  it('is the owner’s alone to change, never the key’s own', async () => {
    const world = await storeWorld();
    const { w, pair, locked, serviceAccount, environment } = world;
    const login = await pair('laptop', { expiresAt: Date.now() + DAY });
    const ci = await serviceAccount([await environment('app')], {
      maker: login,
    });

    for (const [target, headers] of [
      [login.id, login.headers],
      [ci.id, login.headers],
      [ci.id, ci.headers],
    ] as const) {
      expect(
        await call(w, 'PUT', `/credentials/${target}/expiry`, headers, { expiresAt: null }),
      ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
    }
    // A session whose vault is locked changes nothing.
    expect(
      await call(w, 'PUT', `/credentials/${login.id}/expiry`, locked, { expiresAt: null }),
    ).toMatchObject({ status: 403, body: { code: 'VaultLockedError' } });
  });

  it('is refused when no date can hold it', async () => {
    const world = await storeWorld();
    const login = await world.pair('laptop');
    expect(
      await call(world.w, 'PUT', `/credentials/${login.id}/expiry`, world.owner, {
        expiresAt: 9_000_000_000_000_000,
      }),
    ).toMatchObject({ status: 400 });
  });
});

describe('a description', () => {
  it('is kept as its maker wrote it: a CLI login’s optional, a key’s its plan’s reason', async () => {
    const world = await storeWorld();
    const { w, owner, orgId, pair, ask, approve, environment } = world;
    const login = await pair('laptop', { description: 'Agents on the work laptop' });
    const app = await environment('app');
    const ci = await ask(login, [app], { name: 'ci', reason: 'Deploys app/production from CI' });
    await approve(ci, [app]);
    await pair('server');

    expect(await call(w, 'GET', '/credentials', owner)).toMatchObject({
      body: {
        credentials: [
          { name: 'laptop', parentId: null, description: 'Agents on the work laptop' },
          { name: 'ci', parentId: login.id, description: 'Deploys app/production from CI' },
          { name: 'server', description: null, expiresAt: null },
        ],
      },
    });
    expect(
      await call(w, 'POST', '/credentials/pair', owner, {
        id: crypto.randomUUID(),
        name: 'too-long',
        publicKey: keyLike('k'),
        bearerHash: keyLike('h'),
        endorsement: sealedLike('e'),
        welcome: sealedLike('w'),
        namesKeyWraps: [{ orgId, wrap: NAMES_KEY_WRAP }],
        description: 'x'.repeat(141),
      }),
    ).toMatchObject({ status: 400 });
  });
});
