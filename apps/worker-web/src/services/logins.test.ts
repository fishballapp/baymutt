/** Logins hold every project; any service account may expire; both carry what their maker said they are for. */
import { tokenHash } from '@baymutt/keys/wire';
import { describe, expect, it } from 'vitest';
import { call, ok, type StoreWorld, storeWorld } from '../test-store.ts';
import { keyLike, sealedLike } from '../test-support.ts';

const DAY = 24 * 3600 * 1000;

/** A service account a login makes, holding read and write on `projects`. */
const scoped = async (
  { w }: StoreWorld,
  parent: { readonly headers: Record<string, string> },
  projects: ReadonlyArray<string>,
  about: { readonly description?: string; readonly expiresAt?: number } = {},
) => {
  const id = crypto.randomUUID();
  const secret = keyLike('s');
  const answer = await call(w, 'POST', '/credentials', parent.headers, {
    ...about,
    id,
    name: 'ci',
    publicKey: keyLike('k'),
    bearerHash: await tokenHash(secret),
    grants: projects.map(projectId => ({
      projectId,
      canWrite: true,
      readWrap: sealedLike('child-wrap'),
      keyProof: sealedLike('proof'),
    })),
  });
  expect(answer).toMatchObject({ status: 201 });
  return { id, headers: { authorization: `Bearer baymutt_${id}_${secret}` } };
};

describe('a login', () => {
  it('approved with every project in the same request can load each of them', async () => {
    const { w, pair, project } = await storeWorld();
    const projectIds = [
      await project('app/production'),
      await project('app/staging'),
      await project('app/development'),
    ];
    const login = await pair('laptop', { projects: projectIds });

    for (const projectId of projectIds) {
      expect(await call(w, 'GET', `/projects/${projectId}/bundle`, login.headers)).toMatchObject({
        status: 200,
        body: { wrap: sealedLike('login-wrap') },
      });
    }
    expect(await call(w, 'GET', '/projects', login.headers)).toMatchObject({
      body: {
        projects: projectIds.map(() => ({ canRead: true, canWrite: true })),
      },
    });
  });

  it('is approved with none of a grant that names another account’s project', async () => {
    const { w, pair } = await storeWorld();
    const stranger = await storeWorld('user-2');
    const theirs = await stranger.project('their/production');
    const login = await pair('laptop', { projects: [theirs] });

    expect(await call(w, 'GET', '/projects', login.headers)).toEqual({
      status: 200,
      body: { projects: [] },
    });
  });

  it('gets a project the owner creates in the dashboard in the same request', async () => {
    const world = await storeWorld();
    const { w, pair, project } = world;
    const login = await pair('laptop');
    const scopedOne = await scoped(world, login, []);

    // The dashboard names every login; a parented service account named here is dropped.
    const projectId = await project('app/production', world.owner, [login.id, scopedOne.id]);

    expect(await call(w, 'GET', `/projects/${projectId}/bundle`, login.headers)).toMatchObject({
      status: 200,
    });
    expect(await call(w, 'GET', '/projects', scopedOne.headers)).toEqual({
      status: 200,
      body: { projects: [] },
    });
  });

  it('waits for the owner’s dashboard on a project another service account made, then reads it', async () => {
    const { w, pair, project, grant } = await storeWorld();
    const laptop = await pair('laptop');
    const server = await pair('server');
    const projectId = await project('app/production', server.headers);

    const waiting = await call(w, 'GET', `/projects/${projectId}/bundle`, laptop.headers);
    expect(waiting).toMatchObject({ status: 403, body: { code: 'NoAccessError', need: 'read' } });
    expect((waiting.body as { message: string }).message).toContain('open the baymutt dashboard');

    // Listed, and nothing more: no names of its secrets, no versions, no grants.
    for (const path of [
      `/projects/${projectId}`,
      `/projects/${projectId}/secrets`,
      `/projects/${projectId}/grants`,
    ]) {
      expect(await call(w, 'GET', path, laptop.headers)).toMatchObject({
        status: 403,
        body: { code: 'NoAccessError' },
      });
    }

    // The dashboard's top-up: the owner's vault wraps it to the login.
    await grant(projectId, laptop.id, { read: true, write: true });

    expect(await call(w, 'GET', `/projects/${projectId}/bundle`, laptop.headers)).toMatchObject({
      status: 200,
    });
  });

  it('cannot hand a new project to other logins, and finds access requests removed', async () => {
    const { w, pair } = await storeWorld();
    const laptop = await pair('laptop');
    const server = await pair('server');

    expect(
      await call(w, 'POST', '/projects', laptop.headers, {
        id: crypto.randomUUID(),
        name: 'app/production',
        publicKey: keyLike('p'),
        ownerWrap: sealedLike('owner-wrap'),
        ownerProof: sealedLike('owner-proof'),
        creatorWrap: sealedLike('creator-wrap'),
        creatorProof: sealedLike('creator-proof'),
        loginGrants: [
          { credentialId: server.id, readWrap: sealedLike('w'), keyProof: sealedLike('p') },
        ],
      }),
    ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
    // What `baymutt access request` and `access list` call from a CLI before 0.4.0.
    for (const method of ['POST', 'GET'] as const) {
      expect(
        await call(
          w,
          method,
          '/access-requests',
          laptop.headers,
          method === 'GET'
            ? undefined
            : {
                id: crypto.randomUUID(),
                projectName: 'app/production',
                wantsRead: true,
                wantsWrite: false,
                reason: 'to deploy',
              },
        ),
      ).toMatchObject({
        status: 403,
        body: {
          code: 'OwnerRequiredError',
          message: expect.stringContaining('Access requests were removed'),
        },
      });
    }
  });
});

describe('a service account a login made', () => {
  it('holds only what its maker handed on, and cannot widen itself', async () => {
    const world = await storeWorld();
    const { w, pair, project } = world;
    const handedOn = await project('app/production');
    const other = await project('app/staging');
    const login = await pair('laptop', { projects: [handedOn, other] });
    const ci = await scoped(world, login, [handedOn]);

    expect(await call(w, 'GET', '/projects', ci.headers)).toMatchObject({
      body: { projects: [{ id: handedOn }] },
    });
    expect(await call(w, 'GET', `/projects/${other}/bundle`, ci.headers)).toMatchObject({
      status: 404,
    });
    expect(
      await call(w, 'PUT', `/projects/${other}/grants/${ci.id}`, ci.headers, {
        canWrite: true,
        readWrap: sealedLike('self-made'),
        keyProof: sealedLike('proof'),
        keyVersion: 1,
      }),
    ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
  });

  it('cannot create a project, which the owner’s vault could never open', async () => {
    const world = await storeWorld();
    const { w, pair, project } = world;
    const login = await pair('laptop');
    const ci = await scoped(world, login, [await project('app/production', login.headers)]);

    expect(
      await call(w, 'POST', '/projects', ci.headers, {
        id: crypto.randomUUID(),
        name: 'app/staging',
        publicKey: keyLike('p'),
        ownerWrap: sealedLike('owner-wrap'),
        ownerProof: sealedLike('owner-proof'),
        creatorWrap: sealedLike('creator-wrap'),
        creatorProof: sealedLike('creator-proof'),
      }),
    ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
  });

  it('is refused an expiry no date can hold', async () => {
    const world = await storeWorld();
    const login = await world.pair('laptop');
    expect(
      await call(world.w, 'PUT', `/credentials/${login.id}/expiry`, world.owner, {
        expiresAt: 9_000_000_000_000_000,
      }),
    ).toMatchObject({ status: 400 });
  });
});

describe('expiry', () => {
  it('refuses an expired service account and every one its login made, until the owner extends it', async () => {
    const world = await storeWorld();
    const { w, owner, pair, project } = world;
    const projectId = await project('app/production');
    const login = await pair('laptop', { projects: [projectId] });
    const ci = await scoped(world, login, [projectId]);

    await ok(w, 'PUT', `/credentials/${login.id}/expiry`, owner, { expiresAt: Date.now() - 1 });

    for (const { headers } of [login, ci]) {
      expect(await call(w, 'GET', `/projects/${projectId}/bundle`, headers)).toMatchObject({
        status: 401,
        body: { code: 'UnauthorizedError' },
      });
    }
    expect((await call(w, 'GET', '/me', login.headers)).body).toMatchObject({
      message: expect.stringContaining('expired'),
    });
    expect((await call(w, 'GET', '/me', ci.headers)).body).toMatchObject({
      message: expect.stringContaining('The login that made this service account expired'),
    });
    // Still listed, so the owner can see it and extend it.
    expect(await call(w, 'GET', '/credentials', owner)).toMatchObject({
      body: { credentials: [{ id: login.id, expiresAt: expect.any(Number) }, { id: ci.id }] },
    });

    const later = Date.now() + 30 * DAY;
    expect(
      await call(w, 'PUT', `/credentials/${login.id}/expiry`, owner, { expiresAt: later }),
    ).toMatchObject({ status: 200, body: { id: login.id, expiresAt: later } });

    for (const { headers } of [login, ci]) {
      expect(await call(w, 'GET', `/projects/${projectId}/bundle`, headers)).toMatchObject({
        status: 200,
      });
    }
    const { events } = await ok<{ events: { action: string; detail: string | null }[] }>(
      w,
      'GET',
      '/audit',
      owner,
    );
    expect(events.filter(({ action }) => action === 'credential.expiry')).toHaveLength(2);
  });

  it('refuses a service account whose expiry was set when it was made, once it passes', async () => {
    const world = await storeWorld();
    const { w, pair } = world;
    const expired = await pair('laptop', { expiresAt: Date.now() - 1 });
    const live = await pair('server', { expiresAt: Date.now() + DAY });
    const ci = await scoped(world, live, [], { expiresAt: Date.now() - 1 });

    expect(await call(w, 'GET', '/me', expired.headers)).toMatchObject({ status: 401 });
    expect(await call(w, 'GET', '/me', live.headers)).toMatchObject({ status: 200 });
    expect(await call(w, 'GET', '/me', ci.headers)).toMatchObject({ status: 401 });
  });

  it('is the owner’s alone to change, never the service account’s own', async () => {
    const world = await storeWorld();
    const { w, pair, locked } = world;
    const login = await pair('laptop', { expiresAt: Date.now() + DAY });
    const ci = await scoped(world, login, []);

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
});

describe('a description', () => {
  it('is kept as its maker wrote it, and is optional', async () => {
    const world = await storeWorld();
    const { w, owner, pair } = world;
    const login = await pair('laptop', { description: 'Agents on the work laptop' });
    await scoped(world, login, [], { description: 'Deploys app/production from CI' });
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
      await call(w, 'POST', '/credentials', login.headers, {
        id: crypto.randomUUID(),
        name: 'too-long',
        publicKey: keyLike('k'),
        bearerHash: keyLike('h'),
        grants: [],
        description: 'x'.repeat(141),
      }),
    ).toMatchObject({ status: 400 });
  });
});
