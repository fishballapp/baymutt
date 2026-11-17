/**
 * Sealing an org's names: the owner's browser seals every name the org still stores as written,
 * once, and from then on the store keeps only indexes and sealed names. Sealed for real, with
 * `@baymutt/keys`.
 */
import {
  createNamesKey,
  generateEnvironmentKey,
  importPrivateKey,
  type NamesKey,
  openName,
  openNamesKey,
  sealName,
} from '@baymutt/keys';
import { tokenHash } from '@baymutt/keys/wire';
import { describe, expect, it } from 'vitest';
import { call, NAMES_KEY_WRAP, ok, type StoreWorld, storeWorld } from '../test-store.ts';
import { keyLike, sealedLike } from '../test-support.ts';

const party = async (id: string) => {
  const pair = await generateEnvironmentKey();
  return { id, publicKey: pair.publicKey, key: await importPrivateKey(pair.privateKey, id) };
};
type Party = Awaited<ReturnType<typeof party>>;

/** Every plain name the legacy org holds somewhere: none may be left once it is sealed. */
const PLAIN_NAMES = [
  'app/production',
  'app/old',
  'app/gone',
  'API_KEY',
  'OLD_KEY',
  'STRIPE_KEY',
  'DB_URL',
  'GONE_KEY',
];

/** A bearer for a key whose row a test writes itself. */
const bearer = async (id: string) => {
  const secret = keyLike(id.slice(0, 1));
  return {
    hash: await tokenHash(secret),
    headers: { authorization: `Bearer baymutt_${id}_${secret}` },
  };
};

/**
 * What 0.7 left behind in an org: a live environment with a secret written twice, one in the bin,
 * a pending paste link, an environment in the bin, one only the activity names, a CLI login and a
 * CI service account; every name stored as written.
 */
const legacy = async (world: StoreWorld) => {
  const { w, owner, accountId, orgId: sealedOrg } = world;
  const orgId = await world.org('legacy', { isSealed: false });
  const account = await party(accountId);
  const login = await party(crypto.randomUUID());
  const loginBearer = await bearer(login.id);
  await ok(
    w,
    'POST',
    '/credentials/pair',
    owner,
    {
      id: login.id,
      name: 'laptop',
      publicKey: login.publicKey,
      bearerHash: loginBearer.hash,
      endorsement: sealedLike('endorsement'),
      welcome: sealedLike('welcome'),
      namesKeyWraps: [{ orgId: sealedOrg, wrap: NAMES_KEY_WRAP }],
    },
    201,
  );
  const deploy = await party(crypto.randomUUID());
  const deployBearer = await bearer(deploy.id);
  const by = JSON.stringify({ kind: 'owner', id: accountId, name: 'Owner' });
  const run = (statement: string, ...values: Array<string | number>) =>
    w.sqlite.prepare(statement).run(...values);
  run(
    `INSERT INTO environment (id, org_id, name, public_key, key_version, created_by, created_at)
     VALUES ('live-env', ?, 'app/production', ?, 1, ?, 0)`,
    orgId,
    keyLike('p'),
    by,
  );
  run(
    `INSERT INTO environment
       (id, org_id, name, public_key, key_version, created_by, created_at, deleted_at, purge_at)
     VALUES ('binned-env', ?, 'app/old', ?, 1, ?, 0, 1, ?)`,
    orgId,
    keyLike('p'),
    by,
    Date.now() + 1e9,
  );
  for (const [environmentId, name] of [
    ['live-env', 'API_KEY'],
    ['live-env', 'OLD_KEY'],
    ['binned-env', 'DB_URL'],
  ] as const) {
    run(
      `INSERT INTO secret
         (environment_id, name, current_version, latest_version, updated_at, updated_by, write_id)
       VALUES (?, ?, 1, 1, 0, ?, 'w')`,
      environmentId,
      name,
      by,
    );
    run(
      `INSERT INTO secret_version
         (environment_id, name, version, key_version, ciphertext, created_by, created_at)
       VALUES (?, ?, 1, 1, ?, ?, 0)`,
      environmentId,
      name,
      sealedLike(`${name}-v1`, 96),
      by,
    );
  }
  run(
    `INSERT INTO credential (id, account_id, name, public_key, bearer_hash, parent_id, created_at, org_id)
     VALUES (?, ?, 'deploy', ?, ?, ?, 0, ?)`,
    deploy.id,
    accountId,
    deploy.publicKey,
    deployBearer.hash,
    login.id,
    orgId,
  );
  run(
    `INSERT INTO environment_grant
       (environment_id, credential_id, can_write, read_wrap, key_proof, key_version, created_at)
     VALUES ('live-env', ?, 1, ?, ?, 1, 0)`,
    deploy.id,
    sealedLike('read-wrap'),
    sealedLike('key-proof'),
  );
  run(
    `INSERT INTO paste_link (id, environment_id, name, reason, hint, status, created_by, created_at)
     VALUES ('00000000-0000-4000-8000-00000000000a', 'live-env', 'STRIPE_KEY', 'to take payments', 'Stripe', 'pending', ?, ?)`,
    by,
    Date.now(),
  );
  run(
    `INSERT INTO activity_event
       (id, org_id, at, actor, action, environment_id, environment_name, secret_name)
     VALUES ('00000000000000000000000000', ?, 0, ?, 'secret.purge', 'gone-env', 'app/gone', 'GONE_KEY')`,
    orgId,
    by,
  );
  // What CI did on 0.7, by name, through the API: a write, a delete and a load, each logged.
  const path = '/environments/live-env/secrets';
  await ok(w, 'PUT', `${path}/API_KEY`, deployBearer.headers, {
    version: 2,
    keyVersion: 1,
    ciphertext: sealedLike('API_KEY-v2', 96),
  });
  await ok(w, 'DELETE', `${path}/OLD_KEY`, deployBearer.headers);
  await ok(w, 'GET', '/environments/live-env/bundle', deployBearer.headers);
  return {
    orgId,
    account,
    login: { ...login, headers: loginBearer.headers },
    deploy: { ...deploy, headers: deployBearer.headers },
  };
};

type Unsealed = {
  environments: Array<{ id: string; name: string }>;
  secrets: Array<{ environmentId: string; name: string }>;
};

/** What the owner's dashboard sends to seal the org's names, as `@baymutt/keys` makes it. */
const sealing = async ({
  orgId,
  account,
  readers,
  unsealed,
}: {
  orgId: string;
  account: Party;
  readers: ReadonlyArray<Party>;
  unsealed: Unsealed;
}) => {
  const { namesKey, wraps } = await createNamesKey({
    accountKey: account.key,
    orgId,
    readers: [account, ...readers],
  });
  return {
    namesKey,
    payload: {
      wraps,
      environments: await Promise.all(
        unsealed.environments.map(async ({ id, name }) => ({
          id,
          ...(await sealName(namesKey, { scopeId: orgId, name })),
        })),
      ),
      secrets: await Promise.all(
        unsealed.secrets.map(async ({ environmentId, name }) => ({
          environmentId,
          unsealedName: name,
          ...(await sealName(namesKey, { scopeId: environmentId, name })),
        })),
      ),
    },
  };
};

const dump = ({ w }: StoreWorld) =>
  (
    w.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  )
    .map(({ name }) => JSON.stringify(w.sqlite.prepare(`SELECT * FROM "${name}"`).all()))
    .join('\n');

const open = (namesKey: NamesKey, scopeId: string, name: string, sealedName: string | null) =>
  openName(namesKey, { scopeId, stored: { name, sealedName } });

describe('sealing an org’s names', () => {
  it('rewrites every stored name in one write, and everything keeps working on the new indexes', async () => {
    const world = await storeWorld();
    const { w, owner } = world;
    const { orgId, account, login, deploy } = await legacy(world);

    const unsealed = await ok<Unsealed>(w, 'GET', `/orgs/${orgId}/unsealed-names`, owner);
    expect(unsealed).toEqual({
      environments: [
        { id: 'binned-env', name: 'app/old' },
        { id: 'gone-env', name: 'app/gone' },
        { id: 'live-env', name: 'app/production' },
      ],
      secrets: [
        { environmentId: 'binned-env', name: 'DB_URL' },
        { environmentId: 'gone-env', name: 'GONE_KEY' },
        { environmentId: 'live-env', name: 'API_KEY' },
        { environmentId: 'live-env', name: 'OLD_KEY' },
        { environmentId: 'live-env', name: 'STRIPE_KEY' },
      ],
    });
    const { namesKey, payload } = await sealing({
      orgId,
      account,
      readers: [login, deploy],
      unsealed,
    });
    const before = dump(world);
    for (const name of PLAIN_NAMES) expect(before).toContain(name);

    expect(await call(w, 'POST', `/orgs/${orgId}/seal-names`, owner, payload)).toMatchObject({
      status: 200,
      body: { id: orgId, slug: 'legacy', areNamesSealed: true },
    });
    expect(await call(w, 'POST', `/orgs/${orgId}/seal-names`, owner, payload)).toMatchObject({
      status: 409,
      body: { code: 'AlreadyExistsError' },
    });
    expect(await ok(w, 'GET', `/orgs/${orgId}/unsealed-names`, owner)).toEqual({
      environments: [],
      secrets: [],
    });
    const leftover = dump(world);
    for (const name of PLAIN_NAMES) expect(leftover).not.toContain(name);

    // Each reader opens its own copy of the names key with the account key it trusts.
    const namesKeyOf = async (reader: Party & { headers: Record<string, string> }) => {
      const { namesKeys } = await ok<{ namesKeys: Array<{ orgId: string; wrap: string }> }>(
        w,
        'GET',
        '/environments',
        reader.headers,
      );
      const own = namesKeys.find(found => found.orgId === orgId);
      if (own === undefined) throw new Error(`no names key for ${reader.id}`);
      return openNamesKey({
        wrap: own.wrap,
        orgId,
        readerKey: reader.key,
        readerId: reader.id,
        accountPublicKey: account.publicKey,
      });
    };
    const loginKey = await namesKeyOf(login);
    const deployKey = await namesKeyOf(deploy);

    // Listing, by a CLI login.
    const { environments } = await ok<{
      environments: Array<{ id: string; orgId: string; name: string; sealedName: string | null }>;
    }>(w, 'GET', '/environments', login.headers);
    const live = environments.find(({ id }) => id === 'live-env');
    if (live === undefined) throw new Error('live-env is not listed');
    expect(await open(loginKey, orgId, live.name, live.sealedName)).toBe('app/production');

    // Loading, by the CI service account that held it before.
    const bundle = await ok<{
      environment: { name: string; sealedName: string | null };
      secrets: Array<{ name: string; sealedName: string | null; version: number }>;
    }>(w, 'GET', '/environments/live-env/bundle', deploy.headers);
    expect(
      await open(deployKey, orgId, bundle.environment.name, bundle.environment.sealedName ?? null),
    ).toBe('app/production');
    expect(bundle.secrets).toHaveLength(1);
    const [apiKey] = bundle.secrets;
    if (apiKey === undefined) throw new Error('API_KEY did not load');
    expect(await open(deployKey, 'live-env', apiKey.name, apiKey.sealedName ?? null)).toBe(
      'API_KEY',
    );
    expect(apiKey.version).toBe(2);

    // Writing and history, under the new index; the plain name is no longer one the store files.
    const path = `/environments/live-env/secrets/${apiKey.name}`;
    const third = { version: 3, keyVersion: 1, ciphertext: sealedLike('API_KEY-v3', 96) };
    expect(await call(w, 'PUT', path, deploy.headers, third)).toMatchObject({
      status: 200,
      body: { name: apiKey.name, sealedName: apiKey.sealedName, currentVersion: 3 },
    });
    expect(
      await call(w, 'PUT', '/environments/live-env/secrets/API_KEY', deploy.headers, {
        ...third,
        version: 4,
      }),
    ).toMatchObject({ status: 400, body: { code: 'InvalidRequestError' } });
    expect(await call(w, 'GET', `${path}/versions`, deploy.headers)).toMatchObject({
      body: { versions: [{ version: 3 }, { version: 2 }, { version: 1 }] },
    });

    // The bin, and a restore from it.
    const bin = await ok<{
      environments: Array<{ id: string; name: string; sealedName: string | null }>;
      secrets: Array<{ environmentId: string; name: string; sealedName: string | null }>;
    }>(w, 'GET', '/bin', owner);
    expect(
      await Promise.all(
        bin.environments.map(({ name, sealedName }) => open(namesKey, orgId, name, sealedName)),
      ),
    ).toEqual(['app/old']);
    const [oldKey] = bin.secrets;
    if (oldKey === undefined) throw new Error('OLD_KEY is not in the bin');
    expect(await open(namesKey, oldKey.environmentId, oldKey.name, oldKey.sealedName)).toBe(
      'OLD_KEY',
    );
    expect(
      await call(
        w,
        'POST',
        `/environments/live-env/secrets/${oldKey.name}/rollback`,
        deploy.headers,
        {
          version: 1,
          fromBin: true,
        },
      ),
    ).toMatchObject({ status: 200, body: { currentVersion: 1 } });

    // The paste link, answered under its own sealed name.
    const { links } = await ok<{
      links: Array<{ id: string; name: string; sealedName: string | null }>;
    }>(w, 'GET', '/paste-links', owner);
    const [link] = links;
    if (link === undefined) throw new Error('the paste link is gone');
    expect(await open(namesKey, 'live-env', link.name, link.sealedName)).toBe('STRIPE_KEY');
    expect(
      await call(w, 'POST', '/paste/00000000-0000-4000-8000-00000000000a', owner, {
        version: 1,
        keyVersion: 1,
        ciphertext: sealedLike('stripe', 96),
      }),
    ).toMatchObject({ status: 200, body: { name: link.name, sealedName: link.sealedName } });

    // The activity, before and after: every name opens.
    const { events } = await ok<{
      events: Array<{
        action: string;
        environmentId: string | null;
        environmentName: string | null;
        environmentSealedName: string | null;
        secretName: string | null;
        secretSealedName: string | null;
      }>;
    }>(w, 'GET', `/activity?orgId=${orgId}&limit=100`, owner);
    const named = events.filter(({ environmentName }) => environmentName !== null);
    expect(named.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        'secret.write',
        'secret.delete',
        'environment.load',
        'secret.purge',
        'secret.rollback',
        'paste-link.fulfil',
      ]),
    );
    const opened = await Promise.all(
      named.map(async event => [
        await open(namesKey, orgId, event.environmentName ?? '', event.environmentSealedName),
        event.secretName === null
          ? null
          : await open(
              namesKey,
              event.environmentId ?? '',
              event.secretName,
              event.secretSealedName,
            ),
      ]),
    );
    expect(opened).toEqual(
      expect.arrayContaining([
        ['app/gone', 'GONE_KEY'],
        ['app/production', 'API_KEY'],
        ['app/production', 'OLD_KEY'],
        ['app/production', 'STRIPE_KEY'],
        ['app/production', null],
      ]),
    );
    expect(events.find(({ action }) => action === 'names.seal')).toBeDefined();

    // Still none, after everything since.
    const after = dump(world);
    for (const name of PLAIN_NAMES) expect(after).not.toContain(name);
  });

  it('is the owner’s alone, and refused unless it covers exactly the names stored as written', async () => {
    const world = await storeWorld();
    const { w, owner, locked, pair } = world;
    const { orgId, account, login, deploy } = await legacy(world);
    const unsealed = await ok<Unsealed>(w, 'GET', `/orgs/${orgId}/unsealed-names`, owner);
    const { payload } = await sealing({ orgId, account, readers: [login, deploy], unsealed });
    const revoked = await pair('revoked');
    await ok(w, 'DELETE', `/credentials/${revoked.id}`, owner);

    expect(await call(w, 'GET', `/orgs/${orgId}/unsealed-names`, login.headers)).toMatchObject({
      status: 403,
      body: { code: 'OwnerRequiredError' },
    });
    expect(
      await call(w, 'POST', `/orgs/${orgId}/seal-names`, login.headers, payload),
    ).toMatchObject({
      status: 403,
      body: { code: 'OwnerRequiredError' },
    });
    expect(await call(w, 'POST', `/orgs/${orgId}/seal-names`, locked, payload)).toMatchObject({
      status: 403,
      body: { code: 'VaultLockedError' },
    });
    const [firstWrap] = payload.wraps;
    if (firstWrap === undefined) throw new Error('no wraps');
    for (const changed of [
      { ...payload, secrets: payload.secrets.slice(1) },
      { ...payload, environments: payload.environments.slice(1) },
      { ...payload, secrets: [...payload.secrets, ...payload.secrets.slice(0, 1)] },
      {
        ...payload,
        environments: [...payload.environments, { ...payload.environments[0]!, id: 'other-env' }],
      },
      { ...payload, wraps: payload.wraps.slice(1) },
      { ...payload, wraps: [...payload.wraps, { ...firstWrap, readerId: revoked.id }] },
      { ...payload, wraps: [...payload.wraps, { ...firstWrap, readerId: crypto.randomUUID() }] },
    ]) {
      expect(await call(w, 'POST', `/orgs/${orgId}/seal-names`, owner, changed)).toMatchObject({
        status: 400,
        body: { code: 'InvalidRequestError' },
      });
    }
    expect(await ok(w, 'GET', `/orgs/${orgId}/unsealed-names`, owner)).toEqual(unsealed);
    expect(
      w.sqlite.prepare('SELECT COUNT(*) AS n FROM names_key_wrap WHERE org_id = ?').get(orgId),
    ).toEqual({
      n: 0,
    });
  });
});

describe('handing an org’s names key on', () => {
  it('is the owner’s, for a sealed org, to the account, a CLI login or a live key of that org', async () => {
    const world = await storeWorld();
    const { w, owner, accountId, orgId, environment, serviceAccount, pair } = world;
    const other = await world.org('other');
    const unsealed = await world.org('legacy', { isSealed: false });
    const login = await pair('laptop');
    // A service account of this org, which the other org's names key is never handed to.
    const made = await serviceAccount([{ environmentId: await environment('app'), read: true }], {
      maker: login,
    });
    const put = (org: string, readerId: string, headers = owner) =>
      call(w, 'PUT', `/orgs/${org}/names-key-wraps/${readerId}`, headers, { wrap: NAMES_KEY_WRAP });

    expect(await put(other, made.id, login.headers)).toMatchObject({
      status: 403,
      body: { code: 'OwnerRequiredError' },
    });
    expect(await put(unsealed, made.id)).toMatchObject({
      status: 409,
      body: { code: 'NamesNotSealedError' },
    });
    expect(await put(other, crypto.randomUUID())).toMatchObject({
      status: 404,
      body: { code: 'NotFoundError' },
    });
    expect(await put(other, made.id)).toMatchObject({
      status: 400,
      body: { code: 'InvalidRequestError' },
    });
    expect(await put(orgId, made.id)).toEqual({ status: 200, body: { readerId: made.id } });
    expect(await put(other, login.id)).toEqual({ status: 200, body: { readerId: login.id } });
    expect(await put(other, accountId)).toMatchObject({ status: 200 });
    expect(await call(w, 'GET', '/environments', made.headers)).toMatchObject({
      body: { namesKeys: [{ orgId, wrap: NAMES_KEY_WRAP }] },
    });
  });
});
