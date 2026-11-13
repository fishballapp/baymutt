/**
 * An environment's key pair, the wraps that hand its private half to a reader, and the values sealed to
 * its public half.
 *
 * ```
 * environmentKey = X25519 pair, one per environment and key version
 * wrap       = box(readerPub,  environmentPriv, info "baymutt-project-key",
 *                  aad = [accountId, environmentId, keyVersion, readerId])       → stored
 * value      = box(environmentPub, plaintext,   info "baymutt-secret-value",
 *                  aad = [accountId, environmentId, keyVersion, name, version])  → stored
 * proof      = vouched(voucherPriv → readerPub, environmentPub, info "baymutt-project-key-proof",
 *                      aad = [accountId, environmentId, keyVersion, readerId])   → stored
 *
 * Sealing a value needs only the public key, so a writer holds no secret and can read nothing. A
 * wrap is bound to its reader and a value to its slot, so the store cannot answer one for another.
 * A box does not say who sealed it: the store, or anyone, can put a value of its own in a slot,
 * and can seal a key pair of its own making into a wrap.
 *
 * So **which public key is the environment's comes from the proof and from nothing else.** Only a
 * party the reader already trusts (the owner's account, the service account that made this one, itself)
 * can vouch for one, and a client seals to, and unwraps against, the key that was vouched for.
 */

import {
  decodePublicKey,
  fromBase64,
  fromUtf8,
  generateKeyPair,
  importPrivateKey,
  openBox,
  openVouched,
  type PrivateKey,
  sealBox,
  sealVouched,
  toBase64,
  toBase64Url,
  utf8,
  VaultError,
} from '@internal/zk-vault';
import { sha256Base64Url, tuple } from './encoding.ts';

export type EnvironmentKeyBinding = {
  readonly accountId: string;
  readonly environmentId: string;
  readonly keyVersion: number;
};

export type ValueSlot = EnvironmentKeyBinding & {
  readonly name: string;
  readonly version: number;
};

// Every stored key and value was sealed under these while an environment was called a project: the
// labels keep that word, since changing one makes them unreadable (the tests pin them).
const WRAP_INFO = 'baymutt-project-key';
const PROOF_INFO = 'baymutt-project-key-proof';
const VALUE_INFO = 'baymutt-secret-value';

const wrapAad = (
  { accountId, environmentId, keyVersion }: EnvironmentKeyBinding,
  readerId: string,
) => tuple(accountId, environmentId, String(keyVersion), readerId);

const valueAad = ({ accountId, environmentId, keyVersion, name, version }: ValueSlot) =>
  tuple(accountId, environmentId, String(keyVersion), name, String(version));

export const generateEnvironmentKey = generateKeyPair;

/** SHA-256 of a public key: what a paste link carries in its fragment and a service account pins, to refuse a key the store swapped. */
export const publicKeyFingerprint = (publicKey: string): Promise<string> =>
  sha256Base64Url(decodePublicKey(publicKey, 'the public key'));

export const wrapEnvironmentKey = async ({
  environmentPrivateKey,
  readerPublicKey,
  readerId,
  binding,
}: {
  /** PKCS #8, base64url. */
  readonly environmentPrivateKey: string;
  readonly readerPublicKey: string;
  /** A credential id, or the account id for the owner's own wrap. */
  readonly readerId: string;
  readonly binding: EnvironmentKeyBinding;
}): Promise<string> =>
  toBase64(
    await sealBox({
      recipient: decodePublicKey(readerPublicKey, 'the reader public key'),
      info: WRAP_INFO,
      aad: wrapAad(binding, readerId),
      plaintext: utf8(environmentPrivateKey),
    }),
  );

/**
 * The environment's private key, refused unless its public half is the one the caller expects: the
 * wrap proves who may open it, not what was put in it.
 */
export const unwrapEnvironmentKey = async ({
  wrap,
  readerKey,
  readerId,
  binding,
  environmentPublicKey,
}: {
  readonly wrap: string;
  readonly readerKey: PrivateKey;
  readonly readerId: string;
  readonly binding: EnvironmentKeyBinding;
  readonly environmentPublicKey: string;
}): Promise<{ readonly key: PrivateKey; readonly encoded: string }> => {
  const encoded = fromUtf8(
    await openBox({
      privateKey: readerKey,
      info: WRAP_INFO,
      aad: wrapAad(binding, readerId),
      box: fromBase64(wrap, 'the environment key wrap'),
      what: 'the environment key wrap',
    }),
  );
  const key = await importPrivateKey(encoded, 'the environment key');
  if (toBase64Url(key.publicKey) !== environmentPublicKey) {
    throw new VaultError('unreadable', 'the wrap opened to a key that is not this environment’s');
  }
  return { key, encoded };
};

type Reader = { readonly id: string; readonly publicKey: string };

/** `voucherKey`'s holder tells `reader` which public key is the environment's. */
export const vouchForEnvironmentKey = async ({
  voucherKey,
  reader,
  binding,
  environmentPublicKey,
}: {
  readonly voucherKey: PrivateKey;
  readonly reader: Reader;
  readonly binding: EnvironmentKeyBinding;
  readonly environmentPublicKey: string;
}): Promise<string> =>
  toBase64(
    await sealVouched({
      sender: voucherKey,
      recipient: decodePublicKey(reader.publicKey, 'the reader public key'),
      info: PROOF_INFO,
      aad: wrapAad(binding, reader.id),
      plaintext: decodePublicKey(environmentPublicKey, 'the environment public key'),
    }),
  );

/**
 * The environment's public key, as one of `vouchers` told this reader. Throws `unreadable` when none
 * of them made the proof: the store cannot make one, and neither can a stranger.
 */
export const vouchedEnvironmentKey = async ({
  proof,
  readerKey,
  readerId,
  vouchers,
  binding,
}: {
  readonly proof: string;
  readonly readerKey: PrivateKey;
  readonly readerId: string;
  /** The public keys this reader trusts to say which key is the environment's. */
  readonly vouchers: ReadonlyArray<string>;
  readonly binding: EnvironmentKeyBinding;
}): Promise<string> => {
  const box = fromBase64(proof, 'the environment key proof');
  for (const voucher of vouchers) {
    const opened = await openVouched({
      recipient: readerKey,
      sender: decodePublicKey(voucher, 'a voucher public key'),
      info: PROOF_INFO,
      aad: wrapAad(binding, readerId),
      box,
      what: 'the environment key proof',
    }).catch(() => null);
    if (opened !== null) return toBase64Url(opened);
  }
  throw new VaultError(
    'unreadable',
    'nobody this service account trusts vouched for this environment’s public key',
  );
};

/**
 * A new environment's key pair. Each first reader (the owner's account always, and the service account that
 * creates it) gets the private half wrapped to it and the creator's proof of the public half. The
 * private key never leaves this call unwrapped.
 */
export const createEnvironmentKey = async ({
  voucherKey,
  binding,
  readers,
}: {
  /** The creator's own key: what the readers will trust the proof from. */
  readonly voucherKey: PrivateKey;
  readonly binding: EnvironmentKeyBinding;
  readonly readers: ReadonlyArray<Reader>;
}): Promise<{
  readonly publicKey: string;
  readonly grants: ReadonlyArray<{ readonly wrap: string; readonly proof: string }>;
}> => {
  const pair = await generateKeyPair();
  return {
    publicKey: pair.publicKey,
    grants: await Promise.all(
      readers.map(async reader => ({
        wrap: await wrapEnvironmentKey({
          environmentPrivateKey: pair.privateKey,
          readerPublicKey: reader.publicKey,
          readerId: reader.id,
          binding,
        }),
        proof: await vouchForEnvironmentKey({
          voucherKey,
          reader,
          binding,
          environmentPublicKey: pair.publicKey,
        }),
      })),
    ),
  };
};

export const sealValue = async ({
  environmentPublicKey,
  slot,
  value,
}: {
  readonly environmentPublicKey: string;
  readonly slot: ValueSlot;
  readonly value: string;
}): Promise<string> =>
  toBase64(
    await sealBox({
      recipient: decodePublicKey(environmentPublicKey, 'the environment public key'),
      info: VALUE_INFO,
      aad: valueAad(slot),
      plaintext: utf8(value),
    }),
  );

export const openValue = async ({
  environmentKey,
  slot,
  ciphertext,
}: {
  readonly environmentKey: PrivateKey;
  readonly slot: ValueSlot;
  readonly ciphertext: string;
}): Promise<string> =>
  fromUtf8(
    await openBox({
      privateKey: environmentKey,
      info: VALUE_INFO,
      aad: valueAad(slot),
      box: fromBase64(ciphertext, `${slot.name} version ${slot.version}`),
      what: `${slot.name} version ${slot.version}`,
    }),
  );
