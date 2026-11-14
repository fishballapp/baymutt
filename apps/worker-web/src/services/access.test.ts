/** Who may do what: service accounts, environments and the grants between them. */
import { tokenHash } from '@baymutt/keys/wire';
import { describe, expect, it } from 'vitest';
import {
  call,
  newAccount,
  ok,
  type StoreWorld,
  storeWorld,
  VAULT_PROOF,
  VOUCHERS,
} from '../test-store.ts';
import { keyLike, sealedLike } from '../test-support.ts';

const child = async (
  { w }: StoreWorld,
  parent: { readonly headers: Record<string, string> },
  grants: ReadonlyArray<{
    environmentId: string;
    canWrite: boolean;
    readWrap: string | null;
    keyProof: string;
  }>,
  name = 'ci',
  about: {
    readonly description?: string;
    readonly expiresAt?: number;
    readonly vouchers?: { keyToOwner: string; keyToMaker: string; accountKey: string };
  } = {},
) => {
  const id = crypto.randomUUID();
  const secret = keyLike('c');
  const answer = await call(w, 'POST', '/credentials', parent.headers, {
    vouchers: VOUCHERS,
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
  it('is recognised by its bearer once paired, and as a login sees every environment', async () => {
    const { w, pair, environment, accountId } = await storeWorld();
    const environmentId = await environment('app/production');
    const serviceAccount = await pair('laptop');

    expect(await call(w, 'GET', '/me', serviceAccount.headers)).toEqual({
      status: 200,
      body: {
        accountId,
        accountName: 'Test owner',
        accountPublicKey: keyLike('a'),
        credential: {
          id: serviceAccount.id,
          name: 'laptop',
          parentId: null,
          welcome: sealedLike('welcome'),
          accountVoucher: null,
        },
      },
    });
    // Approved without the owner's wraps (as a pre-0.3.0 dashboard did): it sees the environment and
    // holds nothing on it until the dashboard tops it up.
    expect(await call(w, 'GET', '/environments', serviceAccount.headers)).toMatchObject({
      status: 200,
      body: {
        environments: [{ id: environmentId, canRead: false, canWrite: false, keyProof: null }],
      },
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
      grants: [],
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

  it('holds an environment only once granted, and only the owner grants', async () => {
    const world = await storeWorld();
    const { w, pair, environment, grant } = world;
    const environmentId = await environment('app/production');
    const serviceAccount = await pair();
    const other = await pair();

    // A login is listed the environment, and holds nothing on it until the owner's browser grants it.
    expect(
      await call(w, 'GET', `/environments/${environmentId}`, serviceAccount.headers),
    ).toMatchObject({
      status: 403,
      body: { code: 'NoAccessError' },
    });
    expect(
      await call(
        w,
        'PUT',
        `/environments/${environmentId}/grants/${serviceAccount.id}`,
        serviceAccount.headers,
        {
          canWrite: true,
          readWrap: sealedLike('self-made'),
          keyProof: sealedLike('proof'),
          keyVersion: 1,
        },
      ),
    ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });

    await grant(environmentId, serviceAccount.id, { write: true });

    expect(
      await call(w, 'GET', `/environments/${environmentId}`, serviceAccount.headers),
    ).toMatchObject({
      status: 200,
      body: { name: 'app/production', canRead: false, canWrite: true },
    });
    // A grant of its own does not let it grant another service account.
    expect(
      await call(
        w,
        'PUT',
        `/environments/${environmentId}/grants/${other.id}`,
        serviceAccount.headers,
        {
          canWrite: true,
          readWrap: null,
          keyProof: sealedLike('proof'),
          keyVersion: 1,
        },
      ),
    ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
    expect(await call(w, 'GET', `/environments/${environmentId}`, other.headers)).toMatchObject({
      status: 403,
    });
  });

  it('creates an environment and holds read and write on what it created', async () => {
    const { w, owner, pair, environment, orgId } = await storeWorld();
    const serviceAccount = await pair('laptop');

    const environmentId = await environment('app/development', serviceAccount.headers);

    expect(await call(w, 'GET', '/environments', serviceAccount.headers)).toMatchObject({
      body: {
        environments: [
          {
            id: environmentId,
            name: 'app/development',
            keyVersion: 1,
            canRead: true,
            canWrite: true,
            createdBy: { kind: 'credential', id: serviceAccount.id, name: 'laptop' },
          },
        ],
      },
    });
    // The owner reads every environment: the creator wrapped the key to the account too.
    expect(await call(w, 'GET', `/environments/${environmentId}/member-wrap`, owner)).toEqual({
      status: 200,
      body: {
        memberWrap: sealedLike('member-wrap'),
        memberProof: sealedLike('member-proof'),
        keyVersion: 1,
        creator: {
          id: serviceAccount.id,
          publicKey: keyLike('m'),
          endorsement: sealedLike('endorsement'),
        },
      },
    });
    expect(
      await call(w, 'GET', `/environments/${environmentId}/member-wrap`, serviceAccount.headers),
    ).toMatchObject({ status: 403 });
    expect(
      await call(w, 'POST', '/environments', owner, {
        id: crypto.randomUUID(),
        orgId,
        name: 'app/development',
        publicKey: keyLike('p'),
        memberWrap: sealedLike('o'),
        memberProof: sealedLike('o'),
        creatorWrap: null,
        creatorProof: null,
      }),
    ).toMatchObject({ status: 409, body: { code: 'AlreadyExistsError' } });
  });
});

describe('a narrower service account', () => {
  it('holds what its maker handed on and nothing its maker lacks', async () => {
    const world = await storeWorld();
    const { w, pair, environment, grant } = world;
    const readable = await environment('app/production');
    const writable = await environment('app/staging');
    const unseen = await environment('app/other');
    const parent = await pair('laptop');
    await grant(readable, parent.id, { read: true, write: true });
    await grant(writable, parent.id, { write: true });

    expect(
      (
        await child(world, parent, [
          {
            environmentId: writable,
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
          { environmentId: unseen, canWrite: true, readWrap: null, keyProof: sealedLike('proof') },
        ])
      ).answer,
    ).toMatchObject({ status: 403, body: { code: 'NoAccessError', need: 'write' } });

    const ci = await child(world, parent, [
      {
        environmentId: readable,
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
        grants: [{ environmentId: readable, canRead: true, canWrite: false }],
      },
    });
    expect(await call(w, 'GET', '/environments', ci.headers)).toMatchObject({
      body: { environments: [{ id: readable, canRead: true, canWrite: false }] },
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
    const { w, owner, pair, environment, grant } = world;
    const environmentId = await environment('app/production');
    const parent = await pair();
    const bystander = await pair();
    await grant(environmentId, parent.id, { read: true, write: true });
    await grant(environmentId, bystander.id, { write: true });
    const ci = await child(world, parent, [
      {
        environmentId,
        canWrite: true,
        readWrap: sealedLike('child-wrap'),
        keyProof: sealedLike('proof'),
      },
    ]);
    const second = await child(world, parent, [
      { environmentId, canWrite: true, readWrap: null, keyProof: sealedLike('proof') },
    ]);

    await ok(w, 'DELETE', `/environments/${environmentId}/grants/${parent.id}`, owner);

    expect(await call(w, 'GET', '/environments', parent.headers)).toMatchObject({
      body: { environments: [{ id: environmentId, canRead: false, canWrite: false }] },
    });
    for (const serviceAccount of [ci, second]) {
      expect(await call(w, 'GET', '/environments', serviceAccount.headers)).toMatchObject({
        body: { environments: [] },
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

  it('keeps one account’s environments and service accounts from another’s', async () => {
    const one = await storeWorld();
    const environmentId = await one.environment('app/production');
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
      ['GET', `/environments/${environmentId}`, undefined],
      ['GET', `/environments/${environmentId}/bundle`, undefined],
      ['DELETE', `/environments/${environmentId}`, undefined],
      ['DELETE', `/credentials/${serviceAccount.id}`, undefined],
      ['DELETE', `/credentials/${serviceAccount.id}/grants/${environmentId}`, undefined],
      [
        'PUT',
        `/credentials/${serviceAccount.id}/grants/${environmentId}`,
        { canRead: false, canWrite: true, keyProof: sealedLike('proof') },
      ],
      [
        'PUT',
        `/environments/${environmentId}/grants/${serviceAccount.id}`,
        { canWrite: true, readWrap: null, keyProof: sealedLike('proof'), keyVersion: 1 },
      ],
    ] as const) {
      expect(await call(one.w, method, path, strangerSession, body)).toMatchObject({
        status: 404,
        body: { code: 'NotFoundError' },
      });
    }
    expect(await call(one.w, 'GET', '/environments', strangerSession)).toEqual({
      status: 200,
      body: { environments: [] },
    });
  });
});

describe('a scoped service account’s access', () => {
  /** A login holding two environments, and a service account it made with read on the first. */
  const setup = async () => {
    const world = await storeWorld();
    const first = await world.environment('app/production');
    const second = await world.environment('app/staging');
    const login = await world.pair('laptop', { environments: [first, second] });
    const made = await child(
      world,
      login,
      [
        {
          environmentId: first,
          canWrite: false,
          readWrap: sealedLike('first-wrap'),
          keyProof: sealedLike('first-proof'),
        },
      ],
      'ci',
      { vouchers: VOUCHERS },
    );
    return { ...world, first, second, login, made };
  };

  const access = (
    { w }: StoreWorld,
    headers: Record<string, string>,
    id: string,
    environmentId: string,
    body: Record<string, unknown>,
  ) => call(w, 'PUT', `/credentials/${id}/grants/${environmentId}`, headers, body);

  it('keeps its maker’s vouchers, each shown only to the one it is sealed to', async () => {
    const { w, owner, pair, login, made } = await setup();
    const other = await pair('desktop');
    const keyVoucherSeenBy = async (headers: Record<string, string>) =>
      (
        await ok<{ credentials: { id: string; keyVoucher: string | null }[] }>(
          w,
          'GET',
          '/credentials',
          headers,
        )
      ).credentials.find(({ id }) => id === made.id)?.keyVoucher;

    expect(await keyVoucherSeenBy(owner)).toBe(VOUCHERS.keyToOwner);
    expect(await keyVoucherSeenBy(login.headers)).toBe(VOUCHERS.keyToMaker);
    expect(await keyVoucherSeenBy(made.headers)).toBeNull();
    expect(await keyVoucherSeenBy(other.headers)).toBeUndefined();
    expect(await call(w, 'GET', '/me', made.headers)).toMatchObject({
      body: { credential: { id: made.id, accountVoucher: VOUCHERS.accountKey } },
    });
    expect(await call(w, 'GET', '/me', login.headers)).toMatchObject({
      body: { credential: { id: login.id, accountVoucher: null } },
    });
  });

  it('changes by its maker and by the owner, and it reads the new environment with the key it had', async () => {
    const world = await setup();
    const { w, owner, first, second, login, made } = world;

    // Its maker hands it the second environment to read and write.
    expect(
      await access(world, login.headers, made.id, second, {
        canRead: true,
        canWrite: true,
        readWrap: sealedLike('second-wrap'),
        keyProof: sealedLike('second-proof'),
      }),
    ).toMatchObject({
      status: 200,
      body: {
        id: made.id,
        grants: [
          { environmentId: first, canRead: true, canWrite: false },
          { environmentId: second, canRead: true, canWrite: true },
        ],
      },
    });
    expect(await call(w, 'GET', `/environments/${second}/bundle`, made.headers)).toMatchObject({
      status: 200,
      body: { wrap: sealedLike('second-wrap') },
    });

    // The owner drops its read on the second, keeping the proof it already holds.
    await ok(w, 'PUT', `/credentials/${made.id}/grants/${second}`, owner, {
      canRead: false,
      canWrite: true,
    });
    expect(await call(w, 'GET', `/environments/${second}`, made.headers)).toMatchObject({
      body: { canRead: false, canWrite: true, keyProof: sealedLike('second-proof') },
    });
    // Write added on the first keeps the wrap it reads with.
    await ok(w, 'PUT', `/credentials/${made.id}/grants/${first}`, login.headers, {
      canRead: true,
      canWrite: true,
    });
    expect(await call(w, 'GET', `/environments/${first}/bundle`, made.headers)).toMatchObject({
      body: { wrap: sealedLike('first-wrap') },
    });

    // Its maker takes the first away; the owner the second.
    await ok(w, 'DELETE', `/credentials/${made.id}/grants/${first}`, login.headers);
    await ok(w, 'DELETE', `/credentials/${made.id}/grants/${second}`, owner);
    expect(await call(w, 'GET', '/environments', made.headers)).toEqual({
      status: 200,
      body: { environments: [] },
    });

    const audit = await ok<{ events: { action: string; detail: string | null }[] }>(
      w,
      'GET',
      '/activity',
      owner,
    );
    const grants = audit.events.filter(({ action }) => action.startsWith('grant.'));
    expect(grants.slice(0, 5).map(({ action, detail }) => [action, detail])).toEqual([
      ['grant.remove', 'ci'],
      ['grant.remove', 'ci'],
      ['grant.set', 'ci: read + write'],
      ['grant.set', 'ci: write'],
      ['grant.set', 'ci: read + write'],
    ]);
  });

  it('cannot be changed by itself, a sibling or another login', async () => {
    const world = await setup();
    const { w, pair, second, login, made } = world;
    const sibling = await child(world, login, [], 'sibling');
    const otherLogin = await pair('desktop', { environments: [second] });
    const widen = {
      canRead: true,
      canWrite: true,
      readWrap: sealedLike('forged-wrap'),
      keyProof: sealedLike('forged-proof'),
    };

    for (const headers of [made.headers, sibling.headers, otherLogin.headers]) {
      expect(await access(world, headers, made.id, second, widen)).toMatchObject({
        status: 403,
        body: { code: 'OwnerRequiredError' },
      });
      expect(
        await call(w, 'DELETE', `/credentials/${made.id}/grants/${second}`, headers),
      ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
    }
    // A login's own access is every environment, and does not change this way.
    expect(await access(world, world.owner, login.id, second, widen)).toMatchObject({
      status: 403,
      body: { code: 'OwnerRequiredError' },
    });
    expect(await call(w, 'GET', `/environments/${second}`, made.headers)).toMatchObject({
      status: 404,
    });
  });

  it('needs a wrap for a read it gains and a proof for an environment it gains', async () => {
    const world = await setup();
    const { first, second, login, made } = world;

    for (const [environmentId, body] of [
      [second, { canRead: false, canWrite: true }],
      [second, { canRead: true, canWrite: false, keyProof: sealedLike('proof') }],
      [first, { canRead: false, canWrite: false }],
      [first, { canRead: false, canWrite: true, readWrap: sealedLike('stray') }],
    ] as const) {
      expect(await access(world, login.headers, made.id, environmentId, body)).toMatchObject({
        status: 400,
        body: { code: 'InvalidRequestError' },
      });
    }
  });

  it('is handed on by a login only as far as it holds the environment itself', async () => {
    const world = await setup();
    const { environment, login, made } = world;
    // Made by the owner after the login's approval: the login holds nothing on it yet.
    const later = await environment('app/later');

    expect(
      await access(world, login.headers, made.id, later, {
        canRead: false,
        canWrite: true,
        keyProof: sealedLike('proof'),
      }),
    ).toMatchObject({ status: 403, body: { code: 'NoAccessError' } });
  });
});

describe('the audit log', () => {
  it('records who did what, newest first, and shows a service account only its own entries', async () => {
    const world = await storeWorld();
    const { w, owner, pair, environment, grant, write } = world;
    const environmentId = await environment('app/production');
    const serviceAccount = await pair('laptop');
    await grant(environmentId, serviceAccount.id, { read: true, write: true });
    await write(environmentId, 'API_KEY', 1, serviceAccount.headers);
    await ok(w, 'GET', `/environments/${environmentId}/bundle`, serviceAccount.headers);

    const all = await ok<{ events: { action: string }[] }>(w, 'GET', '/activity', owner);

    expect(all.events.map(({ action }) => action)).toEqual([
      'environment.load',
      'secret.write',
      'grant.set',
      'credential.pair',
      'environment.create',
      'org.create',
      'account.create',
    ]);
    expect(all.events[1]).toMatchObject({
      actor: { kind: 'credential', id: serviceAccount.id, name: 'laptop' },
      environmentName: 'app/production',
      secretName: 'API_KEY',
      version: 1,
    });
    expect(all.events[2]).toMatchObject({
      actor: { kind: 'owner' },
      detail: 'laptop: read + write',
    });
    expect(
      (
        await ok<{ events: { action: string }[] }>(w, 'GET', '/activity', serviceAccount.headers)
      ).events.map(({ action }) => action),
    ).toEqual(['environment.load', 'secret.write']);
  });

  it('pages by the id before', async () => {
    const { w, owner, environment } = await storeWorld();
    await environment('a');
    await environment('b');

    const first = await ok<{ events: { id: string }[]; nextBefore: string | null }>(
      w,
      'GET',
      '/activity?limit=2',
      owner,
    );
    const rest = await ok<{ events: { action: string }[]; nextBefore: string | null }>(
      w,
      'GET',
      `/activity?limit=2&before=${first.nextBefore}`,
      owner,
    );

    expect(first.events).toHaveLength(2);
    expect(first.nextBefore).toBe(first.events[1]?.id);
    expect(rest.events.map(({ action }) => action)).toEqual(['org.create', 'account.create']);
    expect(rest.nextBefore).toBeNull();
  });
});

describe('the beta limits', () => {
  it('refuses one environment more than an account may hold, and makes room when one is deleted', async () => {
    const { w, owner, environment, org, orgId } = await storeWorld();
    const first = await environment('p/0');
    // Counted across the person's orgs: the fillers sit in a second one.
    const other = await org('other');
    w.sqlite.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
       INSERT INTO environment (id, org_id, name, public_key, key_version, created_by, created_at)
       SELECT 'filler-' || i, '${other}', 'p/' || i, 'k', 1, '{}', 0 FROM n`,
    );
    const another = () =>
      call(w, 'POST', '/environments', owner, {
        id: crypto.randomUUID(),
        orgId,
        name: 'p/one-more',
        publicKey: keyLike('p'),
        memberWrap: sealedLike('o'),
        memberProof: sealedLike('o'),
        creatorWrap: null,
        creatorProof: null,
      });

    expect(await another()).toMatchObject({
      status: 403,
      body: { code: 'LimitReachedError', limit: 100 },
    });
    await ok(w, 'DELETE', `/environments/${first}`, owner);
    expect(await another()).toMatchObject({ status: 201 });
  });
});
