import {
  decodePublicKey,
  fromBase64,
  generateKeyPair,
  importPrivateKey,
  openVouched,
  utf8,
} from '@internal/zk-vault';
import { describe, expect, it } from 'vitest';
import {
  MAX_HINT_BYTES,
  MAX_NOTE_BYTES,
  openHint,
  openNote,
  openProposedValue,
  sealHint,
  sealNote,
  sealProposedValue,
} from './index.ts';

const SLOT = {
  askId: 'ask-1',
  stepIndex: 2,
  environmentId: 'environment-1',
  name: 'STRIPE_SECRET_KEY',
};
const STEP = { askId: 'ask-1', stepIndex: 2, decision: 'rejected' } as const;

/** The longest base64 text `base64(maxBytes)` in `@baymutt/api` takes. */
const base64Bound = (maxBytes: number) => Math.ceil(maxBytes / 3) * 4;

const party = async (what: string) => {
  const pair = await generateKeyPair();
  return { publicKey: pair.publicKey, key: await importPrivateKey(pair.privateKey, what) };
};

const setUp = async () => ({
  account: await party('the account'),
  login: await party('the login'),
  stranger: await party('a stranger'),
});

describe('a proposed value', () => {
  it('opens in the owner’s browser to what the login proposed, multi-line and all', async () => {
    const { account, login } = await setUp();
    const value = 'line one\nline two ✓';
    const ciphertext = await sealProposedValue({
      loginKey: login.key,
      accountPublicKey: account.publicKey,
      slot: SLOT,
      value,
    });

    expect(
      await openProposedValue({
        accountKey: account.key,
        loginPublicKey: login.publicKey,
        slot: SLOT,
        ciphertext,
      }),
    ).toBe(value);
  });

  it('is refused unless the login it is opened as sealed it: the store cannot make one', async () => {
    const { account, login, stranger } = await setUp();
    const forged = await sealProposedValue({
      loginKey: stranger.key,
      accountPublicKey: account.publicKey,
      slot: SLOT,
      value: 'the store’s value',
    });

    await expect(
      openProposedValue({
        accountKey: account.key,
        loginPublicKey: login.publicKey,
        slot: SLOT,
        ciphertext: forged,
      }),
    ).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('is bound to its ask, step, environment and secret name', async () => {
    const { account, login } = await setUp();
    const ciphertext = await sealProposedValue({
      loginKey: login.key,
      accountPublicKey: account.publicKey,
      slot: SLOT,
      value: 'a value',
    });

    for (const slot of [
      { ...SLOT, askId: 'ask-2' },
      { ...SLOT, stepIndex: 3 },
      { ...SLOT, environmentId: 'environment-2' },
      { ...SLOT, name: 'STRIPE_PUBLISHABLE_KEY' },
    ]) {
      await expect(
        openProposedValue({
          accountKey: account.key,
          loginPublicKey: login.publicKey,
          slot,
          ciphertext,
        }),
      ).rejects.toMatchObject({ code: 'unreadable' });
    }
  });

  it('takes up to 64 KiB, which seals within the API’s bound, and refuses more before sealing', async () => {
    const { account, login } = await setUp();
    const seal = (value: string) =>
      sealProposedValue({
        loginKey: login.key,
        accountPublicKey: account.publicKey,
        slot: SLOT,
        value,
      });

    // ProposedValueSchema: base64 of at most MAX_VALUE_BYTES + 60 bytes.
    expect((await seal('x'.repeat(65_536))).length).toBeLessThanOrEqual(base64Bound(65_536 + 60));
    // Counted in UTF-8 bytes, not characters: 21,846 three-byte characters are 65,538 bytes.
    await expect(seal('✓'.repeat(21_846))).rejects.toMatchObject({ code: 'malformed' });
    await expect(seal('x'.repeat(65_537))).rejects.toMatchObject({ code: 'malformed' });
  });

  // The label and binding, pinned: changing either strands every proposal waiting on an ask.
  it('is sealed under `baymutt-proposed-value`, bound to [askId, stepIndex, environmentId, name]', async () => {
    const { account, login } = await setUp();
    const ciphertext = await sealProposedValue({
      loginKey: login.key,
      accountPublicKey: account.publicKey,
      slot: SLOT,
      value: 'a value',
    });

    const pinned = await openVouched({
      recipient: account.key,
      sender: decodePublicKey(login.publicKey, 'the login'),
      info: 'baymutt-proposed-value',
      aad: utf8(JSON.stringify(['ask-1', '2', 'environment-1', 'STRIPE_SECRET_KEY'])),
      box: fromBase64(ciphertext, 'the proposal'),
      what: 'the proposal',
    });
    expect(new TextDecoder().decode(pinned)).toBe('a value');
  });
});

describe('a note', () => {
  it('opens for the login to what the owner wrote', async () => {
    const { account, login } = await setUp();
    const note = 'Use the test-mode key, not live.';
    const ciphertext = await sealNote({
      accountKey: account.key,
      loginPublicKey: login.publicKey,
      step: STEP,
      note,
    });

    expect(
      await openNote({
        loginKey: login.key,
        accountPublicKey: account.publicKey,
        step: STEP,
        ciphertext,
      }),
    ).toBe(note);
  });

  it('is refused unless the account key the login pinned sealed it: the store cannot write one', async () => {
    const { account, login, stranger } = await setUp();
    const forged = await sealNote({
      accountKey: stranger.key,
      loginPublicKey: login.publicKey,
      step: STEP,
      note: 'Paste your key here instead.',
    });

    await expect(
      openNote({
        loginKey: login.key,
        accountPublicKey: account.publicKey,
        step: STEP,
        ciphertext: forged,
      }),
    ).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('is bound to its ask, its step and the decision it came with', async () => {
    const { account, login } = await setUp();
    const ciphertext = await sealNote({
      accountKey: account.key,
      loginPublicKey: login.publicKey,
      step: STEP,
      note: 'a note',
    });

    for (const step of [
      { ...STEP, askId: 'ask-2' },
      { ...STEP, stepIndex: 3 },
      { ...STEP, decision: 'approved' as const },
    ]) {
      await expect(
        openNote({ loginKey: login.key, accountPublicKey: account.publicKey, step, ciphertext }),
      ).rejects.toMatchObject({ code: 'unreadable' });
    }
  });

  it('takes up to 2048 bytes of UTF-8, which seals within the API’s bound, and refuses more before sealing', async () => {
    const { account, login } = await setUp();
    const seal = (note: string) =>
      sealNote({ accountKey: account.key, loginPublicKey: login.publicKey, step: STEP, note });

    expect(MAX_NOTE_BYTES).toBe(2048);
    // SealedNoteSchema: base64 of at most 2048 + 60 bytes.
    expect((await seal('x'.repeat(2048))).length).toBeLessThanOrEqual(base64Bound(2048 + 60));
    // 683 three-byte characters are 2049 bytes.
    await expect(seal('✓'.repeat(683))).rejects.toMatchObject({ code: 'malformed' });
    await expect(seal('x'.repeat(2049))).rejects.toMatchObject({ code: 'malformed' });
  });

  // The label and binding, pinned: changing either strands every note already written.
  it('is sealed under `baymutt-decision-note`, bound to [askId, stepIndex, decision]', async () => {
    const { account, login } = await setUp();
    const ciphertext = await sealNote({
      accountKey: account.key,
      loginPublicKey: login.publicKey,
      step: STEP,
      note: 'a note',
    });

    const pinned = await openVouched({
      recipient: login.key,
      sender: decodePublicKey(account.publicKey, 'the account'),
      info: 'baymutt-decision-note',
      aad: utf8(JSON.stringify(['ask-1', '2', 'rejected'])),
      box: fromBase64(ciphertext, 'the note'),
      what: 'the note',
    });
    expect(new TextDecoder().decode(pinned)).toBe('a note');
  });
});

describe('a hint', () => {
  const sealOne = (
    { login, account }: Awaited<ReturnType<typeof setUp>>,
    hint = 'Stripe dashboard, Developers, API keys',
  ) => sealHint({ loginKey: login.key, accountPublicKey: account.publicKey, slot: SLOT, hint });

  it('opens in the owner’s browser to what the login wrote', async () => {
    const parties = await setUp();
    const ciphertext = await sealOne(parties, 'Stripe → Developers ✓');

    expect(
      await openHint({
        accountKey: parties.account.key,
        loginPublicKey: parties.login.publicKey,
        slot: SLOT,
        ciphertext,
      }),
    ).toBe('Stripe → Developers ✓');
  });

  it('is refused unless the login it is opened as sealed it: the store cannot make one', async () => {
    const { account, login, stranger } = await setUp();
    const forged = await sealHint({
      loginKey: stranger.key,
      accountPublicKey: account.publicKey,
      slot: SLOT,
      hint: 'Paste it at evil.example',
    });

    await expect(
      openHint({
        accountKey: account.key,
        loginPublicKey: login.publicKey,
        slot: SLOT,
        ciphertext: forged,
      }),
    ).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('is bound to its ask, step, environment and secret name', async () => {
    const parties = await setUp();
    const ciphertext = await sealOne(parties);

    for (const slot of [
      { ...SLOT, askId: 'ask-2' },
      { ...SLOT, stepIndex: 3 },
      { ...SLOT, environmentId: 'environment-2' },
      { ...SLOT, name: 'STRIPE_PUBLISHABLE_KEY' },
    ]) {
      await expect(
        openHint({
          accountKey: parties.account.key,
          loginPublicKey: parties.login.publicKey,
          slot,
          ciphertext,
        }),
      ).rejects.toMatchObject({ code: 'unreadable' });
    }
  });

  it('cannot be opened as a proposed value or a note, nor either of them as a hint', async () => {
    const parties = await setUp();
    const { account, login } = parties;
    const hint = await sealOne(parties);
    const proposed = await sealProposedValue({
      loginKey: login.key,
      accountPublicKey: account.publicKey,
      slot: SLOT,
      value: 'a value',
    });
    const note = await sealNote({
      accountKey: account.key,
      loginPublicKey: login.publicKey,
      step: STEP,
      note: 'a note',
    });
    const asHint = (ciphertext: string) =>
      openHint({
        accountKey: account.key,
        loginPublicKey: login.publicKey,
        slot: SLOT,
        ciphertext,
      });

    await expect(
      openProposedValue({
        accountKey: account.key,
        loginPublicKey: login.publicKey,
        slot: SLOT,
        ciphertext: hint,
      }),
    ).rejects.toMatchObject({ code: 'unreadable' });
    await expect(
      openNote({
        loginKey: login.key,
        accountPublicKey: account.publicKey,
        step: STEP,
        ciphertext: hint,
      }),
    ).rejects.toMatchObject({ code: 'unreadable' });
    await expect(asHint(proposed)).rejects.toMatchObject({ code: 'unreadable' });
    await expect(asHint(note)).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('takes up to 1500 bytes of UTF-8, 500 characters of any kind, within the API’s bound, and refuses more before sealing', async () => {
    const parties = await setUp();

    expect(MAX_HINT_BYTES).toBe(1500);
    // SealedHintSchema: base64 of at most 1500 + 60 bytes.
    expect((await sealOne(parties, '✓'.repeat(500))).length).toBeLessThanOrEqual(
      base64Bound(1500 + 60),
    );
    await expect(sealOne(parties, '✓'.repeat(501))).rejects.toMatchObject({ code: 'malformed' });
    await expect(sealOne(parties, 'x'.repeat(1501))).rejects.toMatchObject({ code: 'malformed' });
  });

  // The label and binding, pinned: changing either strands every hint waiting on an ask.
  it('is sealed under `baymutt-paste-hint`, bound to [askId, stepIndex, environmentId, name]', async () => {
    const parties = await setUp();
    const ciphertext = await sealOne(parties, 'a hint');

    const pinned = await openVouched({
      recipient: parties.account.key,
      sender: decodePublicKey(parties.login.publicKey, 'the login'),
      info: 'baymutt-paste-hint',
      aad: utf8(JSON.stringify(['ask-1', '2', 'environment-1', 'STRIPE_SECRET_KEY'])),
      box: fromBase64(ciphertext, 'the hint'),
      what: 'the hint',
    });
    expect(new TextDecoder().decode(pinned)).toBe('a hint');
  });
});
