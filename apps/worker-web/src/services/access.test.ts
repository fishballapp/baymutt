/** Who may do what: service accounts, projects and the grants between them. */
import { tokenHash } from '@baymutt/keys/wire';
import { describe, expect, it } from 'vitest';
import { call, newAccount, ok, type StoreWorld, storeWorld, VAULT_PROOF } from '../test-store.ts';
import { keyLike, sealedLike } from '../test-support.ts';

const child = async (
  { w }: StoreWorld,
  parent: { readonly headers: Record<string, string> },
  grants: ReadonlyArray<{
    projectId: string;
    canWrite: boolean;
    readWrap: string | null;
    keyProof: string;
  }>,
  name = 'ci',
  about: { readonly description?: string; readonly expiresAt?: number } = {},
) => {
  const id = crypto.randomUUID();
  const secret = keyLike('c');
  const answer = await call(w, 'POST', '/credentials', parent.headers, {
    ...about,
    id,
    name,
    publicKey: keyLike('k'),
    bearerHash: await tokenHash(secret),
    grants,
  });
  return { id, answer, headers: { authorization: `Bearer baymutt_${id}_${secret}` } };
};

describe('a service account', () => {
  it('is recognised by its bearer once paired, and as a login sees every project', async () => {
    const { w, pair, project, accountId } = await storeWorld();
    const projectId = await project('app/production');
    const serviceAccount = await pair('laptop');

    expect(await call(w, 'GET', '/me', serviceAccount.headers)).toEqual({
      status: 200,
      body: {
        accountId,
        accountName: 'Jason',
        accountPublicKey: keyLike('a'),
        credential: {
          id: serviceAccount.id,
          name: 'laptop',
          parentId: null,
          welcome: sealedLike('welcome'),
        },
      },
    });
    // Approved without the owner's wraps (as a pre-0.3.0 dashboard did): it sees the project and
    // holds nothing on it until the dashboard tops it up.
    expect(await call(w, 'GET', '/projects', serviceAccount.headers)).toMatchObject({
      status: 200,
      body: { projects: [{ id: projectId, canRead: false, canWrite: false, keyProof: null }] },
    });
  });

  it('is refused with a wrong secret, an unknown id or a malformed bearer', async () => {
    const { w, pair } = await storeWorld();
    const serviceAccount = await pair();
    const [, id] = serviceAccount.headers.authorization.split('_');

    for (const authorization of [
      `Bearer baymutt_${id}_${keyLike('z')}`,
      `Bearer baymutt_${crypto.randomUUID()}_${keyLike('1')}`,
      'Bearer something-else',
    ]) {
      expect(await call(w, 'GET', '/me', { authorization })).toMatchObject({
        status: 401,
        body: { code: 'UnauthorizedError' },
      });
    }
  });

  it('cannot be paired by a service account, nor twice under one id', async () => {
    const { w, owner, pair } = await storeWorld();
    const serviceAccount = await pair();
    const pairing = {
      id: serviceAccount.id,
      name: 'again',
      publicKey: keyLike('m'),
      bearerHash: keyLike('h'),
      endorsement: sealedLike('e'),
      welcome: sealedLike('w'),
    };

    expect(await call(w, 'POST', '/credentials/pair', owner, pairing)).toMatchObject({
      status: 409,
      body: { code: 'AlreadyExistsError' },
    });
    expect(
      await call(w, 'POST', '/credentials/pair', serviceAccount.headers, {
        ...pairing,
        id: crypto.randomUUID(),
      }),
    ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
  });

  it('holds a project only once granted, and only the owner grants', async () => {
    const world = await storeWorld();
    const { w, pair, project, grant } = world;
    const projectId = await project('app/production');
    const serviceAccount = await pair();
    const other = await pair();

    // A login is listed the project, and holds nothing on it until the owner's browser grants it.
    expect(await call(w, 'GET', `/projects/${projectId}`, serviceAccount.headers)).toMatchObject({
      status: 403,
      body: { code: 'NoAccessError' },
    });
    expect(
      await call(
        w,
        'PUT',
        `/projects/${projectId}/grants/${serviceAccount.id}`,
        serviceAccount.headers,
        {
          canWrite: true,
          readWrap: sealedLike('self-made'),
          keyProof: sealedLike('proof'),
          keyVersion: 1,
        },
      ),
    ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });

    await grant(projectId, serviceAccount.id, { write: true });

    expect(await call(w, 'GET', `/projects/${projectId}`, serviceAccount.headers)).toMatchObject({
      status: 200,
      body: { name: 'app/production', canRead: false, canWrite: true },
    });
    // A grant of its own does not let it grant another service account.
    expect(
      await call(w, 'PUT', `/projects/${projectId}/grants/${other.id}`, serviceAccount.headers, {
        canWrite: true,
        readWrap: null,
        keyProof: sealedLike('proof'),
        keyVersion: 1,
      }),
    ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
    expect(await call(w, 'GET', `/projects/${projectId}`, other.headers)).toMatchObject({
      status: 403,
    });
  });

  it('creates a project and holds read and write on what it created', async () => {
    const { w, owner, pair, project } = await storeWorld();
    const serviceAccount = await pair('laptop');

    const projectId = await project('app/development', serviceAccount.headers);

    expect(await call(w, 'GET', '/projects', serviceAccount.headers)).toMatchObject({
      body: {
        projects: [
          {
            id: projectId,
            name: 'app/development',
            keyVersion: 1,
            canRead: true,
            canWrite: true,
            createdBy: { kind: 'machine', id: serviceAccount.id, name: 'laptop' },
          },
        ],
      },
    });
    // The owner reads every project: the creator wrapped the key to the account too.
    expect(await call(w, 'GET', `/projects/${projectId}/owner-wrap`, owner)).toEqual({
      status: 200,
      body: {
        ownerWrap: sealedLike('owner-wrap'),
        ownerProof: sealedLike('owner-proof'),
        keyVersion: 1,
        creator: {
          id: serviceAccount.id,
          publicKey: keyLike('m'),
          endorsement: sealedLike('endorsement'),
        },
      },
    });
    expect(
      await call(w, 'GET', `/projects/${projectId}/owner-wrap`, serviceAccount.headers),
    ).toMatchObject({ status: 403 });
    expect(
      await call(w, 'POST', '/projects', owner, {
        id: crypto.randomUUID(),
        name: 'app/development',
        publicKey: keyLike('p'),
        ownerWrap: sealedLike('o'),
        ownerProof: sealedLike('o'),
        creatorWrap: null,
        creatorProof: null,
      }),
    ).toMatchObject({ status: 409, body: { code: 'AlreadyExistsError' } });
  });
});

describe('a narrower service account', () => {
  it('holds what its maker handed on and nothing its maker lacks', async () => {
    const world = await storeWorld();
    const { w, pair, project, grant } = world;
    const readable = await project('app/production');
    const writable = await project('app/staging');
    const unseen = await project('app/other');
    const parent = await pair('laptop');
    await grant(readable, parent.id, { read: true, write: true });
    await grant(writable, parent.id, { write: true });

    expect(
      (
        await child(world, parent, [
          {
            projectId: writable,
            canWrite: true,
            readWrap: sealedLike('r'),
            keyProof: sealedLike('proof'),
          },
        ])
      ).answer,
    ).toMatchObject({ status: 403, body: { code: 'NoAccessError', need: 'read' } });
    expect(
      (
        await child(world, parent, [
          { projectId: unseen, canWrite: true, readWrap: null, keyProof: sealedLike('proof') },
        ])
      ).answer,
    ).toMatchObject({ status: 403, body: { code: 'NoAccessError', need: 'write' } });

    const ci = await child(world, parent, [
      {
        projectId: readable,
        canWrite: false,
        readWrap: sealedLike('child-wrap'),
        keyProof: sealedLike('proof'),
      },
    ]);

    expect(ci.answer).toMatchObject({
      status: 201,
      body: {
        parentId: parent.id,
        endorsement: null,
        grants: [{ projectId: readable, canRead: true, canWrite: false }],
      },
    });
    expect(await call(w, 'GET', '/projects', ci.headers)).toMatchObject({
      body: { projects: [{ id: readable, canRead: true, canWrite: false }] },
    });
  });

  it('can make no service account of its own, and neither can the owner’s session through this route', async () => {
    const world = await storeWorld();
    const parent = await world.pair();
    const ci = await child(world, parent, []);

    expect((await child(world, ci, [])).answer).toMatchObject({
      status: 403,
      body: { code: 'OwnerRequiredError' },
    });
    expect((await child(world, { headers: world.owner }, [])).answer).toMatchObject({
      status: 403,
      body: { code: 'OwnerRequiredError' },
    });
  });

  it('goes with its maker when the maker is revoked or loses the grant', async () => {
    const world = await storeWorld();
    const { w, owner, pair, project, grant } = world;
    const projectId = await project('app/production');
    const parent = await pair();
    const bystander = await pair();
    await grant(projectId, parent.id, { read: true, write: true });
    await grant(projectId, bystander.id, { write: true });
    const ci = await child(world, parent, [
      {
        projectId,
        canWrite: true,
        readWrap: sealedLike('child-wrap'),
        keyProof: sealedLike('proof'),
      },
    ]);
    const second = await child(world, parent, [
      { projectId, canWrite: true, readWrap: null, keyProof: sealedLike('proof') },
    ]);

    await ok(w, 'DELETE', `/projects/${projectId}/grants/${parent.id}`, owner);

    expect(await call(w, 'GET', '/projects', parent.headers)).toMatchObject({
      body: { projects: [{ id: projectId, canRead: false, canWrite: false }] },
    });
    for (const serviceAccount of [ci, second]) {
      expect(await call(w, 'GET', '/projects', serviceAccount.headers)).toMatchObject({
        body: { projects: [] },
      });
    }

    expect(await call(w, 'DELETE', `/credentials/${parent.id}`, bystander.headers)).toMatchObject({
      status: 403,
      body: { code: 'OwnerRequiredError' },
    });
    expect(
      new Set(
        (await ok<{ revoked: string[] }>(w, 'DELETE', `/credentials/${parent.id}`, parent.headers))
          .revoked,
      ),
    ).toEqual(new Set([parent.id, ci.id, second.id]));

    for (const serviceAccount of [parent, ci, second]) {
      expect(await call(w, 'GET', '/me', serviceAccount.headers)).toMatchObject({ status: 401 });
    }
    expect(await call(w, 'GET', '/me', bystander.headers)).toMatchObject({ status: 200 });
    expect(
      w.sqlite.prepare("SELECT COUNT(*) AS kept FROM credential WHERE bearer_hash != ''").get(),
    ).toEqual({ kept: 1 });
  });
});

describe('what a caller is shown', () => {
  it('lists every service account to the owner, and to a service account only itself and those it made', async () => {
    const world = await storeWorld();
    const { w, owner, pair } = world;
    const laptop = await pair('laptop');
    const other = await pair('other');
    const ci = await child(world, laptop, []);
    const names = async (headers: Record<string, string>) =>
      (
        await ok<{ credentials: { id: string; endorsement: string | null }[] }>(
          w,
          'GET',
          '/credentials',
          headers,
        )
      ).credentials;

    expect((await names(owner)).map(({ id }) => id)).toEqual([laptop.id, other.id, ci.id]);
    expect((await names(owner))[0]?.endorsement).toBe(sealedLike('endorsement'));
    expect(await names(laptop.headers)).toMatchObject([
      { id: laptop.id, endorsement: null },
      { id: ci.id, endorsement: null },
    ]);
    expect((await names(ci.headers)).map(({ id }) => id)).toEqual([ci.id]);
  });

  it('keeps one account’s projects and service accounts from another’s', async () => {
    const one = await storeWorld();
    const projectId = await one.project('app/production');
    const serviceAccount = await one.pair();
    const stranger = one.w.user('user-2');
    const strangerLocked = one.w.signIn(stranger.id);
    await ok(
      one.w,
      'POST',
      '/account',
      strangerLocked,
      await newAccount(crypto.randomUUID(), stranger.first.credentialId),
      201,
    );
    // The stranger's own vault is open; it is still not this account's.
    const strangerSession = { ...strangerLocked, 'x-baymutt-vault-proof': VAULT_PROOF };

    for (const [method, path, body] of [
      ['GET', `/projects/${projectId}`, undefined],
      ['GET', `/projects/${projectId}/bundle`, undefined],
      ['DELETE', `/projects/${projectId}`, undefined],
      ['DELETE', `/credentials/${serviceAccount.id}`, undefined],
      [
        'PUT',
        `/projects/${projectId}/grants/${serviceAccount.id}`,
        { canWrite: true, readWrap: null, keyProof: sealedLike('proof'), keyVersion: 1 },
      ],
    ] as const) {
      expect(await call(one.w, method, path, strangerSession, body)).toMatchObject({
        status: 404,
        body: { code: 'NotFoundError' },
      });
    }
    expect(await call(one.w, 'GET', '/projects', strangerSession)).toEqual({
      status: 200,
      body: { projects: [] },
    });
  });
});

describe('an access request', () => {
  const ask = (
    { w }: StoreWorld,
    headers: Record<string, string>,
    request: { projectName: string; wantsRead?: boolean; wantsWrite?: boolean },
  ) => {
    const id = crypto.randomUUID();
    return call(w, 'POST', '/access-requests', headers, {
      id,
      wantsRead: false,
      wantsWrite: false,
      reason: 'to deploy the worker',
      ...request,
    }).then(answer => ({ id, answer }));
  };

  it('names a project the service account cannot yet see, and the owner’s approval is the grant', async () => {
    const world = await storeWorld();
    const { w, owner, pair, project } = world;
    const projectId = await project('app/production');
    const serviceAccount = await child(world, await pair('laptop'), [], 'ci');

    const { id, answer } = await ask(world, serviceAccount.headers, {
      projectName: 'app/production',
      wantsRead: true,
      wantsWrite: true,
    });

    expect(answer).toMatchObject({ status: 201, body: { status: 'pending', endorsement: null } });
    expect(await call(w, 'GET', '/access-requests', owner)).toMatchObject({
      body: {
        requests: [
          {
            id,
            projectId,
            credentialName: 'ci',
            endorsement: null,
            wantsRead: true,
            wantsWrite: true,
            reason: 'to deploy the worker',
          },
        ],
      },
    });
    expect(
      await call(w, 'POST', `/access-requests/${id}/approve`, serviceAccount.headers, {
        canWrite: true,
        readWrap: sealedLike('self'),
        keyProof: sealedLike('proof'),
        keyVersion: 1,
      }),
    ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });

    await ok(w, 'POST', `/access-requests/${id}/approve`, owner, {
      canWrite: true,
      readWrap: sealedLike('approved-wrap'),
      keyProof: sealedLike('proof'),
      keyVersion: 1,
    });

    expect(await call(w, 'GET', `/projects/${projectId}`, serviceAccount.headers)).toMatchObject({
      body: { canRead: true, canWrite: true },
    });
    expect(await call(w, 'GET', '/access-requests', owner)).toEqual({
      status: 200,
      body: { requests: [] },
    });
    expect(await call(w, 'GET', '/access-requests', serviceAccount.headers)).toMatchObject({
      body: { requests: [{ id, status: 'approved' }] },
    });
    expect(await call(w, 'POST', `/access-requests/${id}/deny`, owner)).toMatchObject({
      status: 410,
      body: { code: 'LinkSpentError' },
    });
  });

  it('gives nothing when denied, and is refused for a project that does not exist', async () => {
    const world = await storeWorld();
    const { w, owner, pair, project } = world;
    const projectId = await project('app/production');
    const serviceAccount = await child(world, await pair(), []);

    expect(
      (await ask(world, serviceAccount.headers, { projectName: 'app/missing', wantsRead: true }))
        .answer,
    ).toMatchObject({ status: 404 });
    expect(
      (await ask(world, owner, { projectName: 'app/production', wantsRead: true })).answer,
    ).toMatchObject({ status: 403 });

    const { id } = await ask(world, serviceAccount.headers, {
      projectName: 'app/production',
      wantsRead: true,
    });
    await ok(w, 'POST', `/access-requests/${id}/deny`, owner);

    expect(await call(w, 'GET', `/projects/${projectId}`, serviceAccount.headers)).toMatchObject({
      status: 404,
    });
  });
});

describe('the audit log', () => {
  it('records who did what, newest first, and shows a service account only its own entries', async () => {
    const world = await storeWorld();
    const { w, owner, pair, project, grant, write } = world;
    const projectId = await project('app/production');
    const serviceAccount = await pair('laptop');
    await grant(projectId, serviceAccount.id, { read: true, write: true });
    await write(projectId, 'API_KEY', 1, serviceAccount.headers);
    await ok(w, 'GET', `/projects/${projectId}/bundle`, serviceAccount.headers);

    const all = await ok<{ events: { action: string }[] }>(w, 'GET', '/audit', owner);

    expect(all.events.map(({ action }) => action)).toEqual([
      'project.load',
      'secret.write',
      'grant.set',
      'credential.pair',
      'project.create',
      'account.create',
    ]);
    expect(all.events[1]).toMatchObject({
      actor: { kind: 'machine', id: serviceAccount.id, name: 'laptop' },
      projectName: 'app/production',
      secretName: 'API_KEY',
      version: 1,
    });
    expect(all.events[2]).toMatchObject({
      actor: { kind: 'owner' },
      detail: 'laptop: read + write',
    });
    expect(
      (
        await ok<{ events: { action: string }[] }>(w, 'GET', '/audit', serviceAccount.headers)
      ).events.map(({ action }) => action),
    ).toEqual(['project.load', 'secret.write']);
  });

  it('pages by the id before', async () => {
    const { w, owner, project } = await storeWorld();
    await project('a');
    await project('b');

    const first = await ok<{ events: { id: string }[]; nextBefore: string | null }>(
      w,
      'GET',
      '/audit?limit=2',
      owner,
    );
    const rest = await ok<{ events: { action: string }[]; nextBefore: string | null }>(
      w,
      'GET',
      `/audit?limit=2&before=${first.nextBefore}`,
      owner,
    );

    expect(first.events).toHaveLength(2);
    expect(first.nextBefore).toBe(first.events[1]?.id);
    expect(rest.events.map(({ action }) => action)).toEqual(['account.create']);
    expect(rest.nextBefore).toBeNull();
  });
});

describe('the beta limits', () => {
  it('refuses one project more than an account may hold, and makes room when one is archived', async () => {
    const { w, owner, project, accountId } = await storeWorld();
    const first = await project('p/0');
    w.sqlite.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
       INSERT INTO project (id, account_id, name, public_key, key_version, owner_wrap, owner_proof, created_by, created_at)
       SELECT 'filler-' || i, '${accountId}', 'p/' || i, 'k', 1, 'w', 'p', '{}', 0 FROM n`,
    );
    const another = () =>
      call(w, 'POST', '/projects', owner, {
        id: crypto.randomUUID(),
        name: 'p/one-more',
        publicKey: keyLike('p'),
        ownerWrap: sealedLike('o'),
        ownerProof: sealedLike('o'),
        creatorWrap: null,
        creatorProof: null,
      });

    expect(await another()).toMatchObject({
      status: 403,
      body: { code: 'LimitReachedError', limit: 100 },
    });
    await ok(w, 'DELETE', `/projects/${first}`, owner);
    expect(await another()).toMatchObject({ status: 201 });
  });
});
