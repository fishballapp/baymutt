/**
 * A project's key pair, the wraps that hand its private half to a reader, and the values sealed to
 * its public half.
 *
 * ```
 * projectKey = X25519 pair, one per project and key version
 * wrap       = box(readerPub,  projectPriv, info "baymutt-project-key",
 *                  aad = [accountId, projectId, keyVersion, readerId])       → stored
 * value      = box(projectPub, plaintext,   info "baymutt-secret-value",
 *                  aad = [accountId, projectId, keyVersion, name, version])  → stored
 * proof      = vouched(voucherPriv → readerPub, projectPub, info "baymutt-project-key-proof",
 *                      aad = [accountId, projectId, keyVersion, readerId])   → stored
 *
 * Sealing a value needs only the public key, so a writer holds no secret and can read nothing. A
 * wrap is bound to its reader and a value to its slot, so the store cannot answer one for another.
 * A box does not say who sealed it: the store, or anyone, can put a value of its own in a slot,
 * and can seal a key pair of its own making into a wrap.
 *
 * So **which public key is the project's comes from the proof and from nothing else.** Only a
 * party the reader already trusts (the owner's account, the machine that made this one, itself)
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

export type ProjectKeyBinding = {
  readonly accountId: string;
  readonly projectId: string;
  readonly keyVersion: number;
};

export type ValueSlot = ProjectKeyBinding & {
  readonly name: string;
  readonly version: number;
};

const WRAP_INFO = 'baymutt-project-key';
const PROOF_INFO = 'baymutt-project-key-proof';
const VALUE_INFO = 'baymutt-secret-value';

const wrapAad = ({ accountId, projectId, keyVersion }: ProjectKeyBinding, readerId: string) =>
  tuple(accountId, projectId, String(keyVersion), readerId);

const valueAad = ({ accountId, projectId, keyVersion, name, version }: ValueSlot) =>
  tuple(accountId, projectId, String(keyVersion), name, String(version));

export const generateProjectKey = generateKeyPair;

/** SHA-256 of a public key: what a paste link carries in its fragment and a machine pins, to refuse a key the store swapped. */
export const publicKeyFingerprint = (publicKey: string): Promise<string> =>
  sha256Base64Url(decodePublicKey(publicKey, 'the public key'));

export const wrapProjectKey = async ({
  projectPrivateKey,
  readerPublicKey,
  readerId,
  binding,
}: {
  /** PKCS #8, base64url. */
  readonly projectPrivateKey: string;
  readonly readerPublicKey: string;
  /** A credential id, or the account id for the owner's own wrap. */
  readonly readerId: string;
  readonly binding: ProjectKeyBinding;
}): Promise<string> =>
  toBase64(
    await sealBox({
      recipient: decodePublicKey(readerPublicKey, 'the reader public key'),
      info: WRAP_INFO,
      aad: wrapAad(binding, readerId),
      plaintext: utf8(projectPrivateKey),
    }),
  );

/**
 * The project's private key, refused unless its public half is the one the caller expects: the
 * wrap proves who may open it, not what was put in it.
 */
export const unwrapProjectKey = async ({
  wrap,
  readerKey,
  readerId,
  binding,
  projectPublicKey,
}: {
  readonly wrap: string;
  readonly readerKey: PrivateKey;
  readonly readerId: string;
  readonly binding: ProjectKeyBinding;
  readonly projectPublicKey: string;
}): Promise<{ readonly key: PrivateKey; readonly encoded: string }> => {
  const encoded = fromUtf8(
    await openBox({
      privateKey: readerKey,
      info: WRAP_INFO,
      aad: wrapAad(binding, readerId),
      box: fromBase64(wrap, 'the project key wrap'),
      what: 'the project key wrap',
    }),
  );
  const key = await importPrivateKey(encoded, 'the project key');
  if (toBase64Url(key.publicKey) !== projectPublicKey) {
    throw new VaultError('unreadable', 'the wrap opened to a key that is not this project’s');
  }
  return { key, encoded };
};

type Reader = { readonly id: string; readonly publicKey: string };

/** `voucherKey`'s holder tells `reader` which public key is the project's. */
export const vouchForProjectKey = async ({
  voucherKey,
  reader,
  binding,
  projectPublicKey,
}: {
  readonly voucherKey: PrivateKey;
  readonly reader: Reader;
  readonly binding: ProjectKeyBinding;
  readonly projectPublicKey: string;
}): Promise<string> =>
  toBase64(
    await sealVouched({
      sender: voucherKey,
      recipient: decodePublicKey(reader.publicKey, 'the reader public key'),
      info: PROOF_INFO,
      aad: wrapAad(binding, reader.id),
      plaintext: decodePublicKey(projectPublicKey, 'the project public key'),
    }),
  );

/**
 * The project's public key, as one of `vouchers` told this reader. Throws `unreadable` when none
 * of them made the proof: the store cannot make one, and neither can a stranger.
 */
export const vouchedProjectKey = async ({
  proof,
  readerKey,
  readerId,
  vouchers,
  binding,
}: {
  readonly proof: string;
  readonly readerKey: PrivateKey;
  readonly readerId: string;
  /** The public keys this reader trusts to say which key is the project's. */
  readonly vouchers: ReadonlyArray<string>;
  readonly binding: ProjectKeyBinding;
}): Promise<string> => {
  const box = fromBase64(proof, 'the project key proof');
  for (const voucher of vouchers) {
    const opened = await openVouched({
      recipient: readerKey,
      sender: decodePublicKey(voucher, 'a voucher public key'),
      info: PROOF_INFO,
      aad: wrapAad(binding, readerId),
      box,
      what: 'the project key proof',
    }).catch(() => null);
    if (opened !== null) return toBase64Url(opened);
  }
  throw new VaultError(
    'unreadable',
    'nobody this machine trusts vouched for this project’s public key',
  );
};

/**
 * A new project's key pair. Each first reader (the owner's account always, and the machine that
 * creates it) gets the private half wrapped to it and the creator's proof of the public half. The
 * private key never leaves this call unwrapped.
 */
export const createProjectKey = async ({
  voucherKey,
  binding,
  readers,
}: {
  /** The creator's own key: what the readers will trust the proof from. */
  readonly voucherKey: PrivateKey;
  readonly binding: ProjectKeyBinding;
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
        wrap: await wrapProjectKey({
          projectPrivateKey: pair.privateKey,
          readerPublicKey: reader.publicKey,
          readerId: reader.id,
          binding,
        }),
        proof: await vouchForProjectKey({
          voucherKey,
          reader,
          binding,
          projectPublicKey: pair.publicKey,
        }),
      })),
    ),
  };
};

export const sealValue = async ({
  projectPublicKey,
  slot,
  value,
}: {
  readonly projectPublicKey: string;
  readonly slot: ValueSlot;
  readonly value: string;
}): Promise<string> =>
  toBase64(
    await sealBox({
      recipient: decodePublicKey(projectPublicKey, 'the project public key'),
      info: VALUE_INFO,
      aad: valueAad(slot),
      plaintext: utf8(value),
    }),
  );

export const openValue = async ({
  projectKey,
  slot,
  ciphertext,
}: {
  readonly projectKey: PrivateKey;
  readonly slot: ValueSlot;
  readonly ciphertext: string;
}): Promise<string> =>
  fromUtf8(
    await openBox({
      privateKey: projectKey,
      info: VALUE_INFO,
      aad: valueAad(slot),
      box: fromBase64(ciphertext, `${slot.name} version ${slot.version}`),
      what: `${slot.name} version ${slot.version}`,
    }),
  );
