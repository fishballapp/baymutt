import { createHmac, hkdfSync } from 'node:crypto';
import {
  decodePublicKey,
  fromBase64,
  generateKeyPair,
  importPrivateKey,
  openVouched,
  toBase64Url,
} from '@internal/zk-vault';
import { describe, expect, it } from 'vitest';
import {
  createNamesKey,
  nameIndex,
  openName,
  openNamesKey,
  rewrapNamesKey,
  sealName,
} from './index.ts';

const ORG_ID = 'org-1';
const ACCOUNT_ID = 'account-1';
const ENVIRONMENT_ID = 'environment-1';

const party = async (id: string) => {
  const pair = await generateKeyPair();
  return { id, publicKey: pair.publicKey, key: await importPrivateKey(pair.privateKey, id) };
};

const setUp = async () => {
  const account = await party(ACCOUNT_ID);
  const login = await party('login-1');
  const { namesKey, wraps } = await createNamesKey({
    accountKey: account.key,
    orgId: ORG_ID,
    readers: [account, login],
  });
  const wrapOf = (readerId: string) => {
    const found = wraps.find(wrap => wrap.readerId === readerId);
    if (found === undefined) throw new Error(`no wrap for ${readerId}`);
    return found.wrap;
  };
  return { account, login, namesKey, wrapOf };
};

describe('an org’s names key', () => {
  it('opens for each reader it was wrapped to, to the same key', async () => {
    const { account, login, namesKey, wrapOf } = await setUp();
    const forLogin = await openNamesKey({
      wrap: wrapOf(login.id),
      orgId: ORG_ID,
      readerKey: login.key,
      readerId: login.id,
      accountPublicKey: account.publicKey,
    });
    const forOwner = await openNamesKey({
      wrap: wrapOf(ACCOUNT_ID),
      orgId: ORG_ID,
      readerKey: account.key,
      readerId: ACCOUNT_ID,
      accountPublicKey: account.publicKey,
    });
    const slot = { scopeId: ORG_ID, name: 'app/production' };
    expect(await nameIndex(forLogin, slot)).toBe(await nameIndex(namesKey, slot));
    expect(await nameIndex(forOwner, slot)).toBe(await nameIndex(namesKey, slot));
  });

  it('is refused from anyone but the account: the store cannot hand over a key of its own', async () => {
    const { login } = await setUp();
    const stranger = await party(ACCOUNT_ID);
    const forged = await createNamesKey({
      accountKey: stranger.key,
      orgId: ORG_ID,
      readers: [login],
    });
    const { account } = await setUp();
    await expect(
      openNamesKey({
        wrap: forged.wraps[0]?.wrap ?? '',
        orgId: ORG_ID,
        readerKey: login.key,
        readerId: login.id,
        accountPublicKey: account.publicKey,
      }),
    ).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('is bound to its org and its reader', async () => {
    const { account, login, wrapOf } = await setUp();
    const open = (orgId: string, readerId: string) =>
      openNamesKey({
        wrap: wrapOf(login.id),
        orgId,
        readerKey: login.key,
        readerId,
        accountPublicKey: account.publicKey,
      });
    await expect(open('org-2', login.id)).rejects.toMatchObject({ code: 'unreadable' });
    await expect(open(ORG_ID, 'login-2')).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('is handed on by the owner to one more reader', async () => {
    const { account, namesKey, wrapOf } = await setUp();
    const serviceAccount = await party('service-account-1');
    const wrap = await rewrapNamesKey({
      ownWrap: wrapOf(ACCOUNT_ID),
      orgId: ORG_ID,
      accountKey: account.key,
      accountId: ACCOUNT_ID,
      reader: serviceAccount,
    });
    const opened = await openNamesKey({
      wrap,
      orgId: ORG_ID,
      readerKey: serviceAccount.key,
      readerId: serviceAccount.id,
      accountPublicKey: account.publicKey,
    });
    const slot = { scopeId: ENVIRONMENT_ID, name: 'STRIPE_SECRET_KEY' };
    expect(await nameIndex(opened, slot)).toBe(await nameIndex(namesKey, slot));
  });

  // The labels and bindings, pinned: changing one strands every name an account has sealed.
  it('wraps under `baymutt-names-key-wrap`, bound to [orgId, readerId], and derives its two keys by label', async () => {
    const { account, login, namesKey, wrapOf } = await setUp();
    const bytes = await openVouched({
      recipient: login.key,
      sender: decodePublicKey(account.publicKey, 'the account key'),
      info: 'baymutt-names-key-wrap',
      aad: new TextEncoder().encode(JSON.stringify([ORG_ID, login.id])),
      box: fromBase64(wrapOf(login.id), 'the wrap'),
      what: 'the wrap',
    });
    expect(bytes).toHaveLength(32);

    const indexKey = Buffer.from(
      hkdfSync('sha256', bytes, new Uint8Array(0), 'baymutt-name-index', 32),
    );
    const expected = createHmac('sha256', indexKey)
      .update(JSON.stringify([ENVIRONMENT_ID, 'STRIPE_SECRET_KEY']))
      .digest();
    expect(await nameIndex(namesKey, { scopeId: ENVIRONMENT_ID, name: 'STRIPE_SECRET_KEY' })).toBe(
      toBase64Url(expected),
    );

    const { sealedName } = await sealName(namesKey, { scopeId: ENVIRONMENT_ID, name: 'A' });
    const sealed = fromBase64(sealedName, 'the sealed name');
    const sealKey = await crypto.subtle.importKey(
      'raw',
      Buffer.from(hkdfSync('sha256', bytes, new Uint8Array(0), 'baymutt-name-seal', 32)),
      'AES-GCM',
      false,
      ['decrypt'],
    );
    const opened = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: sealed.subarray(0, 12),
        additionalData: new TextEncoder().encode(JSON.stringify([ENVIRONMENT_ID])),
      },
      sealKey,
      sealed.subarray(12),
    );
    expect(new TextDecoder().decode(opened)).toBe('A');
  });
});

describe('a sealed name', () => {
  it('opens to the name, and is filed under an index that is the same for the same name and scope', async () => {
    const { namesKey } = await setUp();
    const slot = { scopeId: ENVIRONMENT_ID, name: 'STRIPE_SECRET_KEY' };
    const first = await sealName(namesKey, slot);
    const second = await sealName(namesKey, slot);
    expect(first.name).toBe(second.name);
    expect(first.name).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first.sealedName).not.toBe(second.sealedName);
    expect(await openName(namesKey, { scopeId: ENVIRONMENT_ID, stored: first })).toBe(slot.name);
  });

  it('has another index in another scope, and under another org’s key', async () => {
    const { namesKey } = await setUp();
    const other = await setUp();
    const name = 'STRIPE_SECRET_KEY';
    const index = await nameIndex(namesKey, { scopeId: ENVIRONMENT_ID, name });
    expect(await nameIndex(namesKey, { scopeId: 'environment-2', name })).not.toBe(index);
    expect(await nameIndex(other.namesKey, { scopeId: ENVIRONMENT_ID, name })).not.toBe(index);
  });

  it('is refused under another name’s index, in another scope, or under another key', async () => {
    const { namesKey } = await setUp();
    const other = await setUp();
    const one = await sealName(namesKey, { scopeId: ENVIRONMENT_ID, name: 'ONE' });
    const two = await sealName(namesKey, { scopeId: ENVIRONMENT_ID, name: 'TWO' });
    await expect(
      openName(namesKey, {
        scopeId: ENVIRONMENT_ID,
        stored: { name: two.name, sealedName: one.sealedName },
      }),
    ).rejects.toMatchObject({ code: 'unreadable' });
    await expect(
      openName(namesKey, { scopeId: 'environment-2', stored: one }),
    ).rejects.toMatchObject({ code: 'unreadable' });
    await expect(
      openName(other.namesKey, { scopeId: ENVIRONMENT_ID, stored: one }),
    ).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('is the stored name itself in an org with no names key, and never a mix of the two', async () => {
    const { namesKey } = await setUp();
    const plain = { name: 'STRIPE_SECRET_KEY', sealedName: null };
    expect(await openName(null, { scopeId: ENVIRONMENT_ID, stored: plain })).toBe(plain.name);
    await expect(
      openName(namesKey, { scopeId: ENVIRONMENT_ID, stored: plain }),
    ).rejects.toMatchObject({ code: 'unreadable' });
    const sealed = await sealName(namesKey, { scopeId: ENVIRONMENT_ID, name: plain.name });
    await expect(openName(null, { scopeId: ENVIRONMENT_ID, stored: sealed })).rejects.toMatchObject(
      { code: 'unreadable' },
    );
  });
});
