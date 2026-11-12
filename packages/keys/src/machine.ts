/**
 * A machine key: what a laptop, an agent or a CI job acts with. One 32-byte seed, made on the
 * machine and never sent, gives both halves:
 *
 * ```
 * seed       = random 256 bits                                  → the machine's one secret
 * privateKey = HKDF(seed, info "baymutt-machine-key")           → X25519; project keys are wrapped to its public half
 * bearer     = HKDF(seed, info "baymutt-machine-bearer")        → sent with each request; the store keeps SHA-256(bearer)
 * token      = "baymutt_key_<credentialId>_<seed>[_<issuer>]"   → what the keychain or a CI secret holds
 * ```
 *
 * The store sees the public key and the bearer's hash, so it can recognise the machine and can
 * derive neither its private key nor, from the hash, its bearer.
 *
 * `issuer` is the public key of the machine that made this one. It is how a machine with no state
 * of its own (a CI job) knows whose word to take for a project's public key.
 */

import {
  fromBase64,
  hkdfBytes,
  type PrivateKey,
  privateKeyFromBytes,
  toBase64Url,
  VaultError,
} from '@internal/zk-vault';
import { randomToken } from './encoding.ts';
import { formatBearer, tokenHash } from './wire.ts';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SECRET = '[A-Za-z0-9_-]{43}';
const MACHINE_TOKEN = new RegExp(
  `^baymutt_key_(?<credentialId>${UUID})_(?<seed>${SECRET})(?:_(?<issuer>${SECRET}))?$`,
);

export type MachineKey = {
  readonly credentialId: string;
  readonly privateKey: PrivateKey;
  /** Raw, base64url without padding. */
  readonly publicKey: string;
  /** The whole `Authorization: Bearer` value. */
  readonly bearer: string;
  /** What the store keeps to recognise `bearer`. */
  readonly bearerHash: string;
  /** The public key of the machine that made this one; null for a machine the owner paired. */
  readonly issuerPublicKey: string | null;
};

/** A new machine's token. Nothing is registered: the machine has no access until someone pairs it. */
export const generateMachineToken = (issuerPublicKey?: string): string =>
  `baymutt_key_${crypto.randomUUID()}_${randomToken()}${issuerPublicKey === undefined ? '' : `_${issuerPublicKey}`}`;

export const machineKeyFromToken = async (token: string): Promise<MachineKey> => {
  const { credentialId, seed, issuer } = MACHINE_TOKEN.exec(token)?.groups ?? {};
  if (credentialId === undefined || seed === undefined) {
    throw new VaultError('malformed', 'this is not a baymutt machine key');
  }
  const seedBytes = fromBase64(seed, 'the machine key', 'base64url');
  const [privateKey, secret] = await Promise.all([
    privateKeyFromBytes(await hkdfBytes(seedBytes, 'baymutt-machine-key'), 'the machine key'),
    hkdfBytes(seedBytes, 'baymutt-machine-bearer'),
  ]);
  const bearerSecret = toBase64Url(secret);
  return {
    credentialId,
    privateKey,
    publicKey: toBase64Url(privateKey.publicKey),
    bearer: formatBearer({ credentialId, secret: bearerSecret }),
    bearerHash: await tokenHash(bearerSecret),
    issuerPublicKey: issuer ?? null,
  };
};
