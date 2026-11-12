// What keeps the vault open across a reload: the key that unwraps the data key, in this browser's
// IndexedDB. The key is a non-extractable `CryptoKey` and structured clone keeps it that way, so
// a page can use it and nothing can read its bytes. Signing out deletes it.
import type { VaultKey } from '@baymutt/keys';

export type KeptUnlock = {
  readonly accountId: string;
  readonly unlockedWith: VaultKey;
  readonly wrappedDek: string;
};

const STORE = 'unlock';
const KEY = 'owner';

const database = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open('baymutt', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });

const inStore = async <A>(
  mode: IDBTransactionMode,
  ask: (store: IDBObjectStore) => IDBRequest<A>,
): Promise<A> => {
  const db = await database();
  try {
    return await new Promise<A>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const asked = ask(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(asked.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
};

const isKeptUnlock = (stored: unknown): stored is KeptUnlock =>
  typeof stored === 'object' &&
  stored !== null &&
  'accountId' in stored &&
  typeof stored.accountId === 'string' &&
  'wrappedDek' in stored &&
  typeof stored.wrappedDek === 'string' &&
  'unlockedWith' in stored &&
  typeof stored.unlockedWith === 'object' &&
  stored.unlockedWith !== null &&
  'encKey' in stored.unlockedWith &&
  stored.unlockedWith.encKey instanceof CryptoKey;

export const keepUnlock = async ({ accountId, unlockedWith, wrappedDek }: KeptUnlock) => {
  await inStore('readwrite', store =>
    store.put({ accountId, unlockedWith: { encKey: unlockedWith.encKey }, wrappedDek }, KEY),
  );
};

export const keptUnlock = async (): Promise<KeptUnlock | null> => {
  const stored: unknown = await inStore('readonly', store => store.get(KEY));
  return isKeptUnlock(stored) ? stored : null;
};

export const forgetUnlock = async () => {
  await inStore('readwrite', store => store.delete(KEY));
};
