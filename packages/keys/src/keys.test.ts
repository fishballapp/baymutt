import { hkdfSync } from 'node:crypto';
import {
  decodePublicKey,
  fromBase64,
  generateKeyPair,
  importPrivateKey,
  openBox,
  openVouched,
  sealBox,
  toBase64Url,
  utf8,
} from '@internal/zk-vault';
import { describe, expect, it } from 'vitest';
import { fromCrockford, toCrockford } from './encoding.ts';
import {
  createAccountKey,
  createEnvironmentKey,
  createVault,
  derivePasskeyEncKey,
  endorseCredential,
  endorsedPublicKey,
  generateEnvironmentKey,
  generateRecoveryKey,
  generateServiceAccountToken,
  grantToServiceAccount,
  grantToTrustedReader,
  openAccountKey,
  openOwnedEnvironment,
  openValue,
  openVault,
  openWelcome,
  parseBearer,
  publicKeyFingerprint,
  randomToken,
  recoveryVaultKey,
  rewrapDek,
  sealValue,
  sealWelcome,
  serviceAccountKeyFromToken,
  unwrapEnvironmentKey,
  vaultProof,
  vouchedAccountKey,
  vouchedEnvironmentKey,
  vouchedScopedReader,
  vouchedServiceAccountKey,
  vouchForEnvironmentKey,
  vouchForServiceAccount,
  wrapEnvironmentKey,
} from './index.ts';

const BINDING = { accountId: 'account-1', environmentId: 'environment-1', keyVersion: 1 };
const SLOT = { ...BINDING, name: 'STRIPE_SECRET_KEY', version: 3 };

const ownerVault = async () => {
  const key = { encKey: await derivePasskeyEncKey(crypto.getRandomValues(new Uint8Array(32))) };
  return { key, ...(await createVault(key)) };
};

describe('a service account key', () => {
  it('derives its key pair and bearer from the seed alone, as HKDF says', async () => {
    const token = generateServiceAccountToken();
    // The seed is base64url, so it may hold an underscore itself: split on the prefix's, not every one.
    const { credentialId, seed } =
      /^baymutt_key_(?<credentialId>[^_]+)_(?<seed>.+)$/.exec(token)?.groups ?? {};
    const serviceAccount = await serviceAccountKeyFromToken(token);
    const again = await serviceAccountKeyFromToken(token);
    const seedBytes = Buffer.from(seed ?? '', 'base64url');
    const bearerSecret = Buffer.from(
      hkdfSync('sha256', seedBytes, Buffer.alloc(0), 'baymutt-machine-bearer', 32),
    ).toString('base64url');

    expect(serviceAccount.credentialId).toBe(credentialId);
    expect(serviceAccount.bearer).toBe(`baymutt_${credentialId}_${bearerSecret}`);
    expect(serviceAccount.publicKey).toBe(again.publicKey);
    expect(serviceAccount.bearer).not.toContain(seed);
    expect(await parseBearer(serviceAccount.bearer)).toEqual({
      credentialId,
      bearerHash: serviceAccount.bearerHash,
    });
  });

  it('gives two service accounts nothing in common', async () => {
    const [one, two] = await Promise.all([
      serviceAccountKeyFromToken(generateServiceAccountToken()),
      serviceAccountKeyFromToken(generateServiceAccountToken()),
    ]);

    expect(one.publicKey).not.toBe(two.publicKey);
    expect(one.bearerHash).not.toBe(two.bearerHash);
  });

  it('refuses what is not a service account key or a bearer', async () => {
    const serviceAccount = await serviceAccountKeyFromToken(generateServiceAccountToken());

    await expect(serviceAccountKeyFromToken(serviceAccount.bearer)).rejects.toMatchObject({
      code: 'malformed',
    });
    await expect(serviceAccountKeyFromToken('baymutt_key_nope')).rejects.toMatchObject({
      code: 'malformed',
    });
    expect(await parseBearer('Bearer nope')).toBeNull();
    expect(await parseBearer(`${serviceAccount.bearer}x`)).toBeNull();
  });
});

describe('an environment key wrap', () => {
  const setup = async () => {
    const environment = await generateEnvironmentKey();
    const reader = await generateKeyPair();
    const readerKey = await importPrivateKey(reader.privateKey, 'the reader');
    const wrap = await wrapEnvironmentKey({
      environmentPrivateKey: environment.privateKey,
      readerPublicKey: reader.publicKey,
      readerId: 'credential-1',
      binding: BINDING,
    });
    return { environment, readerKey, wrap };
  };

  it('opens for its reader to the environment key', async () => {
    const { environment, readerKey, wrap } = await setup();

    const opened = await unwrapEnvironmentKey({
      wrap,
      readerKey,
      readerId: 'credential-1',
      binding: BINDING,
      environmentPublicKey: environment.publicKey,
    });

    expect(opened.encoded).toBe(environment.privateKey);
  });

  it('is bound to its reader, account, environment and key version', async () => {
    const { environment, readerKey, wrap } = await setup();
    const open = (overrides: Partial<Parameters<typeof unwrapEnvironmentKey>[0]>) =>
      unwrapEnvironmentKey({
        wrap,
        readerKey,
        readerId: 'credential-1',
        binding: BINDING,
        environmentPublicKey: environment.publicKey,
        ...overrides,
      });
    const stranger = await importPrivateKey((await generateKeyPair()).privateKey, 'a stranger');

    for (const overrides of [
      { readerKey: stranger },
      { readerId: 'credential-2' },
      { binding: { ...BINDING, accountId: 'account-2' } },
      { binding: { ...BINDING, environmentId: 'environment-2' } },
      { binding: { ...BINDING, keyVersion: 2 } },
    ]) {
      await expect(open(overrides)).rejects.toMatchObject({ code: 'unreadable' });
    }
  });

  it('refuses a wrap of some other key, however validly sealed', async () => {
    const { environment, readerKey } = await setup();
    const other = await generateEnvironmentKey();
    const swapped = await wrapEnvironmentKey({
      environmentPrivateKey: other.privateKey,
      readerPublicKey: Buffer.from(readerKey.publicKey).toString('base64url'),
      readerId: 'credential-1',
      binding: BINDING,
    });

    await expect(
      unwrapEnvironmentKey({
        wrap: swapped,
        readerKey,
        readerId: 'credential-1',
        binding: BINDING,
        environmentPublicKey: environment.publicKey,
      }),
    ).rejects.toThrow('not this environment');
  });
});

describe('a sealed value', () => {
  it('is sealed with the public key alone and opened with the private one, multi-line and all', async () => {
    const environment = await generateEnvironmentKey();
    const environmentKey = await importPrivateKey(environment.privateKey, 'the environment key');
    const value = '-----BEGIN PRIVATE KEY-----\nline two\n-----END PRIVATE KEY-----\n';

    const ciphertext = await sealValue({
      environmentPublicKey: environment.publicKey,
      slot: SLOT,
      value,
    });

    expect(ciphertext).not.toContain('BEGIN');
    expect(await openValue({ environmentKey, slot: SLOT, ciphertext })).toBe(value);
    expect(
      await openValue({
        environmentKey,
        slot: SLOT,
        ciphertext: await sealValue({
          environmentPublicKey: environment.publicKey,
          slot: SLOT,
          value: '',
        }),
      }),
    ).toBe('');
  });

  it('opens only in its own slot', async () => {
    const environment = await generateEnvironmentKey();
    const environmentKey = await importPrivateKey(environment.privateKey, 'the environment key');
    const ciphertext = await sealValue({
      environmentPublicKey: environment.publicKey,
      slot: SLOT,
      value: 'a value',
    });

    for (const slot of [
      { ...SLOT, name: 'STRIPE_PUBLIC_KEY' },
      { ...SLOT, version: 4 },
      { ...SLOT, keyVersion: 2 },
      { ...SLOT, environmentId: 'environment-2' },
      { ...SLOT, accountId: 'account-2' },
    ]) {
      await expect(openValue({ environmentKey, slot, ciphertext })).rejects.toMatchObject({
        code: 'unreadable',
      });
    }
  });

  it('does not open for another environment’s key', async () => {
    const environment = await generateEnvironmentKey();
    const other = await importPrivateKey(
      (await generateEnvironmentKey()).privateKey,
      'another key',
    );
    const ciphertext = await sealValue({
      environmentPublicKey: environment.publicKey,
      slot: SLOT,
      value: 'a value',
    });

    await expect(
      openValue({ environmentKey: other, slot: SLOT, ciphertext }),
    ).rejects.toMatchObject({
      code: 'unreadable',
    });
  });
});

describe('the owner’s vault', () => {
  it('keeps the account key, and refuses a public key that is not its pair', async () => {
    const { vault } = await ownerVault();
    const account = await createAccountKey(vault);
    const other = await generateKeyPair();

    const key = await openAccountKey(vault, account);

    expect(Buffer.from(key.publicKey).toString('base64url')).toBe(account.publicKey);
    await expect(openAccountKey(vault, { ...account, publicKey: other.publicKey })).rejects.toThrow(
      'not the pair',
    );
    await expect(openAccountKey((await ownerVault()).vault, account)).rejects.toMatchObject({
      code: 'unreadable',
    });
  });

  it('vouches for a paired service account’s key, for that credential only', async () => {
    const { vault } = await ownerVault();
    const serviceAccount = await serviceAccountKeyFromToken(generateServiceAccountToken());
    const endorsement = await endorseCredential(vault, serviceAccount);

    expect(
      await endorsedPublicKey(vault, { credentialId: serviceAccount.credentialId, endorsement }),
    ).toBe(serviceAccount.publicKey);
    await expect(
      endorsedPublicKey(vault, { credentialId: crypto.randomUUID(), endorsement }),
    ).rejects.toMatchObject({ code: 'unreadable' });
    await expect(
      endorsedPublicKey((await ownerVault()).vault, {
        credentialId: serviceAccount.credentialId,
        endorsement,
      }),
    ).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('opens again with the recovery key, however it is typed back', async () => {
    const { key, vault, wrappedDek } = await ownerVault();
    const account = await createAccountKey(vault);
    const recoveryKey = generateRecoveryKey();
    const recoveryWrap = await rewrapDek(key, await recoveryVaultKey(recoveryKey), wrappedDek);

    const typed = await recoveryVaultKey(` ${recoveryKey.toLowerCase().replaceAll('-', ' ')} `);
    const reopened = await openVault(typed, recoveryWrap);

    expect(recoveryKey).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){12}[0-9A-HJKMNP-TV-Z]{4}$/);
    await expect(openAccountKey(reopened, account)).resolves.toBeDefined();
  });

  it('refuses a recovery key that is mistyped', async () => {
    const recoveryKey = generateRecoveryKey();

    await expect(recoveryVaultKey(recoveryKey.slice(1))).rejects.toMatchObject({
      code: 'malformed',
    });
    await expect(recoveryVaultKey(recoveryKey.replace(/.$/, 'U'))).rejects.toMatchObject({
      code: 'malformed',
    });
  });

  it('proves itself open with a value only it can compute, the same on every open', async () => {
    const { key, vault, wrappedDek } = await ownerVault();
    const other = await ownerVault();

    const proof = await vaultProof(vault, 'account-1');

    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await vaultProof(await openVault(key, wrappedDek), 'account-1')).toBe(proof);
    expect(await vaultProof(vault, 'account-2')).not.toBe(proof);
    expect(await vaultProof(other.vault, 'account-1')).not.toBe(proof);
  });
});

describe('Crockford base32', () => {
  it('round-trips any bytes', () => {
    for (const length of [1, 5, 16, 32, 33]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));

      expect(fromCrockford(toCrockford(bytes), length, 'the bytes')).toEqual(bytes);
    }
  });

  it('has one spelling for each value: stray trailing bits are refused', () => {
    expect(() => fromCrockford('ZZ', 1, 'the byte')).toThrow('stray bits');
    expect(fromCrockford('ZW', 1, 'the byte')).toEqual(new Uint8Array([255]));
  });
});

describe('the pairing welcome', () => {
  const setup = async () => {
    const serviceAccount = await serviceAccountKeyFromToken(generateServiceAccountToken());
    const pairing = {
      pairingSecret: randomToken(),
      credentialId: serviceAccount.credentialId,
      serviceAccountPublicKey: serviceAccount.publicKey,
    };
    const welcome = {
      accountId: 'account-1',
      accountPublicKey: (await generateKeyPair()).publicKey,
    };
    return { pairing, welcome, sealedWelcome: await sealWelcome(pairing, welcome) };
  };

  it('tells the service account which account key to trust', async () => {
    const { pairing, welcome, sealedWelcome } = await setup();

    expect(await openWelcome(pairing, sealedWelcome)).toEqual(welcome);
  });

  it('cannot be written without the pairing secret, or moved to another service account', async () => {
    const { pairing, welcome, sealedWelcome } = await setup();
    const other = await serviceAccountKeyFromToken(generateServiceAccountToken());

    const forged = await sealWelcome({ ...pairing, pairingSecret: randomToken() }, welcome);

    await expect(openWelcome(pairing, forged)).rejects.toMatchObject({ code: 'unreadable' });
    await expect(
      openWelcome({ ...pairing, credentialId: other.credentialId }, sealedWelcome),
    ).rejects.toMatchObject({ code: 'unreadable' });
    await expect(
      openWelcome({ ...pairing, serviceAccountPublicKey: other.publicKey }, sealedWelcome),
    ).rejects.toMatchObject({ code: 'unreadable' });
  });
});

describe('publicKeyFingerprint', () => {
  it('is the same for the same key and different for another', async () => {
    const [one, two] = await Promise.all([generateKeyPair(), generateKeyPair()]);

    expect(await publicKeyFingerprint(one.publicKey)).toBe(
      await publicKeyFingerprint(one.publicKey),
    );
    expect(await publicKeyFingerprint(one.publicKey)).not.toBe(
      await publicKeyFingerprint(two.publicKey),
    );
  });
});

// The environment was a project when these were written, and every stored key and value was sealed
// under them: the labels say `project`, and a binding is a JSON array of values. Changing a label
// or the bytes of a binding makes what the owner stored unreadable.
describe('an environment key, as it was sealed while environments were projects', () => {
  const BINDING_BYTES = utf8(JSON.stringify(['account-1', 'environment-1', '1', 'credential-1']));
  const SLOT_BYTES = utf8(
    JSON.stringify(['account-1', 'environment-1', '1', 'STRIPE_SECRET_KEY', '3']),
  );

  it('wraps and proves under the labels `baymutt-project-key` and `baymutt-project-key-proof`', async () => {
    const environment = await generateEnvironmentKey();
    const reader = await generateKeyPair();
    const readerKey = await importPrivateKey(reader.privateKey, 'the reader');
    const voucher = await generateKeyPair();
    const voucherKey = await importPrivateKey(voucher.privateKey, 'the voucher');
    const wrap = await wrapEnvironmentKey({
      environmentPrivateKey: environment.privateKey,
      readerPublicKey: reader.publicKey,
      readerId: 'credential-1',
      binding: BINDING,
    });
    const proof = await vouchForEnvironmentKey({
      voucherKey,
      reader: { id: 'credential-1', publicKey: reader.publicKey },
      binding: BINDING,
      environmentPublicKey: environment.publicKey,
    });

    const wrapped = await openBox({
      privateKey: readerKey,
      info: 'baymutt-project-key',
      aad: BINDING_BYTES,
      box: fromBase64(wrap, 'the wrap'),
      what: 'the wrap',
    });
    const proved = await openVouched({
      recipient: readerKey,
      sender: decodePublicKey(voucher.publicKey, 'the voucher'),
      info: 'baymutt-project-key-proof',
      aad: BINDING_BYTES,
      box: fromBase64(proof, 'the proof'),
      what: 'the proof',
    });

    expect(new TextDecoder().decode(wrapped)).toBe(environment.privateKey);
    expect(toBase64Url(proved)).toBe(environment.publicKey);
  });

  it('seals a value under `baymutt-secret-value` in the slot [account, environment, key version, name, version]', async () => {
    const environment = await generateEnvironmentKey();
    const environmentKey = await importPrivateKey(environment.privateKey, 'the environment key');
    const stored = await sealBox({
      recipient: decodePublicKey(environment.publicKey, 'the environment key'),
      info: 'baymutt-secret-value',
      aad: SLOT_BYTES,
      plaintext: utf8('a value sealed before the rename'),
    });

    expect(
      await openValue({
        environmentKey,
        slot: SLOT,
        ciphertext: stored.toBase64(),
      }),
    ).toBe('a value sealed before the rename');
  });
});

describe('an environment key proof', () => {
  const setup = async () => {
    const environment = await generateEnvironmentKey();
    const [voucher, reader] = await Promise.all(
      [1, 2].map(async () => {
        const pair = await generateKeyPair();
        return { ...pair, key: await importPrivateKey(pair.privateKey, 'a test key') };
      }),
    );
    if (voucher === undefined || reader === undefined) throw new Error('no keys');
    const proof = await vouchForEnvironmentKey({
      voucherKey: voucher.key,
      reader: { id: 'credential-1', publicKey: reader.publicKey },
      binding: BINDING,
      environmentPublicKey: environment.publicKey,
    });
    return { environment, voucher, reader, proof };
  };

  it('tells the reader the environment’s public key, from a voucher it trusts', async () => {
    const { environment, voucher, reader, proof } = await setup();
    const stranger = await generateKeyPair();

    expect(
      await vouchedEnvironmentKey({
        proof,
        readerKey: reader.key,
        readerId: 'credential-1',
        vouchers: [stranger.publicKey, voucher.publicKey],
        binding: BINDING,
      }),
    ).toBe(environment.publicKey);
  });

  it('cannot be made by a stranger, and is bound to its reader, environment and key version', async () => {
    const { environment, voucher, reader, proof } = await setup();
    const stranger = await generateKeyPair();
    const strangerKey = await importPrivateKey(stranger.privateKey, 'a stranger');
    const forged = await vouchForEnvironmentKey({
      voucherKey: strangerKey,
      reader: { id: 'credential-1', publicKey: reader.publicKey },
      binding: BINDING,
      environmentPublicKey: stranger.publicKey,
    });
    const read = (overrides: Partial<Parameters<typeof vouchedEnvironmentKey>[0]>) =>
      vouchedEnvironmentKey({
        proof,
        readerKey: reader.key,
        readerId: 'credential-1',
        vouchers: [voucher.publicKey],
        binding: BINDING,
        ...overrides,
      });

    for (const overrides of [
      { proof: forged },
      { vouchers: [] },
      { readerId: 'credential-2' },
      { readerKey: strangerKey },
      { binding: { ...BINDING, environmentId: 'environment-2' } },
      { binding: { ...BINDING, keyVersion: 2 } },
      { binding: { ...BINDING, accountId: 'account-2' } },
    ]) {
      await expect(read(overrides)).rejects.toMatchObject({ code: 'unreadable' });
    }
    expect(environment.publicKey).not.toBe(stranger.publicKey);
  });
});

describe('the owner and an environment', () => {
  /** An owner, a service account it paired, and an environment that service account created. */
  const setup = async () => {
    const { vault } = await ownerVault();
    const account = await createAccountKey(vault);
    const owner = {
      vault,
      accountId: BINDING.accountId,
      accountKey: await openAccountKey(vault, account),
    };
    const serviceAccount = await serviceAccountKeyFromToken(generateServiceAccountToken());
    const endorsement = await endorseCredential(vault, serviceAccount);
    const creator = {
      id: serviceAccount.credentialId,
      publicKey: serviceAccount.publicKey,
      endorsement,
    };
    const created = await createEnvironmentKey({
      voucherKey: serviceAccount.privateKey,
      binding: BINDING,
      readers: [{ id: BINDING.accountId, publicKey: account.publicKey }],
    });
    const [grant] = created.grants;
    if (grant === undefined) throw new Error('no grant');
    const owned = { ...BINDING, ownerWrap: grant.wrap, ownerProof: grant.proof, creator };
    return { owner, account, serviceAccount, creator, created, owned };
  };

  it('opens an environment a paired service account created, to the key that service account vouched for', async () => {
    const { owner, created, owned } = await setup();

    expect((await openOwnedEnvironment(owner, owned)).publicKey).toBe(created.publicKey);
  });

  it('refuses an environment the store forged: a key pair of its own, wrapped to the account', async () => {
    const { owner, account, owned } = await setup();
    const forgedPair = await generateEnvironmentKey();
    const forgedWrap = await wrapEnvironmentKey({
      environmentPrivateKey: forgedPair.privateKey,
      readerPublicKey: account.publicKey,
      readerId: BINDING.accountId,
      binding: BINDING,
    });
    const hostKey = await importPrivateKey((await generateKeyPair()).privateKey, 'the host');
    const forgedProof = await vouchForEnvironmentKey({
      voucherKey: hostKey,
      reader: { id: BINDING.accountId, publicKey: account.publicKey },
      binding: BINDING,
      environmentPublicKey: forgedPair.publicKey,
    });

    // Its own wrap with the real proof, its own proof, and a creator the vault never endorsed.
    for (const forged of [
      { ...owned, ownerWrap: forgedWrap },
      { ...owned, ownerWrap: forgedWrap, ownerProof: forgedProof },
      { ...owned, creator: { ...owned.creator, publicKey: (await generateKeyPair()).publicKey } },
      { ...owned, creator: { ...owned.creator, endorsement: null } },
      { ...owned, creator: null },
    ]) {
      await expect(openOwnedEnvironment(owner, forged)).rejects.toMatchObject({
        code: 'unreadable',
      });
    }
  });

  it('grants a paired service account the key it can open and a proof it can check', async () => {
    const { owner, account, created, owned } = await setup();
    const reader = await serviceAccountKeyFromToken(generateServiceAccountToken());
    const paired = {
      id: reader.credentialId,
      publicKey: reader.publicKey,
      endorsement: await endorseCredential(owner.vault, reader),
    };

    const grant = await grantToServiceAccount(owner, owned, paired, { canRead: true });
    const writeOnly = await grantToServiceAccount(owner, owned, paired, { canRead: false });

    const publicKey = await vouchedEnvironmentKey({
      proof: grant.keyProof,
      readerKey: reader.privateKey,
      readerId: reader.credentialId,
      vouchers: [account.publicKey],
      binding: BINDING,
    });
    expect(publicKey).toBe(created.publicKey);
    expect(writeOnly.readWrap).toBeNull();
    await expect(
      unwrapEnvironmentKey({
        wrap: grant.readWrap ?? '',
        readerKey: reader.privateKey,
        readerId: reader.credentialId,
        binding: BINDING,
        environmentPublicKey: publicKey,
      }),
    ).resolves.toBeDefined();
  });

  it('grants nothing to a service account the vault did not endorse, or whose key the store swapped', async () => {
    const { owner, owned } = await setup();
    const reader = await serviceAccountKeyFromToken(generateServiceAccountToken());
    const endorsement = await endorseCredential(owner.vault, reader);
    const swapped = (await generateKeyPair()).publicKey;

    for (const serviceAccount of [
      { id: reader.credentialId, publicKey: reader.publicKey, endorsement: null },
      { id: reader.credentialId, publicKey: swapped, endorsement },
    ]) {
      await expect(
        grantToServiceAccount(owner, owned, serviceAccount, { canRead: false }),
      ).rejects.toMatchObject({ code: 'unreadable' });
    }
  });
});

describe('a service account key made by another service account', () => {
  it('carries its maker’s public key, which is what it trusts', async () => {
    const maker = await serviceAccountKeyFromToken(generateServiceAccountToken());
    const made = await serviceAccountKeyFromToken(generateServiceAccountToken(maker.publicKey));

    expect(maker.issuerPublicKey).toBeNull();
    expect(made.issuerPublicKey).toBe(maker.publicKey);
    expect(await parseBearer(made.bearer)).toEqual({
      credentialId: made.credentialId,
      bearerHash: made.bearerHash,
    });
  });
});

describe('a scoped service account’s vouchers', () => {
  /** An owner, a login it paired, and a service account that login made. */
  const setup = async () => {
    const { vault } = await ownerVault();
    const account = await createAccountKey(vault);
    const owner = {
      vault,
      accountId: BINDING.accountId,
      accountKey: await openAccountKey(vault, account),
    };
    const login = await serviceAccountKeyFromToken(generateServiceAccountToken());
    const maker = {
      id: login.credentialId,
      publicKey: login.publicKey,
      endorsement: await endorseCredential(vault, login),
    };
    const made = await serviceAccountKeyFromToken(generateServiceAccountToken(login.publicKey));
    const vouchers = await vouchForServiceAccount({
      makerKey: login.privateKey,
      accountId: BINDING.accountId,
      accountPublicKey: account.publicKey,
      serviceAccount: { id: made.credentialId, publicKey: made.publicKey },
    });
    const listed = { id: made.credentialId, publicKey: made.publicKey };
    return { owner, account, login, maker, made, vouchers, listed };
  };

  it('tell the owner, the maker and the service account the keys each needs', async () => {
    const { owner, account, login, maker, made, vouchers, listed } = await setup();

    expect(
      await vouchedScopedReader(owner, {
        serviceAccount: { ...listed, keyVoucher: vouchers.keyToOwner },
        maker,
      }),
    ).toEqual(listed);
    expect(
      await vouchedServiceAccountKey({
        readerKey: login.privateKey,
        makerPublicKey: login.publicKey,
        accountId: BINDING.accountId,
        serviceAccount: { ...listed, keyVoucher: vouchers.keyToMaker },
      }),
    ).toEqual(listed);
    expect(
      await vouchedAccountKey({
        serviceAccountKey: made.privateKey,
        serviceAccountId: made.credentialId,
        makerPublicKey: login.publicKey,
        accountId: BINDING.accountId,
        accountVoucher: vouchers.accountKey,
      }),
    ).toBe(account.publicKey);
    // The labels and the binding, pinned: changing either strands every voucher already written.
    const pinned = await openVouched({
      recipient: owner.accountKey,
      sender: decodePublicKey(login.publicKey, 'the maker'),
      info: 'baymutt-service-account-key',
      aad: utf8(JSON.stringify([BINDING.accountId, made.credentialId])),
      box: fromBase64(vouchers.keyToOwner, 'the voucher'),
      what: 'the voucher',
    });
    expect(toBase64Url(pinned)).toBe(made.publicKey);
    const pinnedAccount = await openVouched({
      recipient: made.privateKey,
      sender: decodePublicKey(login.publicKey, 'the maker'),
      info: 'baymutt-account-key',
      aad: utf8(JSON.stringify([BINDING.accountId, made.credentialId])),
      box: fromBase64(vouchers.accountKey, 'the voucher'),
      what: 'the voucher',
    });
    expect(toBase64Url(pinnedAccount)).toBe(account.publicKey);
  });

  it('let the service account take the owner’s proof of an environment it was granted later', async () => {
    const { owner, account, made, vouchers } = await setup();
    const created = await createEnvironmentKey({
      voucherKey: owner.accountKey,
      binding: BINDING,
      readers: [{ id: BINDING.accountId, publicKey: account.publicKey }],
    });
    const [own] = created.grants;
    if (own === undefined) throw new Error('no grant');
    const owned = { ...BINDING, ownerWrap: own.wrap, ownerProof: own.proof, creator: null };
    const grant = await grantToTrustedReader(
      owner,
      owned,
      { id: made.credentialId, publicKey: made.publicKey },
      { canRead: true },
    );
    const accountPublicKey = await vouchedAccountKey({
      serviceAccountKey: made.privateKey,
      serviceAccountId: made.credentialId,
      makerPublicKey: made.issuerPublicKey ?? '',
      accountId: BINDING.accountId,
      accountVoucher: vouchers.accountKey,
    });

    expect(
      await vouchedEnvironmentKey({
        proof: grant.keyProof,
        readerKey: made.privateKey,
        readerId: made.credentialId,
        vouchers: [accountPublicKey],
        binding: BINDING,
      }),
    ).toBe(created.publicKey);
  });

  it('cannot be made by the store, moved to another service account, or name a swapped key', async () => {
    const { owner, account, login, maker, vouchers, listed } = await setup();
    const host = await serviceAccountKeyFromToken(generateServiceAccountToken());
    const forged = await vouchForServiceAccount({
      makerKey: host.privateKey,
      accountId: BINDING.accountId,
      accountPublicKey: account.publicKey,
      serviceAccount: { id: listed.id, publicKey: host.publicKey },
    });
    const other = await serviceAccountKeyFromToken(generateServiceAccountToken(login.publicKey));

    for (const [serviceAccount, makerOf] of [
      // No voucher: made before vouchers were written.
      [{ ...listed, keyVoucher: null }, maker],
      // The store's own key, vouched for by the store, or under the real maker's name.
      [{ ...listed, publicKey: host.publicKey, keyVoucher: forged.keyToOwner }, maker],
      // The store's key beside the real voucher.
      [{ ...listed, publicKey: host.publicKey, keyVoucher: vouchers.keyToOwner }, maker],
      // The real voucher moved to another service account.
      [
        { id: other.credentialId, publicKey: listed.publicKey, keyVoucher: vouchers.keyToOwner },
        maker,
      ],
      // A maker the vault never endorsed.
      [
        { ...listed, keyVoucher: vouchers.keyToOwner },
        { ...maker, endorsement: null },
      ],
      // The maker's own copy, which is not the owner's.
      [{ ...listed, keyVoucher: vouchers.keyToMaker }, maker],
    ] as const) {
      await expect(
        vouchedScopedReader(owner, { serviceAccount, maker: makerOf }),
      ).rejects.toMatchObject({ code: 'unreadable' });
    }
    await expect(
      vouchedAccountKey({
        serviceAccountKey: other.privateKey,
        serviceAccountId: other.credentialId,
        makerPublicKey: login.publicKey,
        accountId: BINDING.accountId,
        accountVoucher: vouchers.accountKey,
      }),
    ).rejects.toMatchObject({ code: 'unreadable' });
  });
});
