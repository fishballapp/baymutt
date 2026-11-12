/// <reference types="node" />
// An account, its machines and a project, set up through the API as a client would.
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

/** The value the open vault would show. Any string does: the store only compares its hash. */
export const VAULT_PROOF = 'the-open-vault';

export const newAccount = async (id: string, credentialId: string) => ({
  id,
  name: 'Jason',
  publicKey: keyLike('a'),
  encryptedPrivateKey: sealedLike('private'),
  passkey: { credentialId, wrappedDek: sealedLike('wrap') },
  password: null,
  recoveryWrappedDek: sealedLike('recovery'),
  vaultProofHash: await tokenHash(VAULT_PROOF),
});

let machineCount = 0;

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

  /** A machine the owner paired. It starts with no access. */
  const pair = async (name = `machine-${++machineCount}`) => {
    const id = crypto.randomUUID();
    const secret = keyLike(String(machineCount % 10));
    await ok(
      w,
      'POST',
      '/credentials/pair',
      owner,
      {
        id,
        name,
        publicKey: keyLike('m'),
        bearerHash: await tokenHash(secret),
        endorsement: sealedLike('endorsement'),
        welcome: sealedLike('welcome'),
      },
      201,
    );
    return { id, name, headers: { authorization: `Bearer baymutt_${id}_${secret}` } };
  };

  const project = async (name: string, headers = owner) => {
    const id = crypto.randomUUID();
    await ok(
      w,
      'POST',
      '/projects',
      headers,
      {
        id,
        name,
        publicKey: keyLike('p'),
        ownerWrap: sealedLike('owner-wrap'),
        ownerProof: sealedLike('owner-proof'),
        creatorWrap: headers === owner ? null : sealedLike('creator-wrap'),
        creatorProof: headers === owner ? null : sealedLike('creator-proof'),
      },
      201,
    );
    return id;
  };

  const grant = (
    projectId: string,
    machineId: string,
    { read = false, write = false }: { readonly read?: boolean; readonly write?: boolean },
  ) =>
    ok(w, 'PUT', `/projects/${projectId}/grants/${machineId}`, owner, {
      canWrite: write,
      readWrap: read ? sealedLike('read-wrap') : null,
      keyProof: sealedLike('key-proof'),
      keyVersion: 1,
    });

  const write = (projectId: string, name: string, version: number, headers = owner) =>
    call(w, 'PUT', `/projects/${projectId}/secrets/${name}`, headers, {
      version,
      keyVersion: 1,
      ciphertext: sealedLike(`${name}-v${version}`, 96),
    });

  return { w, user, owner, locked, accountId, pair, project, grant, write };
};

export type StoreWorld = Awaited<ReturnType<typeof storeWorld>>;
