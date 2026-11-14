/**
 * What a login writes when it makes a scoped service account, so that its access can change later
 * without anyone taking the store's word for a key. Three vouched boxes, each one only the login
 * and its recipient can make:
 *
 * ```
 * keyToOwner  = vouched(makerPriv → accountPub, serviceAccountPub, info "baymutt-issued-key-voucher",
 *                       aad = [accountId, serviceAccountId])     → the owner's browser learns the key
 * keyToMaker  = vouched(makerPriv → makerPub,   serviceAccountPub, the same)   → the login learns it again
 * accountKey  = vouched(makerPriv → serviceAccountPub, accountPub, info "baymutt-root-key-voucher",
 *                       aad = [accountId, serviceAccountId])     → the service account learns the account's key
 * ```
 *
 * The owner's browser trusts the login through the vault's endorsement, so it takes `keyToOwner`
 * from it; the login takes `keyToMaker` from itself. The service account already trusts its maker
 * (its key string names it), so it takes the account's key from `accountKey`, and with it the
 * owner's proof of an environment's key. A login writes them only with an account key it learned at
 * pairing, never one the store served.
 */

import {
  decodePublicKey,
  fromBase64,
  openVouched,
  type PrivateKey,
  sealVouched,
  toBase64,
  toBase64Url,
  VaultError,
} from '@internal/zk-vault';
import { tuple } from './encoding.ts';

const KEY_INFO = 'baymutt-issued-key-voucher';
const ACCOUNT_INFO = 'baymutt-root-key-voucher';

const aad = (accountId: string, serviceAccountId: string) => tuple(accountId, serviceAccountId);

export type ServiceAccountVouchers = {
  readonly keyToOwner: string;
  readonly keyToMaker: string;
  readonly accountKey: string;
};

const seal = async (
  sender: PrivateKey,
  recipient: string,
  info: string,
  binding: Uint8Array<ArrayBuffer>,
  publicKey: string,
) =>
  toBase64(
    await sealVouched({
      sender,
      recipient: decodePublicKey(recipient, 'the recipient public key'),
      info,
      aad: binding,
      plaintext: decodePublicKey(publicKey, 'the vouched public key'),
    }),
  );

const open = async (
  recipient: PrivateKey,
  sender: string,
  info: string,
  binding: Uint8Array<ArrayBuffer>,
  box: string,
  what: string,
) =>
  toBase64Url(
    await openVouched({
      recipient,
      sender: decodePublicKey(sender, 'the voucher public key'),
      info,
      aad: binding,
      box: fromBase64(box, what),
      what,
    }),
  );

/** What a login writes for a scoped service account it makes. `accountPublicKey` must be the one it learned at pairing. */
export const vouchForServiceAccount = async ({
  makerKey,
  accountId,
  accountPublicKey,
  serviceAccount,
}: {
  readonly makerKey: PrivateKey;
  readonly accountId: string;
  readonly accountPublicKey: string;
  readonly serviceAccount: { readonly id: string; readonly publicKey: string };
}): Promise<ServiceAccountVouchers> => {
  const binding = aad(accountId, serviceAccount.id);
  const makerPublicKey = toBase64Url(makerKey.publicKey);
  return {
    keyToOwner: await seal(makerKey, accountPublicKey, KEY_INFO, binding, serviceAccount.publicKey),
    keyToMaker: await seal(makerKey, makerPublicKey, KEY_INFO, binding, serviceAccount.publicKey),
    accountKey: await seal(
      makerKey,
      serviceAccount.publicKey,
      ACCOUNT_INFO,
      binding,
      accountPublicKey,
    ),
  };
};

/**
 * A scoped service account's public key, as its maker vouched for it to `readerKey`'s holder: the
 * owner's account key with `keyToOwner`, or the maker's own key with `keyToMaker`. Refused unless
 * `makerPublicKey` made it for this service account, and unless the store lists the same key.
 */
export const vouchedServiceAccountKey = async ({
  readerKey,
  makerPublicKey,
  accountId,
  serviceAccount,
}: {
  readonly readerKey: PrivateKey;
  readonly makerPublicKey: string;
  readonly accountId: string;
  readonly serviceAccount: {
    readonly id: string;
    readonly publicKey: string;
    readonly keyVoucher: string | null;
  };
}): Promise<{ readonly id: string; readonly publicKey: string }> => {
  if (serviceAccount.keyVoucher === null) {
    throw new VaultError(
      'unreadable',
      'nothing vouches for this service account’s key: the store shows no voucher from its maker',
    );
  }
  const vouched = await open(
    readerKey,
    makerPublicKey,
    KEY_INFO,
    aad(accountId, serviceAccount.id),
    serviceAccount.keyVoucher,
    'the service account key voucher',
  );
  if (vouched !== serviceAccount.publicKey) {
    throw new VaultError(
      'unreadable',
      'the store shows a key for this service account that its maker did not vouch for',
    );
  }
  return { id: serviceAccount.id, publicKey: vouched };
};

/** The account's public key, as this service account's maker vouched for it. */
export const vouchedAccountKey = ({
  serviceAccountKey,
  serviceAccountId,
  makerPublicKey,
  accountId,
  accountVoucher,
}: {
  readonly serviceAccountKey: PrivateKey;
  readonly serviceAccountId: string;
  readonly makerPublicKey: string;
  readonly accountId: string;
  readonly accountVoucher: string;
}): Promise<string> =>
  open(
    serviceAccountKey,
    makerPublicKey,
    ACCOUNT_INFO,
    aad(accountId, serviceAccountId),
    accountVoucher,
    'the account key voucher',
  );
