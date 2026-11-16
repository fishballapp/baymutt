/** Requests: a CLI login asks for environments with a key that holds nothing; the owner approves or rejects. */
import { LIMITS } from '@baymutt/api';
import * as Effect from 'effect/Effect';
import { describe, expect, it } from 'vitest';
import {
  call,
  indexOf,
  NAMES_KEY_WRAP,
  ok,
  type StoreWorld,
  sealedOf,
  storeWorld,
  VOUCHERS,
} from '../test-store.ts';
import { keyLike, sealedLike } from '../test-support.ts';
import { Access } from './access.ts';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const setup = async () => {
  const world = await storeWorld();
  const production = await world.environment('app/production');
  const staging = await world.environment('app/staging');
  const login = await world.pair('laptop');
  return { ...world, production, staging, login };
};

const sweep = ({ w }: StoreWorld) =>
  Effect.runPromise(
    Effect.flatMap(Access, access => access.sweepRequests).pipe(Effect.provide(w.services)),
  );

const actions = ({ w }: StoreWorld) =>
  w.sqlite
    .prepare('SELECT action, actor, detail, environment_id FROM activity_event ORDER BY id')
    .all() as Array<{
    action: string;
    actor: string;
    detail: string | null;
    environment_id: string;
  }>;

describe('asking', () => {
  it('is a CLI login’s: it registers a key that works and holds nothing until the owner approves', async () => {
    const world = await setup();
    const { w, owner, orgId, production, login, ask, pair } = world;
    const other = await pair('desktop');

    const request = await ask(login, [{ environmentId: production, read: true }], {
      name: 'deploy',
      reason: 'to deploy app/production',
      command: 'pnpm deploy',
      lifetime: DAY,
    });
    expect(request.answer).toMatchObject({
      status: 201,
      body: {
        id: request.id,
        name: 'deploy',
        reason: 'to deploy app/production',
        status: 'pending',
        command: 'pnpm deploy',
        lifetime: DAY,
        expiresAt: null,
        keyVoucher: null,
        maker: { id: login.id, name: 'laptop', publicKey: keyLike('m'), endorsement: null },
        items: [
          {
            environmentId: production,
            orgId,
            orgSlug: 'org-user-1',
            environmentName: indexOf(orgId, 'app/production'),
            environmentSealedName: sealedOf('app/production'),
            canRead: true,
            canWrite: false,
          },
        ],
        resolvedAt: null,
      },
    });
    // The key is real, and holds nothing.
    expect(await call(w, 'GET', '/me', request.headers)).toMatchObject({
      status: 200,
      body: {
        credential: { id: request.id, parentId: login.id, accountVoucher: VOUCHERS.accountKey },
      },
    });
    expect(await call(w, 'GET', '/environments', request.headers)).toEqual({
      status: 200,
      body: { environments: [], namesKeys: [] },
    });
    expect(
      await call(w, 'GET', `/environments/${production}/bundle`, request.headers),
    ).toMatchObject({ status: 404 });

    // The owner, the maker and the key itself see it; another login does not.
    expect(await call(w, 'GET', `/requests/${request.id}`, owner)).toMatchObject({
      status: 200,
      body: { keyVoucher: VOUCHERS.keyToOwner, maker: { endorsement: sealedLike('endorsement') } },
    });
    expect(await call(w, 'GET', `/requests/${request.id}`, request.headers)).toMatchObject({
      status: 200,
      body: { keyVoucher: null, status: 'pending' },
    });
    expect(await call(w, 'GET', `/requests/${request.id}`, other.headers)).toMatchObject({
      status: 404,
    });
    const listed = async (headers: Record<string, string>) =>
      (await ok<{ requests: { id: string }[] }>(w, 'GET', '/requests', headers)).requests.map(
        ({ id }) => id,
      );
    expect(await listed(owner)).toEqual([request.id]);
    expect(await listed(login.headers)).toEqual([request.id]);
    expect(await listed(other.headers)).toEqual([]);
    expect(await listed(request.headers)).toEqual([]);
    expect(actions(world).at(-1)).toMatchObject({ action: 'request.create', detail: 'deploy' });
  });

  it('is refused to the owner and to a service account', async () => {
    const world = await setup();
    const { w, owner, production, serviceAccount } = world;
    const made = await serviceAccount([{ environmentId: production, read: true }]);
    const payload = {
      id: crypto.randomUUID(),
      name: 'more',
      publicKey: keyLike('m'),
      bearerHash: keyLike('h'),
      vouchers: VOUCHERS,
      reason: 'more',
      command: null,
      lifetime: null,
      items: [{ environmentId: production, canRead: true, canWrite: true }],
    };

    for (const headers of [owner, made.headers]) {
      expect(await call(w, 'POST', '/requests', headers, payload)).toMatchObject({
        status: 403,
        body: { code: 'OwnerRequiredError' },
      });
    }
  });

  it('does not count a request past its hour against the account’s limit', async () => {
    const world = await setup();
    const { w, accountId, production, login, ask } = world;
    const stale = await ask(login, [{ environmentId: production, read: true }]);
    w.sqlite
      .prepare('UPDATE access_request SET created_at = created_at - ? WHERE credential_id = ?')
      .run(HOUR, stale.id);
    // Fill the account to its limit with working keys: the login and the stale request count
    // two of them unless the stale one is left out.
    const held = (
      w.sqlite
        .prepare('SELECT COUNT(*) AS n FROM credential WHERE account_id = ? AND revoked_at IS NULL')
        .get(accountId) as { n: number }
    ).n;
    const insert = w.sqlite.prepare(
      `INSERT INTO credential (id, account_id, name, public_key, bearer_hash, created_at)
       VALUES (?, ?, ?, ?, ?, 0)`,
    );
    for (const n of Array.from({ length: LIMITS.serviceAccounts - held }, (_, i) => i)) {
      insert.run(crypto.randomUUID(), accountId, `filler-${n}`, keyLike('f'), keyLike('h'));
    }

    expect((await ask(login, [{ environmentId: production, read: true }])).answer).toMatchObject({
      status: 201,
    });
    expect((await ask(login, [{ environmentId: production, read: true }])).answer).toMatchObject({
      status: 403,
      body: { code: 'LimitReachedError' },
    });
  });

  it('names each live environment of the person’s orgs once, and asks for read, write or both', async () => {
    const world = await setup();
    const { w, owner, production, staging, login, ask } = world;
    const stranger = await storeWorld('user-2');
    const theirs = await stranger.environment('their/production');
    await ok(w, 'DELETE', `/environments/${staging}`, owner);

    expect(
      (
        await ask(login, [
          { environmentId: production, read: true },
          { environmentId: production, write: true },
        ])
      ).answer,
    ).toMatchObject({ status: 400, body: { code: 'InvalidRequestError' } });
    expect((await ask(login, [{ environmentId: production }])).answer).toMatchObject({
      status: 400,
      body: { code: 'InvalidRequestError' },
    });
    for (const environmentId of [staging, theirs, crypto.randomUUID()]) {
      expect((await ask(login, [{ environmentId, read: true }])).answer).toMatchObject({
        status: 404,
        body: { code: 'NotFoundError' },
      });
    }
    // An environment that does not exist yet is not asked for here: it has a request of its own.
    expect(
      await call(w, 'POST', '/requests', login.headers, {
        id: crypto.randomUUID(),
        name: 'new',
        publicKey: keyLike('m'),
        bearerHash: keyLike('h'),
        vouchers: VOUCHERS,
        reason: 'to make one',
        command: null,
        lifetime: null,
        items: [
          {
            create: {
              id: crypto.randomUUID(),
              orgId: world.orgId,
              name: indexOf(world.orgId, 'app/new'),
              sealedName: sealedOf('app/new'),
            },
            canRead: true,
            canWrite: true,
          },
        ],
      }),
    ).toMatchObject({ status: 400 });
    expect(w.sqlite.prepare('SELECT COUNT(*) AS n FROM access_request').get()).toEqual({ n: 0 });
  });
});

describe('approving', () => {
  it('gives the key exactly what was asked for, and logs it as each environment shows it', async () => {
    const world = await setup();
    const { w, owner, orgId, production, staging, login, ask, approve } = world;
    const request = await ask(
      login,
      [
        { environmentId: production, read: true },
        { environmentId: staging, write: true },
      ],
      { name: 'agent', lifetime: DAY },
    );
    const expiresAt = Date.now() + DAY;

    expect(
      await call(
        w,
        'POST',
        `/requests/${request.id}/approve`,
        login.headers,
        await world.approval(request.id),
      ),
    ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
    expect(await approve(request.id, expiresAt)).toMatchObject({
      status: 200,
      body: { status: 'approved', expiresAt, resolvedAt: expect.any(Number) },
    });

    expect(await call(w, 'GET', '/environments', request.headers)).toMatchObject({
      status: 200,
      body: { namesKeys: [{ orgId, wrap: NAMES_KEY_WRAP }] },
    });
    const held = Object.fromEntries(
      (
        await ok<{ environments: { id: string; canRead: boolean; canWrite: boolean }[] }>(
          w,
          'GET',
          '/environments',
          request.headers,
        )
      ).environments.map(({ id, canRead, canWrite }) => [id, { canRead, canWrite }]),
    );
    expect(held).toEqual({
      [production]: { canRead: true, canWrite: false },
      [staging]: { canRead: false, canWrite: true },
    });
    expect(
      await call(w, 'GET', `/environments/${production}/bundle`, request.headers),
    ).toMatchObject({
      status: 200,
      body: { wrap: sealedLike('read-wrap'), readerId: request.id },
    });
    expect(await call(w, 'GET', '/credentials', owner)).toMatchObject({
      body: { credentials: [{ id: login.id }, { id: request.id, expiresAt, parentId: login.id }] },
    });

    const log = actions(world);
    expect(log.find(({ action }) => action === 'request.approve')).toMatchObject({
      detail: expect.stringMatching(/^agent: until \d{4}-\d{2}-\d{2}$/),
    });
    expect(
      log
        .filter(({ action }) => action === 'grant.set')
        .map(({ detail }) => detail)
        .sort(),
    ).toEqual(['agent: read', 'agent: write']);
    expect(
      await ok<{ events: { action: string; environmentSealedName: string | null }[] }>(
        w,
        'GET',
        `/activity?environmentId=${production}`,
        owner,
      ),
    ).toMatchObject({
      events: [
        { action: 'environment.load', environmentSealedName: sealedOf('app/production') },
        { action: 'grant.set', environmentSealedName: sealedOf('app/production') },
        { action: 'environment.create', environmentSealedName: sealedOf('app/production') },
      ],
    });

    // Answered once.
    expect(await approve(request.id)).toMatchObject({
      status: 410,
      body: { code: 'LinkSpentError' },
    });
    expect(await call(w, 'POST', `/requests/${request.id}/reject`, owner)).toMatchObject({
      status: 410,
      body: { code: 'LinkSpentError' },
    });
  });

  it('is refused unless it matches the request exactly', async () => {
    const world = await setup();
    const { w, owner, production, staging, login, ask, approval } = world;
    const other = await world.org('other');
    const request = await ask(login, [
      { environmentId: production, read: true },
      { environmentId: staging, write: true },
    ]);
    const exact = await approval(request.id);
    type Approval = typeof exact;
    const changed: ReadonlyArray<(approval: Approval) => Approval> = [
      ({ grants, ...rest }) => ({ ...rest, grants: grants.slice(1) }),
      ({ grants, ...rest }) => ({
        ...rest,
        grants: [...grants, { ...grants[0]!, environmentId: crypto.randomUUID() }],
      }),
      ({ grants, ...rest }) => ({ ...rest, grants: [...grants, grants[0]!] }),
      ({ grants, ...rest }) => ({
        ...rest,
        grants: grants.map(grant => ({ ...grant, readWrap: sealedLike('wrap') })),
      }),
      ({ grants, ...rest }) => ({
        ...rest,
        grants: grants.map(grant => ({ ...grant, readWrap: null })),
      }),
      ({ grants, ...rest }) => ({
        ...rest,
        grants: grants.map(grant => ({ ...grant, keyVersion: 2 })),
      }),
      ({ namesKeyWraps, ...rest }) => ({ ...rest, namesKeyWraps: [] }),
      ({ namesKeyWraps, ...rest }) => ({
        ...rest,
        namesKeyWraps: [...namesKeyWraps, { orgId: other, wrap: NAMES_KEY_WRAP }],
      }),
    ];

    for (const change of changed) {
      expect(
        await call(w, 'POST', `/requests/${request.id}/approve`, owner, change(exact)),
      ).toMatchObject({
        status: 400,
        body: { code: 'InvalidRequestError' },
      });
    }
    expect(w.sqlite.prepare('SELECT COUNT(*) AS n FROM environment_grant').get()).toEqual({ n: 0 });
    expect(await call(w, 'GET', `/requests/${request.id}`, owner)).toMatchObject({
      body: { status: 'pending' },
    });
    expect(await call(w, 'POST', `/requests/${request.id}/approve`, owner, exact)).toMatchObject({
      status: 200,
    });
  });

  it('is refused when an environment it names was deleted since', async () => {
    const world = await setup();
    const { w, owner, production, login, ask, approve } = world;
    const deleted = await ask(login, [{ environmentId: production, read: true }]);
    await ok(w, 'DELETE', `/environments/${production}`, owner);

    expect(await approve(deleted.id)).toMatchObject({
      status: 404,
      body: { code: 'NotFoundError' },
    });
  });

  it('loses to an answer that lands first, and changes nothing', async () => {
    const world = await setup();
    const { w, production, login, ask, approve } = world;
    const request = await ask(login, [{ environmentId: production, write: true }]);
    // The maker rejects it between the owner's checks and the approval's batch.
    w.beforeStatement(/INSERT INTO environment_grant\b/, () => {
      w.sqlite.exec(`UPDATE access_request SET status = 'rejected'`);
    });

    expect(await approve(request.id)).toMatchObject({
      status: 410,
      body: { code: 'LinkSpentError' },
    });
    for (const table of ['environment_grant', 'names_key_wrap']) {
      expect(
        w.sqlite
          .prepare(
            `SELECT COUNT(*) AS n FROM ${table} WHERE ${table === 'environment_grant' ? 'credential_id' : 'reader_id'} = ?`,
          )
          .get(request.id),
      ).toEqual({ n: 0 });
    }
  });
  it('is the only way a waiting request’s key gets access: the owner’s access controls do not know it', async () => {
    const world = await setup();
    const { w, owner, production, login, ask } = world;
    const request = await ask(login, [{ environmentId: production, read: true }]);
    const grant = {
      canWrite: true,
      readWrap: sealedLike('read-wrap'),
      keyProof: sealedLike('key-proof'),
      keyVersion: 1,
    };

    for (const [method, path, body] of [
      ['PUT', `/environments/${production}/grants/${request.id}`, grant],
      ['DELETE', `/environments/${production}/grants/${request.id}`, undefined],
      [
        'PUT',
        `/credentials/${request.id}/grants/${production}`,
        { canRead: false, canWrite: true, keyProof: sealedLike('key-proof') },
      ],
      ['DELETE', `/credentials/${request.id}/grants/${production}`, undefined],
      ['PUT', `/credentials/${request.id}/expiry`, { expiresAt: null }],
    ] as const) {
      expect(await call(w, method, path, owner, body)).toMatchObject({
        status: 404,
        body: { code: 'NotFoundError' },
      });
    }
    expect(
      w.sqlite
        .prepare('SELECT COUNT(*) AS n FROM environment_grant WHERE credential_id = ?')
        .get(request.id),
    ).toEqual({ n: 0 });
    expect(await call(w, 'GET', `/environments/${production}`, request.headers)).toMatchObject({
      status: 404,
    });
  });
});

describe('rejecting', () => {
  it('is the owner’s or the maker’s, and revokes the key', async () => {
    const world = await setup();
    const { w, owner, production, login, ask, pair } = world;
    const other = await pair('desktop');
    const first = await ask(login, [{ environmentId: production, read: true }]);
    const second = await ask(login, [{ environmentId: production, read: true }]);

    expect(await call(w, 'POST', `/requests/${first.id}/reject`, first.headers)).toMatchObject({
      status: 403,
      body: { code: 'OwnerRequiredError' },
    });
    expect(await call(w, 'POST', `/requests/${first.id}/reject`, other.headers)).toMatchObject({
      status: 404,
    });
    expect(await call(w, 'POST', `/requests/${first.id}/reject`, login.headers)).toMatchObject({
      status: 200,
      body: { status: 'rejected', resolvedAt: expect.any(Number) },
    });
    expect(await call(w, 'POST', `/requests/${second.id}/reject`, owner)).toMatchObject({
      status: 200,
      body: { status: 'rejected' },
    });
    for (const { headers } of [first, second]) {
      expect(await call(w, 'GET', '/me', headers)).toMatchObject({ status: 401 });
    }
    expect(await world.approve(first.id)).toMatchObject({
      status: 410,
      body: { code: 'LinkSpentError' },
    });
    expect(actions(world).filter(({ action }) => action === 'request.reject')).toHaveLength(2);
  });

  it('happens to a waiting request when its CLI login is revoked', async () => {
    const world = await setup();
    const { w, owner, production, login, ask } = world;
    const request = await ask(login, [{ environmentId: production, read: true }]);

    await ok(w, 'DELETE', `/credentials/${login.id}`, owner);

    expect(await call(w, 'GET', `/requests/${request.id}`, owner)).toMatchObject({
      body: { status: 'rejected' },
    });
    expect(await ok(w, 'GET', '/requests', owner)).toEqual({ requests: [] });
  });

  it('leaves a request past its hour expired when its CLI login is revoked', async () => {
    const world = await setup();
    const { w, owner, production, login, ask } = world;
    const request = await ask(login, [{ environmentId: production, read: true }]);
    w.sqlite
      .prepare('UPDATE access_request SET created_at = created_at - ? WHERE credential_id = ?')
      .run(HOUR, request.id);

    await ok(w, 'DELETE', `/credentials/${login.id}`, owner);

    expect(await call(w, 'GET', `/requests/${request.id}`, owner)).toMatchObject({
      body: { status: 'expired' },
    });
    expect(
      w.sqlite.prepare('SELECT status FROM access_request WHERE credential_id = ?').get(request.id),
    ).toEqual({ status: 'expired' });
  });
});

describe('the daily run', () => {
  it('closes a request nobody answered in an hour, and revokes a key whose time is up', async () => {
    const world = await setup();
    const { w, production, login, ask, serviceAccount } = world;
    const stale = await ask(login, [{ environmentId: production, read: true }], { name: 'stale' });
    const fresh = await ask(login, [{ environmentId: production, read: true }], { name: 'fresh' });
    const ending = await serviceAccount([{ environmentId: production, read: true }], {
      name: 'ending',
      maker: login,
      expiresAt: Date.now() + DAY,
    });
    const lasting = await serviceAccount([{ environmentId: production, read: true }], {
      name: 'lasting',
      maker: login,
    });
    w.sqlite
      .prepare('UPDATE access_request SET created_at = created_at - ? WHERE credential_id = ?')
      .run(HOUR, stale.id);
    w.sqlite
      .prepare('UPDATE credential SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, ending.id);

    // Expired the moment its hour is up, before any run: read as expired, off the waiting list,
    // and past approving or rejecting.
    const { createdAt } = await ok<{ createdAt: number }>(
      w,
      'GET',
      `/requests/${stale.id}`,
      world.owner,
    );
    expect(await call(w, 'GET', `/requests/${stale.id}`, login.headers)).toMatchObject({
      body: { status: 'expired', resolvedAt: createdAt + HOUR },
    });
    expect(
      (await ok<{ requests: unknown[] }>(w, 'GET', '/requests', world.owner)).requests,
    ).toEqual([expect.objectContaining({ id: fresh.id })]);
    expect(
      await call(
        w,
        'POST',
        `/requests/${stale.id}/approve`,
        world.owner,
        await world.approval(stale.id),
      ),
    ).toMatchObject({ status: 410, body: { code: 'LinkSpentError' } });
    expect(await call(w, 'POST', `/requests/${stale.id}/reject`, world.owner)).toMatchObject({
      body: { code: 'LinkSpentError' },
    });
    expect(await call(w, 'GET', '/environments', stale.headers)).toMatchObject({
      body: { environments: [] },
    });

    expect(await sweep(world)).toEqual({ expired: 1, ended: 1 });

    expect(await call(w, 'GET', `/requests/${stale.id}`, world.owner)).toMatchObject({
      body: { status: 'expired', resolvedAt: createdAt + HOUR },
    });
    expect(await call(w, 'GET', `/requests/${fresh.id}`, world.owner)).toMatchObject({
      body: { status: 'pending' },
    });
    expect(await call(w, 'GET', '/me', lasting.headers)).toMatchObject({ status: 200 });
    for (const id of [stale.id, ending.id]) {
      expect(
        w.sqlite
          .prepare('SELECT revoked_at IS NOT NULL AS revoked FROM credential WHERE id = ?')
          .get(id),
      ).toEqual({ revoked: 1 });
    }
    expect(
      w.sqlite
        .prepare('SELECT COUNT(*) AS n FROM environment_grant WHERE credential_id = ?')
        .get(ending.id),
    ).toEqual({ n: 0 });
    const system = JSON.stringify({ kind: 'system', id: 'requests', name: 'baymutt' });
    expect(actions(world).filter(({ actor }) => actor === system)).toEqual([
      expect.objectContaining({
        action: 'request.expire',
        detail: 'stale',
      }),
      expect.objectContaining({
        action: 'credential.revoke',
        detail: expect.stringMatching(/^ending: ended on \d{4}-\d{2}-\d{2}$/),
      }),
    ]);

    // Nothing is left for the next run.
    expect(await sweep(world)).toEqual({ expired: 0, ended: 0 });
  });
});
