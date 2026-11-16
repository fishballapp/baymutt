/// <reference types="node" />
// An account, its org, its credentials and an environment, set up through the API as a client would.
import { createHash } from 'node:crypto';
import { tokenHash } from '@baymutt/keys/wire';
import { json } from '@internal/effect-worker/testing';
import { expect } from 'vitest';
import {
  type Headers_,
  keyLike,
  sealedLike,
  send,
  type TestWorld,
  testWorld,
} from './test-support.ts';

export const call = async (
  w: TestWorld,
  method: string,
  path: string,
  headers: Headers_,
  body?: unknown,
) => json(await w.api(`/api/v1${path}`, send(method, body, headers)));

/** Fails with the response when it is not `status`, so a broken setup says why. */
export const ok = async <Body = Record<string, unknown>>(
  w: TestWorld,
  method: string,
  path: string,
  headers: Headers_,
  body?: unknown,
  status = 200,
): Promise<Body> => {
  const answer = await call(w, method, path, headers, body);
  expect(answer).toMatchObject({ status });
  return answer.body as Body;
};

/** What a CLI login writes for a key it asks for. The store keeps them as written. */
export const VOUCHERS = {
  keyToOwner: sealedLike('key-to-owner', 64),
  keyToMaker: sealedLike('key-to-maker', 64),
  accountKey: sealedLike('account-key', 64),
};

/** The value the open vault would show. Any string does: the store only compares its hash. */
export const VAULT_PROOF = 'the-open-vault';

/** A names key wrapped to one reader. The store checks its shape only. */
export const NAMES_KEY_WRAP = sealedLike('names-key', 80);

/**
 * What a client files a name under in a sealed org: a stand-in for the HMAC with the same shape,
 * one spelling per scope and name. The tests that seal names for real use `@baymutt/keys`.
 */
export const indexOf = (scopeId: string, name: string): string =>
  createHash('sha256').update(`${scopeId}\u0000${name}`).digest('base64url');

/** A sealed name's stand-in: the store checks its shape only. */
export const sealedOf = (name: string): string => Buffer.from(`sealed:${name}`).toString('base64');

export const newAccount = async (id: string, credentialId: string) => ({
  id,
  name: 'Test owner',
  publicKey: keyLike('a'),
  encryptedPrivateKey: sealedLike('private'),
  passkey: { credentialId, wrappedDek: sealedLike('wrap') },
  password: null,
  recoveryWrappedDek: sealedLike('recovery'),
  vaultProofHash: await tokenHash(VAULT_PROOF),
});

let keyCount = 0;

/** A new key's id, public key, bearer hash, and the header it is sent with once it works. */
const newKey = async (name: string) => {
  const id = crypto.randomUUID();
  const secret = keyLike(String(++keyCount % 10));
  return {
    id,
    name,
    publicKey: keyLike('m'),
    bearerHash: await tokenHash(secret),
    headers: { authorization: `Bearer baymutt_${id}_${secret}` },
  };
};

export type Credential = { readonly id: string; readonly headers: Headers_ };

/** What a request asks for on one environment. */
export type Ask = {
  readonly environmentId: string;
  readonly read?: boolean;
  readonly write?: boolean;
};

export const storeWorld = async (userId = 'user-1') => {
  const w = testWorld();
  const user = w.user(userId);
  /** Signed in, vault locked: what a magic link gives. */
  const locked = w.signIn(user.id);
  /** Signed in with the vault open: what the dashboard sends once a passkey unlocked it. */
  const owner: Headers_ = { ...locked, 'x-baymutt-vault-proof': VAULT_PROOF };
  const accountId = crypto.randomUUID();
  await ok(
    w,
    'POST',
    '/account',
    locked,
    await newAccount(accountId, user.first.credentialId),
    201,
  );

  /** The live credentials of the account: who sealing an org wraps its names key to. */
  const liveCredentials = () =>
    (
      w.sqlite
        .prepare('SELECT id FROM credential WHERE account_id = ? AND revoked_at IS NULL')
        .all(accountId) as Array<{ id: string }>
    ).map(({ id }) => id);

  /** Seals an org's names as the owner's dashboard does, with stand-in indexes and wraps. */
  const seal = async (orgId: string) => {
    const unsealed = await ok<{
      environments: Array<{ id: string; name: string }>;
      secrets: Array<{ environmentId: string; name: string }>;
    }>(w, 'GET', `/orgs/${orgId}/unsealed-names`, owner);
    return ok(w, 'POST', `/orgs/${orgId}/seal-names`, owner, {
      wraps: [accountId, ...liveCredentials()].map(readerId => ({
        readerId,
        wrap: NAMES_KEY_WRAP,
      })),
      environments: unsealed.environments.map(({ id, name }) => ({
        id,
        name: indexOf(orgId, name),
        sealedName: sealedOf(name),
      })),
      secrets: unsealed.secrets.map(({ environmentId, name }) => ({
        environmentId,
        unsealedName: name,
        name: indexOf(environmentId, name),
        sealedName: sealedOf(name),
      })),
    });
  };

  /** An org of this person's, with them as its owner; sealed, as the dashboard does at once, unless asked not to. */
  const org = async (slug: string, { headers = owner, isSealed = true } = {}) => {
    const { id } = await ok<{ id: string }>(
      w,
      'POST',
      '/orgs',
      headers,
      { name: `Org ${slug}`, slug },
      201,
    );
    if (isSealed) await seal(id);
    return id;
  };
  const orgId = await org(`org-${userId}`);

  /** The orgs of the account whose names are sealed: what a CLI login is approved with. */
  const sealedOrgs = () =>
    (
      w.sqlite
        .prepare('SELECT DISTINCT org_id AS id FROM names_key_wrap WHERE reader_id = ?')
        .all(accountId) as Array<{ id: string }>
    ).map(({ id }) => id);

  /** A CLI login the owner approved, with the names key of every sealed org. */
  const pair = async (
    name = `login-${keyCount + 1}`,
    about: { readonly description?: string; readonly expiresAt?: number } = {},
  ): Promise<Credential & { readonly name: string }> => {
    const { headers, ...key } = await newKey(name);
    await ok(
      w,
      'POST',
      '/credentials/pair',
      owner,
      {
        ...about,
        ...key,
        endorsement: sealedLike('endorsement'),
        welcome: sealedLike('welcome'),
        namesKeyWraps: sealedOrgs().map(id => ({ orgId: id, wrap: NAMES_KEY_WRAP })),
      },
      201,
    );
    return { id: key.id, name, headers };
  };

  /** An environment the owner creates in the dashboard, filed under its index. */
  const environment = async (name: string, inOrg = orgId) => {
    const id = crypto.randomUUID();
    await ok(
      w,
      'POST',
      '/environments',
      owner,
      {
        id,
        orgId: inOrg,
        name: indexOf(inOrg, name),
        sealedName: sealedOf(name),
        publicKey: keyLike('p'),
        memberWrap: sealedLike('member-wrap'),
        memberProof: sealedLike('member-proof'),
      },
      201,
    );
    return id;
  };

  /** A request a CLI login makes for `asks`: its key holds nothing until the owner approves. */
  const ask = async (
    login: Credential,
    asks: ReadonlyArray<Ask>,
    {
      name = `key-${keyCount + 1}`,
      reason = 'to run the tests',
      command = null,
      lifetime = null,
    }: {
      readonly name?: string;
      readonly reason?: string;
      readonly command?: string | null;
      readonly lifetime?: number | null;
    } = {},
  ) => {
    const { headers, ...key } = await newKey(name);
    const answer = await call(w, 'POST', '/requests', login.headers, {
      ...key,
      vouchers: VOUCHERS,
      reason,
      command,
      lifetime,
      items: asks.map(({ environmentId, read = false, write = false }) => ({
        environmentId,
        canRead: read,
        canWrite: write,
      })),
    });
    return { id: key.id, name, headers, answer };
  };

  type RequestItem = {
    environmentId: string;
    orgId: string;
    canRead: boolean;
  };

  /** What the owner's dashboard sends to approve a request exactly as it was asked. */
  const approval = async (requestId: string, expiresAt: number | null = null) => {
    const { items } = await ok<{ items: RequestItem[] }>(w, 'GET', `/requests/${requestId}`, owner);
    return {
      expiresAt,
      grants: items.map(item => ({
        environmentId: item.environmentId,
        readWrap: item.canRead ? sealedLike('read-wrap') : null,
        keyProof: sealedLike('key-proof'),
        keyVersion: 1,
      })),
      namesKeyWraps: [...new Set(items.map(item => item.orgId))].map(id => ({
        orgId: id,
        wrap: NAMES_KEY_WRAP,
      })),
    };
  };

  const approve = async (requestId: string, expiresAt: number | null = null) =>
    call(w, 'POST', `/requests/${requestId}/approve`, owner, await approval(requestId, expiresAt));

  /** A service account: a request a CLI login made and the owner approved. */
  const serviceAccount = async (
    asks: ReadonlyArray<Ask>,
    {
      name,
      maker,
      expiresAt = null,
    }: {
      readonly name?: string;
      readonly maker?: Credential;
      readonly expiresAt?: number | null;
    } = {},
  ) => {
    const login = maker ?? (await pair());
    const request = await ask(login, asks, name === undefined ? {} : { name });
    expect(request.answer).toMatchObject({ status: 201 });
    expect(await approve(request.id, expiresAt)).toMatchObject({ status: 200 });
    return { id: request.id, name: request.name, headers: request.headers, maker: login };
  };

  /** The owner grants an existing service account access, from the dashboard. */
  const grant = (
    environmentId: string,
    serviceAccountId: string,
    { read = false, write = false }: { readonly read?: boolean; readonly write?: boolean },
  ) =>
    ok(w, 'PUT', `/environments/${environmentId}/grants/${serviceAccountId}`, owner, {
      canWrite: write,
      readWrap: read ? sealedLike('read-wrap') : null,
      keyProof: sealedLike('key-proof'),
      keyVersion: 1,
    });

  /** A secret's stored name in an environment of a sealed org. */
  const secretName = (environmentId: string, name: string) => indexOf(environmentId, name);

  /** A write of `name` as a client in a sealed org sends it: under its index, with its sealed name. */
  const write = (environmentId: string, name: string, version: number, headers = owner) =>
    call(
      w,
      'PUT',
      `/environments/${environmentId}/secrets/${secretName(environmentId, name)}`,
      headers,
      {
        version,
        keyVersion: 1,
        ciphertext: sealedLike(`${name}-v${version}`, 96),
        sealedName: sealedOf(name),
      },
    );

  return {
    w,
    user,
    owner,
    locked,
    accountId,
    org,
    orgId,
    seal,
    pair,
    environment,
    ask,
    approval,
    approve,
    serviceAccount,
    grant,
    secretName,
    write,
  };
};

export type StoreWorld = Awaited<ReturnType<typeof storeWorld>>;
