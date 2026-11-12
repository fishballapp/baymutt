import { hkdfSync } from 'node:crypto';
import { generateKeyPair, importPrivateKey } from '@internal/zk-vault';
import { describe, expect, it } from 'vitest';
import { fromCrockford, toCrockford } from './encoding.ts';
import {
  createAccountKey,
  createProjectKey,
  createVault,
  derivePasskeyEncKey,
  endorseCredential,
  endorsedPublicKey,
  generateProjectKey,
  generateRecoveryKey,
  generateServiceAccountToken,
  grantToServiceAccount,
  openAccountKey,
  openOwnedProject,
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
  unwrapProjectKey,
  vaultProof,
  vouchedProjectKey,
  vouchForProjectKey,
  wrapProjectKey,
} from './index.ts';

const BINDING = { accountId: 'account-1', projectId: 'project-1', keyVersion: 1 };
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

describe('a project key wrap', () => {
  const setup = async () => {
    const project = await generateProjectKey();
    const reader = await generateKeyPair();
    const readerKey = await importPrivateKey(reader.privateKey, 'the reader');
    const wrap = await wrapProjectKey({
      projectPrivateKey: project.privateKey,
      readerPublicKey: reader.publicKey,
      readerId: 'credential-1',
      binding: BINDING,
    });
    return { project, readerKey, wrap };
  };

  it('opens for its reader to the project key', async () => {
    const { project, readerKey, wrap } = await setup();

    const opened = await unwrapProjectKey({
      wrap,
      readerKey,
      readerId: 'credential-1',
      binding: BINDING,
      projectPublicKey: project.publicKey,
    });

    expect(opened.encoded).toBe(project.privateKey);
  });

  it('is bound to its reader, account, project and key version', async () => {
    const { project, readerKey, wrap } = await setup();
    const open = (overrides: Partial<Parameters<typeof unwrapProjectKey>[0]>) =>
      unwrapProjectKey({
        wrap,
        readerKey,
        readerId: 'credential-1',
        binding: BINDING,
        projectPublicKey: project.publicKey,
        ...overrides,
      });
    const stranger = await importPrivateKey((await generateKeyPair()).privateKey, 'a stranger');

    for (const overrides of [
      { readerKey: stranger },
      { readerId: 'credential-2' },
      { binding: { ...BINDING, accountId: 'account-2' } },
      { binding: { ...BINDING, projectId: 'project-2' } },
      { binding: { ...BINDING, keyVersion: 2 } },
    ]) {
      await expect(open(overrides)).rejects.toMatchObject({ code: 'unreadable' });
    }
  });

  it('refuses a wrap of some other key, however validly sealed', async () => {
    const { project, readerKey } = await setup();
    const other = await generateProjectKey();
    const swapped = await wrapProjectKey({
      projectPrivateKey: other.privateKey,
      readerPublicKey: Buffer.from(readerKey.publicKey).toString('base64url'),
      readerId: 'credential-1',
      binding: BINDING,
    });

    await expect(
      unwrapProjectKey({
        wrap: swapped,
        readerKey,
        readerId: 'credential-1',
        binding: BINDING,
        projectPublicKey: project.publicKey,
      }),
    ).rejects.toThrow('not this project');
  });
});

describe('a sealed value', () => {
  it('is sealed with the public key alone and opened with the private one, multi-line and all', async () => {
    const project = await generateProjectKey();
    const projectKey = await importPrivateKey(project.privateKey, 'the project key');
    const value = '-----BEGIN PRIVATE KEY-----\nline two\n-----END PRIVATE KEY-----\n';

    const ciphertext = await sealValue({ projectPublicKey: project.publicKey, slot: SLOT, value });

    expect(ciphertext).not.toContain('BEGIN');
    expect(await openValue({ projectKey, slot: SLOT, ciphertext })).toBe(value);
    expect(
      await openValue({
        projectKey,
        slot: SLOT,
        ciphertext: await sealValue({ projectPublicKey: project.publicKey, slot: SLOT, value: '' }),
      }),
    ).toBe('');
  });

  it('opens only in its own slot', async () => {
    const project = await generateProjectKey();
    const projectKey = await importPrivateKey(project.privateKey, 'the project key');
    const ciphertext = await sealValue({
      projectPublicKey: project.publicKey,
      slot: SLOT,
      value: 'a value',
    });

    for (const slot of [
      { ...SLOT, name: 'STRIPE_PUBLIC_KEY' },
      { ...SLOT, version: 4 },
      { ...SLOT, keyVersion: 2 },
      { ...SLOT, projectId: 'project-2' },
      { ...SLOT, accountId: 'account-2' },
    ]) {
      await expect(openValue({ projectKey, slot, ciphertext })).rejects.toMatchObject({
        code: 'unreadable',
      });
    }
  });

  it('does not open for another project’s key', async () => {
    const project = await generateProjectKey();
    const other = await importPrivateKey((await generateProjectKey()).privateKey, 'another key');
    const ciphertext = await sealValue({
      projectPublicKey: project.publicKey,
      slot: SLOT,
      value: 'a value',
    });

    await expect(openValue({ projectKey: other, slot: SLOT, ciphertext })).rejects.toMatchObject({
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

describe('a project key proof', () => {
  const setup = async () => {
    const project = await generateProjectKey();
    const [voucher, reader] = await Promise.all(
      [1, 2].map(async () => {
        const pair = await generateKeyPair();
        return { ...pair, key: await importPrivateKey(pair.privateKey, 'a test key') };
      }),
    );
    if (voucher === undefined || reader === undefined) throw new Error('no keys');
    const proof = await vouchForProjectKey({
      voucherKey: voucher.key,
      reader: { id: 'credential-1', publicKey: reader.publicKey },
      binding: BINDING,
      projectPublicKey: project.publicKey,
    });
    return { project, voucher, reader, proof };
  };

  it('tells the reader the project’s public key, from a voucher it trusts', async () => {
    const { project, voucher, reader, proof } = await setup();
    const stranger = await generateKeyPair();

    expect(
      await vouchedProjectKey({
        proof,
        readerKey: reader.key,
        readerId: 'credential-1',
        vouchers: [stranger.publicKey, voucher.publicKey],
        binding: BINDING,
      }),
    ).toBe(project.publicKey);
  });

  it('cannot be made by a stranger, and is bound to its reader, project and key version', async () => {
    const { project, voucher, reader, proof } = await setup();
    const stranger = await generateKeyPair();
    const strangerKey = await importPrivateKey(stranger.privateKey, 'a stranger');
    const forged = await vouchForProjectKey({
      voucherKey: strangerKey,
      reader: { id: 'credential-1', publicKey: reader.publicKey },
      binding: BINDING,
      projectPublicKey: stranger.publicKey,
    });
    const read = (overrides: Partial<Parameters<typeof vouchedProjectKey>[0]>) =>
      vouchedProjectKey({
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
      { binding: { ...BINDING, projectId: 'project-2' } },
      { binding: { ...BINDING, keyVersion: 2 } },
      { binding: { ...BINDING, accountId: 'account-2' } },
    ]) {
      await expect(read(overrides)).rejects.toMatchObject({ code: 'unreadable' });
    }
    expect(project.publicKey).not.toBe(stranger.publicKey);
  });
});

describe('the owner and a project', () => {
  /** An owner, a service account it paired, and a project that service account created. */
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
    const created = await createProjectKey({
      voucherKey: serviceAccount.privateKey,
      binding: BINDING,
      readers: [{ id: BINDING.accountId, publicKey: account.publicKey }],
    });
    const [grant] = created.grants;
    if (grant === undefined) throw new Error('no grant');
    const owned = { ...BINDING, ownerWrap: grant.wrap, ownerProof: grant.proof, creator };
    return { owner, account, serviceAccount, creator, created, owned };
  };

  it('opens a project a paired service account created, to the key that service account vouched for', async () => {
    const { owner, created, owned } = await setup();

    expect((await openOwnedProject(owner, owned)).publicKey).toBe(created.publicKey);
  });

  it('refuses a project the store forged: a key pair of its own, wrapped to the account', async () => {
    const { owner, account, owned } = await setup();
    const forgedPair = await generateProjectKey();
    const forgedWrap = await wrapProjectKey({
      projectPrivateKey: forgedPair.privateKey,
      readerPublicKey: account.publicKey,
      readerId: BINDING.accountId,
      binding: BINDING,
    });
    const hostKey = await importPrivateKey((await generateKeyPair()).privateKey, 'the host');
    const forgedProof = await vouchForProjectKey({
      voucherKey: hostKey,
      reader: { id: BINDING.accountId, publicKey: account.publicKey },
      binding: BINDING,
      projectPublicKey: forgedPair.publicKey,
    });

    // Its own wrap with the real proof, its own proof, and a creator the vault never endorsed.
    for (const forged of [
      { ...owned, ownerWrap: forgedWrap },
      { ...owned, ownerWrap: forgedWrap, ownerProof: forgedProof },
      { ...owned, creator: { ...owned.creator, publicKey: (await generateKeyPair()).publicKey } },
      { ...owned, creator: { ...owned.creator, endorsement: null } },
      { ...owned, creator: null },
    ]) {
      await expect(openOwnedProject(owner, forged)).rejects.toMatchObject({ code: 'unreadable' });
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

    const publicKey = await vouchedProjectKey({
      proof: grant.keyProof,
      readerKey: reader.privateKey,
      readerId: reader.credentialId,
      vouchers: [account.publicKey],
      binding: BINDING,
    });
    expect(publicKey).toBe(created.publicKey);
    expect(writeOnly.readWrap).toBeNull();
    await expect(
      unwrapProjectKey({
        wrap: grant.readWrap ?? '',
        readerKey: reader.privateKey,
        readerId: reader.credentialId,
        binding: BINDING,
        projectPublicKey: publicKey,
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
