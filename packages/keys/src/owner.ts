/**
 * The owner's side: a zk-vault under baymutt's namespace, and what it keeps.
 *
 * ```
 * DEK            = random 256 bits, wrapped once per passkey (PRF), once to the password's key
 *                  if there is one, and once to the recovery key
 * accountKey     = X25519 pair; its private half is a vault record   → every project key is wrapped to its public half
 * endorsement    = vault record [credentialId → service account public key]  → written when the owner pairs a service account
 * recoveryKey    = random 256 bits, shown once, kept by the owner; wraps the DEK like a passkey
 * vaultProof     = HMAC(indexKey, ["vault-proof", accountId])        → the store keeps SHA-256(vaultProof)
 * ```
 *
 * The endorsement is why the store cannot hand the owner a key of its own to wrap a project key
 * to: a service account's public key counts only if the vault vouches for it, and only the owner writes
 * there, after comparing the pairing code.
 */

import {
  generateKeyPair,
  importPrivateKey,
  type PrivateKey,
  toBase64Url,
  type Vault,
  VaultError,
  type VaultKey,
  zkVault,
} from '@internal/zk-vault';
import { fromCrockford, toCrockford } from './encoding.ts';
import { sealWelcome } from './pairing.ts';
import {
  type ProjectKeyBinding,
  unwrapProjectKey,
  vouchedProjectKey,
  vouchForProjectKey,
  wrapProjectKey,
} from './project.ts';

const scheme = zkVault({ namespace: 'baymutt' });

export const { createVault, openVault, rewrapDek, derivePasskeyEncKey } = scheme;

/** A password is at least this long: it is the one unlock that could be guessed offline if the store's rows leaked. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * What a password and its email give, both derived in the browser (PBKDF2, 650,000 rounds, the
 * email as salt): `authValue`, which signs in and is all the store ever sees, and the key that
 * wraps the DEK, which the store never does. The email is the salt, so it cannot change.
 */
export const derivePasswordKeys = scheme.deriveAccountKeys;

export type OwnerVault = Vault;

/** The WebAuthn PRF input. Versioned, so a later scheme can ask the same passkey for a different key. */
export const PRF_INPUT_LABEL = 'baymutt-vault-prf-v1';

const ACCOUNT_KEY = { type: 'account-key', naturalKey: 'x25519' } as const;

export const createAccountKey = async (
  vault: OwnerVault,
): Promise<{ readonly publicKey: string; readonly encryptedPrivateKey: string }> => {
  const pair = await generateKeyPair();
  const { ciphertext } = await vault.encryptRecord({
    ...ACCOUNT_KEY,
    revision: 0,
    plaintext: pair.privateKey,
  });
  return { publicKey: pair.publicKey, encryptedPrivateKey: ciphertext };
};

/** Refused unless the private key the vault holds is the pair of the public key the store shows everyone else. */
export const openAccountKey = async (
  vault: OwnerVault,
  account: { readonly publicKey: string; readonly encryptedPrivateKey: string },
): Promise<PrivateKey> => {
  const { plaintext } = await vault.decryptRecord({
    ...ACCOUNT_KEY,
    ciphertext: account.encryptedPrivateKey,
  });
  const key = await importPrivateKey(plaintext, 'the account key');
  if (toBase64Url(key.publicKey) !== account.publicKey) {
    throw new VaultError(
      'unreadable',
      'the account’s public key is not the pair of its private key',
    );
  }
  return key;
};

const ENDORSEMENT_TYPE = 'credential';

export const endorseCredential = async (
  vault: OwnerVault,
  { credentialId, publicKey }: { readonly credentialId: string; readonly publicKey: string },
): Promise<string> =>
  (
    await vault.encryptRecord({
      type: ENDORSEMENT_TYPE,
      naturalKey: credentialId,
      revision: 0,
      plaintext: publicKey,
    })
  ).ciphertext;

/** The public key the owner paired `credentialId` with. Throws `unreadable` for an endorsement the vault did not write for it. */
export const endorsedPublicKey = async (
  vault: OwnerVault,
  { credentialId, endorsement }: { readonly credentialId: string; readonly endorsement: string },
): Promise<string> =>
  (
    await vault.decryptRecord({
      type: ENDORSEMENT_TYPE,
      naturalKey: credentialId,
      ciphertext: endorsement,
    })
  ).plaintext;

/**
 * What the open vault shows the store with every change: a value only the vault can compute, of
 * which the store keeps the SHA-256. It reads nothing, and it is how the store tells a session
 * whose vault is open from one that merely signed in.
 */
export const vaultProof = (vault: OwnerVault, accountId: string): Promise<string> =>
  vault.recordId('vault-proof', accountId);

const RECOVERY_KEY_BYTES = 32;

/** Thirteen groups of four, to print or to keep in a password manager. */
export const generateRecoveryKey = (): string =>
  (
    toCrockford(crypto.getRandomValues(new Uint8Array(RECOVERY_KEY_BYTES))).match(/.{1,4}/g) ?? []
  ).join('-');

/** The key that wraps the DEK for the recovery key, as a passkey's PRF output does for a passkey. */
export const recoveryVaultKey = async (recoveryKey: string): Promise<VaultKey> => ({
  encKey: await scheme.deriveRecoveryEncKey(
    fromCrockford(recoveryKey, RECOVERY_KEY_BYTES, 'the recovery key'),
  ),
});

/** The owner's unlocked account: the vault, and the account key it keeps. */
export type OwnerKeys = {
  readonly vault: OwnerVault;
  readonly accountId: string;
  readonly accountKey: PrivateKey;
};

/**
 * What approving a pairing link writes: the vault's endorsement of the service account's key, which the
 * owner just compared by its pairing code, and the welcome that tells the service account which account
 * key to trust.
 */
export const approvePairing = async (
  { vault, accountId, accountKey }: OwnerKeys,
  serviceAccount: {
    readonly id: string;
    readonly publicKey: string;
    readonly pairingSecret: string;
  },
): Promise<{ readonly endorsement: string; readonly welcome: string }> => ({
  endorsement: await endorseCredential(vault, {
    credentialId: serviceAccount.id,
    publicKey: serviceAccount.publicKey,
  }),
  welcome: await sealWelcome(
    {
      pairingSecret: serviceAccount.pairingSecret,
      credentialId: serviceAccount.id,
      serviceAccountPublicKey: serviceAccount.publicKey,
    },
    { accountId, accountPublicKey: toBase64Url(accountKey.publicKey) },
  ),
});

/** A project as the store hands it to the owner: nothing in it is trusted until `openOwnedProject` has passed. */
export type OwnedProject = ProjectKeyBinding & {
  readonly ownerWrap: string;
  readonly ownerProof: string;
  /** The service account that created it and vouched for its key; null when the owner did. */
  readonly creator: {
    readonly id: string;
    readonly publicKey: string;
    readonly endorsement: string | null;
  } | null;
};

/**
 * A project's key pair as the owner knows it: the public half its creator vouched for, where the
 * creator is the owner or a service account the vault endorsed, and the private half the wrap opens to.
 */
export const openOwnedProject = async (
  owner: OwnerKeys,
  { ownerWrap, ownerProof, creator, ...binding }: OwnedProject,
): Promise<{ readonly publicKey: string; readonly encoded: string; readonly key: PrivateKey }> => {
  const voucher = await (async () => {
    if (creator === null) return toBase64Url(owner.accountKey.publicKey);
    const endorsed =
      creator.endorsement === null
        ? null
        : await endorsedPublicKey(owner.vault, {
            credentialId: creator.id,
            endorsement: creator.endorsement,
          });
    if (endorsed === null || endorsed !== creator.publicKey) {
      throw new VaultError(
        'unreadable',
        'this project’s creator is not a service account the owner approved',
      );
    }
    return endorsed;
  })();
  const publicKey = await vouchedProjectKey({
    proof: ownerProof,
    readerKey: owner.accountKey,
    readerId: owner.accountId,
    vouchers: [voucher],
    binding,
  });
  const { key, encoded } = await unwrapProjectKey({
    wrap: ownerWrap,
    readerKey: owner.accountKey,
    readerId: owner.accountId,
    binding,
    projectPublicKey: publicKey,
  });
  return { publicKey, encoded, key };
};

/**
 * A grant for a service account: the owner's proof of the project's public key, and for a read the
 * project key wrapped to it. Refused unless the vault endorsed that service account's key, so the store
 * cannot name a key of its own as the service account's.
 */
export const grantToServiceAccount = async (
  owner: OwnerKeys,
  project: OwnedProject,
  serviceAccount: {
    readonly id: string;
    readonly publicKey: string;
    readonly endorsement: string | null;
  },
  { canRead }: { readonly canRead: boolean },
): Promise<{ readonly keyProof: string; readonly readWrap: string | null }> => {
  if (serviceAccount.endorsement === null) {
    throw new VaultError(
      'unreadable',
      'this service account was not approved by the owner, so nothing vouches for its key',
    );
  }
  const endorsed = await endorsedPublicKey(owner.vault, {
    credentialId: serviceAccount.id,
    endorsement: serviceAccount.endorsement,
  });
  if (endorsed !== serviceAccount.publicKey) {
    throw new VaultError(
      'unreadable',
      'the store shows a key for this service account that the owner did not approve',
    );
  }
  const { ownerWrap: _, ownerProof: __, creator: ___, ...binding } = project;
  const opened = await openOwnedProject(owner, project);
  const reader = { id: serviceAccount.id, publicKey: endorsed };
  return {
    keyProof: await vouchForProjectKey({
      voucherKey: owner.accountKey,
      reader,
      binding,
      projectPublicKey: opened.publicKey,
    }),
    readWrap: canRead
      ? await wrapProjectKey({
          projectPrivateKey: opened.encoded,
          readerPublicKey: endorsed,
          readerId: serviceAccount.id,
          binding,
        })
      : null,
  };
};
