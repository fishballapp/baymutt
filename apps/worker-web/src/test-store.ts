/// <reference types="node" />
// An account, its org, its credentials and an environment, set up through the API as a client would.
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

/** What a CLI login writes for a service account it makes. The store keeps them as written. */
export const VOUCHERS = {
  keyToOwner: sealedLike('key-to-owner', 64),
  keyToMaker: sealedLike('key-to-maker', 64),
  accountKey: sealedLike('account-key', 64),
};

/** The value the open vault would show. Any string does: the store only compares its hash. */
export const VAULT_PROOF = 'the-open-vault';

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

let serviceAccountCount = 0;

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
  /** An org of this person's, with them as its owner. */
  const org = async (slug: string, headers = owner) =>
    (await ok<{ id: string }>(w, 'POST', '/orgs', headers, { name: `Org ${slug}`, slug }, 201)).id;
  const orgId = await org(`org-${userId}`);

  /**
   * A CLI login the owner approved. `environments` are the ones the owner's browser wrapped to it in
   * the approval; with none given it holds nothing yet.
   */
  const pair = async (
    name = `service-account-${++serviceAccountCount}`,
    {
      environments = [],
      ...about
    }: {
      readonly environments?: ReadonlyArray<string>;
      readonly description?: string;
      readonly expiresAt?: number;
    } = {},
  ) => {
    const id = crypto.randomUUID();
    const secret = keyLike(String(serviceAccountCount % 10));
    await ok(
      w,
      'POST',
      '/credentials/pair',
      owner,
      {
        ...about,
        id,
        name,
        publicKey: keyLike('m'),
        bearerHash: await tokenHash(secret),
        endorsement: sealedLike('endorsement'),
        welcome: sealedLike('welcome'),
        grants: environments.map(environmentId => ({
          environmentId,
          readWrap: sealedLike('login-wrap'),
          keyProof: sealedLike('key-proof'),
          keyVersion: 1,
        })),
      },
      201,
    );
    return { id, name, headers: { authorization: `Bearer baymutt_${id}_${secret}` } };
  };

  /** An environment; the owner wraps it to each of `logins` in the same request, as the dashboard does. */
  const environment = async (
    name: string,
    headers = owner,
    logins: ReadonlyArray<string> = [],
    inOrg = orgId,
  ) => {
    const id = crypto.randomUUID();
    await ok(
      w,
      'POST',
      '/environments',
      headers,
      {
        id,
        orgId: inOrg,
        name,
        publicKey: keyLike('p'),
        memberWrap: sealedLike('member-wrap'),
        memberProof: sealedLike('member-proof'),
        creatorWrap: headers === owner ? null : sealedLike('creator-wrap'),
        creatorProof: headers === owner ? null : sealedLike('creator-proof'),
        ...(logins.length === 0
          ? {}
          : {
              loginGrants: logins.map(credentialId => ({
                credentialId,
                readWrap: sealedLike('login-wrap'),
                keyProof: sealedLike('key-proof'),
              })),
            }),
      },
      201,
    );
    return id;
  };

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

  const write = (environmentId: string, name: string, version: number, headers = owner) =>
    call(w, 'PUT', `/environments/${environmentId}/secrets/${name}`, headers, {
      version,
      keyVersion: 1,
      ciphertext: sealedLike(`${name}-v${version}`, 96),
    });

  return { w, user, owner, locked, accountId, org, orgId, pair, environment, grant, write };
};

export type StoreWorld = Awaited<ReturnType<typeof storeWorld>>;
