/** Who may do what: CLI logins, keys, environments and the reads granted between them. */
import { describe, expect, it } from 'vitest';
import {
  call,
  indexOf,
  NAMES_KEY_WRAP,
  newAccount,
  ok,
  type StoreWorld,
  sealedOf,
  storeWorld,
  VAULT_PROOF,
  VOUCHERS,
} from '../test-store.ts';
import { keyLike, sealedLike } from '../test-support.ts';

const pairing = (id: string, namesKeyWraps: ReadonlyArray<{ orgId: string; wrap: string }>) => ({
  id,
  name: 'again',
  publicKey: keyLike('m'),
  bearerHash: keyLike('h'),
  endorsement: sealedLike('e'),
  welcome: sealedLike('w'),
  namesKeyWraps,
});

const newEnvironment = (orgId: string, name: string) => ({
  id: crypto.randomUUID(),
  orgId,
  name: indexOf(orgId, name),
  sealedName: sealedOf(name),
  publicKey: keyLike('p'),
  memberWrap: sealedLike('o'),
  memberProof: sealedLike('o'),
});

const count = ({ w }: StoreWorld, table: string, where = '1 = 1') =>
  (w.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

describe('a CLI login', () => {
  it('is recognised by its bearer once paired, lists every environment and holds none', async () => {
    const { w, pair, environment, accountId, orgId } = await storeWorld();
    const environmentId = await environment('app/production');
    const login = await pair('laptop');

    expect(await call(w, 'GET', '/me', login.headers)).toEqual({
      status: 200,
      body: {
        accountId,
        accountName: 'Test owner',
        accountPublicKey: keyLike('a'),
        credential: {
          id: login.id,
          name: 'laptop',
          parentId: null,
          welcome: sealedLike('welcome'),
          accountVoucher: null,
        },
      },
    });
    expect(await call(w, 'GET', '/environments', login.headers)).toEqual({
      status: 200,
      body: {
        environments: [
          expect.objectContaining({
            id: environmentId,
            name: indexOf(orgId, 'app/production'),
            sealedName: sealedOf('app/production'),
            canRead: false,
            canWrite: false,
            keyProof: null,
          }),
        ],
        namesKeys: [{ orgId, wrap: NAMES_KEY_WRAP }],
      },
    });
    expect(await call(w, 'GET', `/environments/${environmentId}`, login.headers)).toMatchObject({
      status: 200,
      body: { id: environmentId, canRead: false, canWrite: false },
    });
    // Pairing wrote its names key and no grant.
    expect(count({ w } as StoreWorld, 'environment_grant')).toBe(0);
  });

  it('is refused with a wrong secret, an unknown id or a malformed bearer', async () => {
    const { w, pair } = await storeWorld();
    const login = await pair();
    const [, id] = login.headers.authorization?.split('_') ?? [];

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

  it('is paired by the owner alone, once under one id', async () => {
    const { w, owner, orgId, pair, serviceAccount, environment } = await storeWorld();
    const login = await pair();
    const { headers: scoped } = await serviceAccount([await environment('app')]);
    const wraps = [{ orgId, wrap: NAMES_KEY_WRAP }];

    expect(
      await call(w, 'POST', '/credentials/pair', owner, pairing(login.id, wraps)),
    ).toMatchObject({ status: 409, body: { code: 'AlreadyExistsError' } });
    for (const headers of [login.headers, scoped]) {
      expect(
        await call(w, 'POST', '/credentials/pair', headers, pairing(crypto.randomUUID(), wraps)),
      ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
    }
  });

  it('is paired with the names key of every sealed org of the person and of no other', async () => {
    const { w, owner, orgId, org } = await storeWorld();
    const second = await org('second');
    const unsealed = await org('unsealed', { isSealed: false });
    const wrap = (id: string) => ({ orgId: id, wrap: NAMES_KEY_WRAP });

    for (const namesKeyWraps of [
      [wrap(orgId)],
      [wrap(orgId), wrap(second), wrap(unsealed)],
      [wrap(orgId), wrap(second), wrap(second)],
      [wrap(orgId), wrap(second), wrap(crypto.randomUUID())],
    ]) {
      expect(
        await call(
          w,
          'POST',
          '/credentials/pair',
          owner,
          pairing(crypto.randomUUID(), namesKeyWraps),
        ),
      ).toMatchObject({ status: 400, body: { code: 'InvalidRequestError' } });
    }
    const id = crypto.randomUUID();
    await ok(w, 'POST', '/credentials/pair', owner, pairing(id, [wrap(second), wrap(orgId)]), 201);
    expect(
      w.sqlite
        .prepare('SELECT org_id FROM names_key_wrap WHERE reader_id = ? ORDER BY org_id')
        .all(id),
    ).toEqual(
      [{ org_id: orgId }, { org_id: second }].sort((a, b) => (a.org_id < b.org_id ? -1 : 1)),
    );
  });

  it('lists names, the bin and its own activity, and is told to ask for everything that holds an environment', async () => {
    const world = await storeWorld();
    const { w, owner, orgId, pair, environment, write, secretName } = world;
    const environmentId = await environment('app/production');
    await write(environmentId, 'API_KEY', 1);
    await write(environmentId, 'OLD_KEY', 1);
    await ok(
      w,
      'DELETE',
      `/environments/${environmentId}/secrets/${secretName(environmentId, 'OLD_KEY')}`,
      owner,
    );
    const login = await pair('laptop');
    const apiKey = secretName(environmentId, 'API_KEY');

    expect(
      await call(w, 'GET', `/environments/${environmentId}/secrets`, login.headers),
    ).toMatchObject({
      status: 200,
      body: {
        secrets: expect.arrayContaining([
          expect.objectContaining({ name: apiKey, sealedName: sealedOf('API_KEY') }),
        ]),
      },
    });
    expect(
      await call(
        w,
        'GET',
        `/environments/${environmentId}/secrets/${apiKey}/versions`,
        login.headers,
      ),
    ).toMatchObject({ status: 200, body: { versions: [{ version: 1 }] } });
    expect(await call(w, 'GET', '/bin', login.headers)).toMatchObject({
      status: 200,
      body: {
        secrets: [{ name: secretName(environmentId, 'OLD_KEY'), sealedName: sealedOf('OLD_KEY') }],
      },
    });
    expect(await call(w, 'GET', '/activity', login.headers)).toEqual({
      status: 200,
      body: { events: [], nextBefore: null },
    });

    const askToRead = { status: 403, body: { code: 'NoAccessError', need: 'read' } };
    const askToWrite = { status: 403, body: { code: 'OwnerRequiredError' } };
    const bundle = await call(w, 'GET', `/environments/${environmentId}/bundle`, login.headers);
    expect(bundle).toMatchObject(askToRead);
    expect(bundle.body).toMatchObject({
      message: expect.stringContaining('reads org-user-1/<environment> in an ask'),
    });
    const written = await write(environmentId, 'API_KEY', 2, login.headers);
    expect(written).toMatchObject(askToWrite);
    expect(written.body).toMatchObject({
      message: expect.stringContaining('`secrets` step'),
    });
    expect(
      await call(w, 'DELETE', `/environments/${environmentId}/secrets/${apiKey}`, login.headers),
    ).toMatchObject(askToWrite);
    expect(
      await call(
        w,
        'POST',
        `/environments/${environmentId}/secrets/${apiKey}/rollback`,
        login.headers,
        {
          version: 1,
        },
      ),
    ).toMatchObject(askToWrite);
    expect(
      await call(w, 'POST', '/environments', login.headers, newEnvironment(orgId, 'mine')),
    ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
    expect(
      await call(w, 'POST', '/orgs', login.headers, { name: 'Mine', slug: 'mine' }),
    ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
    expect(
      await call(w, 'PUT', `/environments/${environmentId}/grants/${login.id}`, login.headers, {
        readWrap: sealedLike('self-made'),
        keyProof: sealedLike('proof'),
        keyVersion: 1,
      }),
    ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
    expect(
      await call(w, 'PUT', `/credentials/${login.id}/grants/${environmentId}`, login.headers, {
        readWrap: sealedLike('self-made'),
        keyProof: sealedLike('proof'),
      }),
    ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
    expect(count(world, 'environment_grant')).toBe(0);
  });

  it('is told the address it asks for in an org whose names are not sealed yet', async () => {
    const world = await storeWorld();
    const { w, accountId, pair } = world;
    const unsealed = await world.org('legacy', { isSealed: false });
    w.sqlite
      .prepare(
        `INSERT INTO environment (id, org_id, name, public_key, key_version, created_by, created_at)
         VALUES ('legacy-env', ?, 'app/production', ?, 1, ?, 0)`,
      )
      .run(unsealed, keyLike('p'), JSON.stringify({ kind: 'owner', id: accountId, name: 'Owner' }));
    const login = await pair();

    expect(await call(w, 'GET', '/environments/legacy-env/bundle', login.headers)).toMatchObject({
      status: 403,
      body: {
        message: expect.stringContaining('reads legacy/app/production in an ask'),
      },
    });
  });
});

describe('an environment', () => {
  it('is created by the owner alone, in a sealed org, under a name its org does not hold', async () => {
    const world = await storeWorld();
    const { w, owner, orgId, pair, serviceAccount, environment } = world;
    const login = await pair();
    const { headers: scoped } = await serviceAccount([await environment('app')]);
    const unsealed = await world.org('legacy', { isSealed: false });

    for (const headers of [login.headers, scoped]) {
      expect(
        await call(w, 'POST', '/environments', headers, newEnvironment(orgId, 'app/development')),
      ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
    }
    expect(
      await call(w, 'POST', '/environments', owner, newEnvironment(unsealed, 'app')),
    ).toMatchObject({ status: 409, body: { code: 'NamesNotSealedError' } });

    const made = newEnvironment(orgId, 'app/development');
    expect(await call(w, 'POST', '/environments', owner, made)).toMatchObject({
      status: 201,
      body: {
        id: made.id,
        name: made.name,
        sealedName: made.sealedName,
        createdBy: { kind: 'owner' },
        canRead: true,
        canWrite: true,
      },
    });
    expect(await call(w, 'GET', `/environments/${made.id}/member-wrap`, owner)).toEqual({
      status: 200,
      body: {
        memberWrap: sealedLike('o'),
        memberProof: sealedLike('o'),
        keyVersion: 1,
        creator: null,
      },
    });
    expect(
      await call(w, 'POST', '/environments', owner, newEnvironment(orgId, 'app/development')),
    ).toMatchObject({ status: 409, body: { code: 'AlreadyExistsError' } });
    expect(
      await call(w, 'POST', '/environments', owner, {
        ...newEnvironment(orgId, 'other'),
        id: made.id,
      }),
    ).toMatchObject({ status: 409, body: { code: 'AlreadyExistsError' } });
  });

  it('made by a CLI login before 0.8 still names its creator to the owner', async () => {
    const { w, owner, orgId, pair } = await storeWorld();
    const login = await pair('laptop');
    w.sqlite
      .prepare(
        `INSERT INTO environment (id, org_id, name, sealed_name, public_key, key_version, created_by, created_at)
         VALUES ('old-env', ?, ?, ?, ?, 1, ?, 0)`,
      )
      .run(
        orgId,
        indexOf(orgId, 'old'),
        sealedOf('old'),
        keyLike('p'),
        JSON.stringify({ kind: 'credential', id: login.id, name: 'laptop' }),
      );
    const accountId = (w.sqlite.prepare('SELECT id FROM store_account').get() as { id: string }).id;
    w.sqlite
      .prepare(
        `INSERT INTO member_wrap (environment_id, account_id, wrap, proof, key_version, created_at)
         VALUES ('old-env', ?, ?, ?, 1, 0)`,
      )
      .run(accountId, sealedLike('member-wrap'), sealedLike('creator-proof'));

    expect(await call(w, 'GET', '/environments/old-env/member-wrap', owner)).toMatchObject({
      status: 200,
      body: {
        creator: { id: login.id, publicKey: keyLike('m'), endorsement: sealedLike('endorsement') },
      },
    });
    expect(await call(w, 'GET', '/environments/old-env/member-wrap', login.headers)).toMatchObject({
      status: 403,
    });
  });

  it('is granted by the owner to a key to read, never to a CLI login', async () => {
    const { w, owner, pair, environment, serviceAccount, grant } = await storeWorld();
    const first = await environment('app/production');
    const second = await environment('app/staging');
    const login = await pair();
    const made = await serviceAccount([first], { maker: login });

    expect(
      await call(w, 'PUT', `/environments/${second}/grants/${login.id}`, owner, {
        readWrap: sealedLike('wrap'),
        keyProof: sealedLike('proof'),
        keyVersion: 1,
      }),
    ).toMatchObject({ status: 400, body: { code: 'InvalidRequestError' } });
    expect(
      await call(w, 'PUT', `/environments/${second}/grants/${made.id}`, made.headers, {
        readWrap: sealedLike('self-made'),
        keyProof: sealedLike('proof'),
        keyVersion: 1,
      }),
    ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
    // A grant is a read: one without a wrap is not one.
    expect(
      await call(w, 'PUT', `/environments/${second}/grants/${made.id}`, owner, {
        readWrap: null,
        keyProof: sealedLike('proof'),
        keyVersion: 1,
      }),
    ).toMatchObject({ status: 400, body: { code: 'InvalidRequestError' } });

    await grant(second, made.id);
    expect(await call(w, 'GET', `/environments/${second}`, made.headers)).toMatchObject({
      status: 200,
      body: { canRead: true, canWrite: false, keyProof: sealedLike('key-proof') },
    });
    expect(await call(w, 'GET', `/environments/${second}/grants`, owner)).toEqual({
      status: 200,
      body: {
        grants: [expect.objectContaining({ credentialId: made.id, credentialName: made.name })],
      },
    });
  });
});

describe('what a caller is shown', () => {
  it('lists every one to the owner; to a CLI login itself and what it asked for; to a service account itself', async () => {
    const world = await storeWorld();
    const { w, owner, pair, environment, serviceAccount, ask } = world;
    const environmentId = await environment('app');
    const laptop = await pair('laptop');
    const other = await pair('other');
    const ci = await serviceAccount([environmentId], { maker: laptop });
    // A key whose ask step still waits is listed with its ask, not as a key.
    await ask(laptop, [environmentId]);
    const listed = async (headers: Record<string, string>) =>
      (
        await ok<{ credentials: { id: string; endorsement: string | null }[] }>(
          w,
          'GET',
          '/credentials',
          headers,
        )
      ).credentials;

    expect((await listed(owner)).map(({ id }) => id)).toEqual([laptop.id, other.id, ci.id]);
    expect((await listed(owner))[0]?.endorsement).toBe(sealedLike('endorsement'));
    expect(await listed(laptop.headers)).toMatchObject([
      { id: laptop.id, endorsement: null },
      {
        id: ci.id,
        endorsement: null,
        grants: [{ environmentId, orgId: world.orgId, environmentSealedName: sealedOf('app') }],
      },
    ]);
    expect((await listed(ci.headers)).map(({ id }) => id)).toEqual([ci.id]);
  });

  it('keeps one account’s environments and keys from another’s', async () => {
    const one = await storeWorld();
    const environmentId = await one.environment('app/production');
    const made = await one.serviceAccount([environmentId]);
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
      ['DELETE', `/credentials/${made.id}`, undefined],
      ['DELETE', `/credentials/${made.id}/grants/${environmentId}`, undefined],
      [
        'PUT',
        `/credentials/${made.id}/grants/${environmentId}`,
        { readWrap: sealedLike('wrap'), keyProof: sealedLike('proof') },
      ],
      [
        'PUT',
        `/environments/${environmentId}/grants/${made.id}`,
        { readWrap: sealedLike('wrap'), keyProof: sealedLike('proof'), keyVersion: 1 },
      ],
    ] as const) {
      expect(await call(one.w, method, path, strangerSession, body)).toMatchObject({
        status: 404,
        body: { code: 'NotFoundError' },
      });
    }
    expect(await call(one.w, 'GET', '/environments', strangerSession)).toEqual({
      status: 200,
      body: { environments: [], namesKeys: [] },
    });
  });
});

describe('what a key reads', () => {
  /** A login, and a key it asked for that reads the first of two environments. */
  const setup = async () => {
    const world = await storeWorld();
    const first = await world.environment('app/production');
    const second = await world.environment('app/staging');
    const login = await world.pair('laptop');
    const made = await world.serviceAccount([first], {
      name: 'ci',
      maker: login,
    });
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
      body: {
        credential: { id: made.id, parentId: login.id, accountVoucher: VOUCHERS.accountKey },
      },
    });
    expect(await call(w, 'GET', '/me', login.headers)).toMatchObject({
      body: { credential: { id: login.id, accountVoucher: null } },
    });
  });

  it('changes by the owner alone, and it reads a new environment with the key it had', async () => {
    const world = await setup();
    const { w, owner, first, second, made } = world;

    expect(
      await access(world, owner, made.id, second, {
        readWrap: sealedLike('second-wrap'),
        keyProof: sealedLike('second-proof'),
      }),
    ).toMatchObject({
      status: 200,
      body: {
        id: made.id,
        // Ordered by index: a name's order is the store's to know no longer.
        grants: expect.arrayContaining([
          expect.objectContaining({ environmentId: first }),
          expect.objectContaining({ environmentId: second }),
        ]),
      },
    });
    expect(await call(w, 'GET', `/environments/${second}/bundle`, made.headers)).toMatchObject({
      status: 200,
      body: { wrap: sealedLike('second-wrap') },
    });

    await ok(w, 'DELETE', `/credentials/${made.id}/grants/${first}`, owner);
    await ok(w, 'DELETE', `/credentials/${made.id}/grants/${second}`, owner);
    expect(await call(w, 'GET', '/environments', made.headers)).toEqual({
      status: 200,
      body: { environments: [], namesKeys: [{ orgId: world.orgId, wrap: NAMES_KEY_WRAP }] },
    });

    const audit = await ok<{ events: { action: string; detail: string | null }[] }>(
      w,
      'GET',
      '/activity',
      owner,
    );
    const grants = audit.events.filter(({ action }) => action.startsWith('grant.'));
    expect(grants.slice(0, 3).map(({ action, detail }) => [action, detail])).toEqual([
      ['grant.remove', 'ci'],
      ['grant.remove', 'ci'],
      ['grant.set', 'ci: read'],
    ]);
  });

  it('cannot be changed by itself, its maker or another login, and a CLI login’s never changes', async () => {
    const world = await setup();
    const { w, owner, pair, second, login, made } = world;
    const otherLogin = await pair('desktop');
    const widen = {
      readWrap: sealedLike('forged-wrap'),
      keyProof: sealedLike('forged-proof'),
    };

    for (const headers of [made.headers, login.headers, otherLogin.headers]) {
      expect(await access(world, headers, made.id, second, widen)).toMatchObject({
        status: 403,
        body: { code: 'OwnerRequiredError' },
      });
      expect(
        await call(w, 'DELETE', `/credentials/${made.id}/grants/${second}`, headers),
      ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
    }
    expect(await access(world, owner, login.id, second, widen)).toMatchObject({
      status: 400,
      body: { code: 'InvalidRequestError' },
    });
    expect(await call(w, 'GET', `/environments/${second}`, made.headers)).toMatchObject({
      status: 404,
    });
  });

  it('needs a wrap and a proof: a grant is a read', async () => {
    const world = await setup();
    const { owner, second, made } = world;

    for (const body of [
      { keyProof: sealedLike('proof') },
      { readWrap: sealedLike('wrap') },
      { canRead: false, canWrite: true, keyProof: sealedLike('proof') },
    ]) {
      expect(await access(world, owner, made.id, second, body)).toMatchObject({
        status: 400,
        body: { code: 'InvalidRequestError' },
      });
    }
  });
});

describe('revoking', () => {
  it('stops a CLI login and every key it asked for, and takes their names keys and grants', async () => {
    const world = await storeWorld();
    const { w, owner, pair, environment, serviceAccount } = world;
    const environmentId = await environment('app');
    const login = await pair('laptop');
    const other = await pair('desktop');
    const made = await serviceAccount([environmentId], { maker: login });
    const kept = await serviceAccount([environmentId], { maker: other });

    // Another login's, or its own maker's sibling: not this login's to revoke.
    expect(await call(w, 'DELETE', `/credentials/${kept.id}`, login.headers)).toMatchObject({
      status: 403,
      body: { code: 'OwnerRequiredError' },
    });
    expect(await call(w, 'DELETE', `/credentials/${login.id}`, login.headers)).toEqual({
      status: 200,
      body: { revoked: expect.arrayContaining([login.id, made.id]) },
    });
    for (const headers of [login.headers, made.headers]) {
      expect(await call(w, 'GET', '/me', headers)).toMatchObject({ status: 401 });
    }
    expect(count(world, 'names_key_wrap', `reader_id IN ('${login.id}', '${made.id}')`)).toBe(0);
    expect(count(world, 'environment_grant', `credential_id = '${made.id}'`)).toBe(0);
    expect(count(world, 'names_key_wrap', `reader_id IN ('${other.id}', '${kept.id}')`)).toBe(2);

    expect(await call(w, 'DELETE', `/credentials/${kept.id}`, owner)).toEqual({
      status: 200,
      body: { revoked: [kept.id] },
    });
    expect(count(world, 'names_key_wrap', `reader_id = '${kept.id}'`)).toBe(0);
  });
});

describe('the audit log', () => {
  it('records who did what, newest first, and shows a key only its own entries', async () => {
    const world = await storeWorld();
    const { w, owner, orgId, environment, serviceAccount, write, secretName } = world;
    const environmentId = await environment('app/production');
    const made = await serviceAccount([environmentId], { name: 'ci' });
    await write(environmentId, 'API_KEY', 1);
    await ok(w, 'GET', `/environments/${environmentId}/bundle`, made.headers);

    const all = await ok<{ events: { action: string }[] }>(w, 'GET', '/activity', owner);

    expect(all.events.map(({ action }) => action)).toEqual([
      'environment.load',
      'secret.write',
      'step.approve',
      'grant.set',
      'ask.create',
      'credential.pair',
      'environment.create',
      'names.seal',
      'org.create',
      'account.create',
    ]);
    expect(all.events[1]).toMatchObject({
      actor: { kind: 'owner' },
      environmentName: indexOf(orgId, 'app/production'),
      environmentSealedName: sealedOf('app/production'),
      secretName: secretName(environmentId, 'API_KEY'),
      secretSealedName: sealedOf('API_KEY'),
      version: 1,
    });
    expect(all.events[3]).toMatchObject({ actor: { kind: 'owner' }, detail: 'ci: read' });
    expect(
      (await ok<{ events: { action: string }[] }>(w, 'GET', '/activity', made.headers)).events.map(
        ({ action }) => action,
      ),
    ).toEqual(['environment.load']);
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
      `/activity?limit=3&before=${first.nextBefore}`,
      owner,
    );

    expect(first.events).toHaveLength(2);
    expect(first.nextBefore).toBe(first.events[1]?.id);
    expect(rest.events.map(({ action }) => action)).toEqual([
      'names.seal',
      'org.create',
      'account.create',
    ]);
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
      call(w, 'POST', '/environments', owner, newEnvironment(orgId, 'one-more'));

    expect(await another()).toMatchObject({
      status: 403,
      body: { code: 'LimitReachedError', limit: 100 },
    });
    await ok(w, 'DELETE', `/environments/${first}`, owner);
    expect(await another()).toMatchObject({ status: 201 });
  });

  it('counts only the CLI logins and service accounts that still work', async () => {
    const { w, owner, accountId, orgId, pair } = await storeWorld();
    const fill = (count: number, extra: string) =>
      w.sqlite.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
         INSERT INTO credential (id, account_id, name, public_key, bearer_hash, created_at${extra === '' ? '' : `, ${extra}`})
         SELECT '${extra || 'live'}-' || i, '${accountId}', 'filler', 'k', 'h', 0${extra === '' ? '' : ', 1'} FROM n`,
      );
    fill(199, '');
    // Revoked and expired ones do not count.
    fill(10, 'revoked_at');
    fill(10, 'expires_at');
    const login = await pair();
    expect(
      await call(
        w,
        'POST',
        '/credentials/pair',
        owner,
        pairing(crypto.randomUUID(), [{ orgId, wrap: NAMES_KEY_WRAP }]),
      ),
    ).toMatchObject({ status: 403, body: { code: 'LimitReachedError', limit: 200 } });
    await ok(w, 'DELETE', `/credentials/${login.id}`, owner);
  });
});
