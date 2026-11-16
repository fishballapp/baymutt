/**
 * Names the store cannot read: an environment's and a secret's. Each org has one names key, held
 * by everyone who may list its names.
 *
 * ```
 * namesKey   = random 256 bits, one per org
 * sealedName = iv ‖ AES-GCM(HKDF(namesKey, "baymutt-name-seal"), name, aad = [scopeId])     → stored
 * index      = HMAC(HKDF(namesKey, "baymutt-name-index"), [scopeId, name]), base64url      → stored
 * wrap       = vouched(accountPriv → readerPub, namesKey, info "baymutt-names-key-wrap",
 *                      aad = [orgId, readerId])                                             → stored
 * ```
 *
 * `scopeId` is what the name is unique within: the org's id for an environment's name, the
 * environment's id for a secret's. The index is what the store keeps in place of the name: equal
 * names in one scope have one index, so the store can still refuse a duplicate and find a secret,
 * and it tells nothing else apart.
 *
 * The wrap is a vouched box, so only the account's owner can make one: a names key the store made
 * up would let it read every name written afterwards. A reader takes it from the account key it
 * already trusts, and from nobody else.
 */

import {
  decodePublicKey,
  freshIv,
  fromBase64,
  fromUtf8,
  hkdf,
  openVouched,
  type PrivateKey,
  sealed,
  sealVouched,
  toBase64,
  toBase64Url,
  unseal,
  utf8,
  VaultError,
} from '@internal/zk-vault';
import { tuple } from './encoding.ts';

const SEAL_INFO = 'baymutt-name-seal';
const INDEX_INFO = 'baymutt-name-index';
const WRAP_INFO = 'baymutt-names-key-wrap';

const NAMES_KEY_BYTES = 32;

/** An org's names key, ready to seal, open and index. It cannot be exported again. */
export type NamesKey = {
  readonly sealKey: CryptoKey;
  readonly indexKey: CryptoKey;
};

const namesKeyFromBytes = async (bytes: Uint8Array<ArrayBuffer>): Promise<NamesKey> => {
  if (bytes.length !== NAMES_KEY_BYTES) {
    throw new VaultError('malformed', `a names key is ${NAMES_KEY_BYTES} bytes`);
  }
  const [sealKey, indexKey] = await Promise.all([
    hkdf(bytes, SEAL_INFO, { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    hkdf(bytes, INDEX_INFO, { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
  ]);
  return { sealKey, indexKey };
};

type Reader = { readonly id: string; readonly publicKey: string };

const wrapAad = (orgId: string, readerId: string) => tuple(orgId, readerId);

const wrapFor = async (
  accountKey: PrivateKey,
  orgId: string,
  reader: Reader,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> =>
  toBase64(
    await sealVouched({
      sender: accountKey,
      recipient: decodePublicKey(reader.publicKey, 'the reader public key'),
      info: WRAP_INFO,
      aad: wrapAad(orgId, reader.id),
      plaintext: bytes,
    }),
  );

const openWrap = ({
  wrap,
  orgId,
  readerKey,
  readerId,
  accountPublicKey,
}: {
  readonly wrap: string;
  readonly orgId: string;
  readonly readerKey: PrivateKey;
  readonly readerId: string;
  readonly accountPublicKey: string;
}): Promise<Uint8Array<ArrayBuffer>> =>
  openVouched({
    recipient: readerKey,
    sender: decodePublicKey(accountPublicKey, 'the account public key'),
    info: WRAP_INFO,
    aad: wrapAad(orgId, readerId),
    box: fromBase64(wrap, 'the names key wrap'),
    what: 'the names key wrap',
  });

/**
 * A new org's names key, wrapped by the owner's account key to each reader. The owner's own copy
 * is one of them: a reader whose id is the account's and whose key is the account's public key.
 * Each reader's key must be one the owner already trusts, never one the store served as it stands.
 */
export const createNamesKey = async ({
  accountKey,
  orgId,
  readers,
}: {
  readonly accountKey: PrivateKey;
  readonly orgId: string;
  readonly readers: ReadonlyArray<Reader>;
}): Promise<{
  readonly namesKey: NamesKey;
  readonly wraps: ReadonlyArray<{ readonly readerId: string; readonly wrap: string }>;
}> => {
  const bytes = crypto.getRandomValues(new Uint8Array(NAMES_KEY_BYTES));
  return {
    namesKey: await namesKeyFromBytes(bytes),
    wraps: await Promise.all(
      readers.map(async reader => ({
        readerId: reader.id,
        wrap: await wrapFor(accountKey, orgId, reader, bytes),
      })),
    ),
  };
};

/**
 * The org's names key as the account's owner wrapped it to this reader. Throws `unreadable` for a
 * wrap that `accountPublicKey`'s holder did not make for this reader and this org.
 */
export const openNamesKey = async (wrap: {
  readonly wrap: string;
  readonly orgId: string;
  readonly readerKey: PrivateKey;
  readonly readerId: string;
  /** The account's public key as this reader already trusts it: pinned at login, vouched for by its maker, or the owner's own. */
  readonly accountPublicKey: string;
}): Promise<NamesKey> => namesKeyFromBytes(await openWrap(wrap));

/**
 * The owner hands the org's names key on to one more reader: its own copy opened, and wrapped
 * again. `reader`'s key must be one the owner already trusts.
 */
export const rewrapNamesKey = async ({
  ownWrap,
  orgId,
  accountKey,
  accountId,
  reader,
}: {
  readonly ownWrap: string;
  readonly orgId: string;
  readonly accountKey: PrivateKey;
  readonly accountId: string;
  readonly reader: Reader;
}): Promise<string> =>
  wrapFor(
    accountKey,
    orgId,
    reader,
    await openWrap({
      wrap: ownWrap,
      orgId,
      readerKey: accountKey,
      readerId: accountId,
      accountPublicKey: toBase64Url(accountKey.publicKey),
    }),
  );

/** What the store keeps in place of a name: one spelling per name and scope, and nothing to read. */
export const nameIndex = async (
  { indexKey }: NamesKey,
  { scopeId, name }: { readonly scopeId: string; readonly name: string },
): Promise<string> =>
  toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', indexKey, tuple(scopeId, name))));

/** A name as the store keeps it: its index, and the name sealed for whoever holds the names key. */
export type StoredName = {
  /** The index. In an org whose names are not sealed yet, the name itself. */
  readonly name: string;
  /** Null only in an org whose names are not sealed yet. */
  readonly sealedName: string | null;
};

export const sealName = async (
  namesKey: NamesKey,
  { scopeId, name }: { readonly scopeId: string; readonly name: string },
): Promise<{ readonly name: string; readonly sealedName: string }> => {
  const iv = freshIv();
  return {
    name: await nameIndex(namesKey, { scopeId, name }),
    sealedName: sealed(
      iv,
      new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: tuple(scopeId) },
          namesKey.sealKey,
          utf8(name),
        ),
      ),
    ),
  };
};

/**
 * The name a stored one stands for. With the org's names key, the sealed name must open and its
 * index must be the one the store filed it under, so the store cannot show one name for another.
 * Without a names key (`null`: the org's names are not sealed yet) the stored name is the name,
 * and a sealed one is refused: nothing here can open it.
 */
export const openName = async (
  namesKey: NamesKey | null,
  { scopeId, stored }: { readonly scopeId: string; readonly stored: StoredName },
): Promise<string> => {
  if (namesKey === null) {
    if (stored.sealedName !== null) {
      throw new VaultError('unreadable', 'this name is sealed and no names key was handed over');
    }
    return stored.name;
  }
  if (stored.sealedName === null) {
    throw new VaultError('unreadable', 'the store shows a name it did not seal in a sealed org');
  }
  const { iv, body } = unseal(stored.sealedName, 'the sealed name');
  const opened = await crypto.subtle
    .decrypt({ name: 'AES-GCM', iv, additionalData: tuple(scopeId) }, namesKey.sealKey, body)
    .catch(() => {
      throw new VaultError('unreadable', 'a name was not sealed with this org’s names key');
    });
  const name = fromUtf8(new Uint8Array(opened));
  if ((await nameIndex(namesKey, { scopeId, name })) !== stored.name) {
    throw new VaultError('unreadable', 'the store filed a name under another name’s index');
  }
  return name;
};
