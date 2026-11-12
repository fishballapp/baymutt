/**
 * Pairing: how a new service account and the owner's browser learn each other's public keys without
 * trusting the store that sits between them.
 *
 * ```
 * service account → browser   the pairing link's fragment: credentialId, name, service account public key,
 *                     bearer hash, pairingSecret. A fragment never reaches the store.
 * browser → service account   welcome = iv ‖ AES-GCM(HKDF(pairingSecret, salt = serviceAccountPub,
 *                               info "baymutt-pairing-welcome"),
 *                               [accountId, accountPub], aad = [credentialId])   → via the store
 * ```
 *
 * The store never sees `pairingSecret`, so it cannot write a welcome naming an account key of its
 * own. The pairing code on both screens covers the other direction: a link someone else made
 * carries their key.
 */

import {
  decodePublicKey,
  freshIv,
  fromBase64,
  fromUtf8,
  hkdf,
  sealed,
  unseal,
  VaultError,
} from '@internal/zk-vault';
import { tuple } from './encoding.ts';

export type Welcome = {
  readonly accountId: string;
  readonly accountPublicKey: string;
};

type Pairing = {
  /** 32 random bytes, base64url. */
  readonly pairingSecret: string;
  readonly credentialId: string;
  readonly serviceAccountPublicKey: string;
};

const welcomeKey = ({ pairingSecret, serviceAccountPublicKey }: Pairing): Promise<CryptoKey> =>
  hkdf(
    fromBase64(pairingSecret, 'the pairing secret', 'base64url'),
    'baymutt-pairing-welcome',
    { name: 'AES-GCM', length: 256 },
    ['encrypt', 'decrypt'],
    decodePublicKey(serviceAccountPublicKey, 'the service account public key'),
  );

export const sealWelcome = async (pairing: Pairing, welcome: Welcome): Promise<string> => {
  const iv = freshIv();
  return sealed(
    iv,
    new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: tuple(pairing.credentialId) },
        await welcomeKey(pairing),
        tuple(welcome.accountId, welcome.accountPublicKey),
      ),
    ),
  );
};

export const openWelcome = async (pairing: Pairing, welcome: string): Promise<Welcome> => {
  const { iv, body } = unseal(welcome, 'the welcome');
  const opened = await crypto.subtle
    .decrypt(
      { name: 'AES-GCM', iv, additionalData: tuple(pairing.credentialId) },
      await welcomeKey(pairing),
      body,
    )
    .catch(() => {
      throw new VaultError(
        'unreadable',
        'the welcome was not sealed by the browser that approved this service account',
      );
    });
  const parts: unknown = JSON.parse(fromUtf8(new Uint8Array(opened)));
  if (!Array.isArray(parts) || parts.length !== 2) {
    throw new VaultError('unreadable', 'the welcome authenticated but names no account');
  }
  const [accountId, accountPublicKey] = parts;
  if (typeof accountId !== 'string' || typeof accountPublicKey !== 'string') {
    throw new VaultError('unreadable', 'the welcome authenticated but names no account');
  }
  decodePublicKey(accountPublicKey, 'the account public key');
  return { accountId, accountPublicKey };
};
