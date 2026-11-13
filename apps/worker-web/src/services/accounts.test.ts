/** The owner's account: made once, opened by a passkey or a password, changed only with the vault open. */
import { MeSchema } from '@baymutt/api';
import { tokenHash } from '@baymutt/keys/wire';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import { call, newAccount, ok, storeWorld, VAULT_PROOF } from '../test-store.ts';
import { keyLike, sealedLike, testWorld } from '../test-support.ts';

/** A login value as the browser derives it: base64 of 32 bytes. */
const authValue = (seed: string) => `${seed.repeat(43).slice(0, 43)}=`;

describe('the account', () => {
  it('does not exist until the signed-in user makes it, and then holds the first passkey’s wrap', async () => {
    const w = testWorld();
    const user = w.user();
    const session = w.signIn(user.id);
    const id = crypto.randomUUID();

    expect(await call(w, 'GET', '/account', session)).toEqual({
      status: 200,
      body: { userId: user.id, email: 'user-1@example.test', account: null },
    });
    expect(await call(w, 'GET', '/me', session)).toMatchObject({
      status: 409,
      body: { code: 'AccountRequiredError' },
    });

    const created = await ok(
      w,
      'POST',
      '/account',
      session,
      await newAccount(id, user.first.credentialId),
      201,
    );

    expect(created).toMatchObject({
      id,
      name: 'Test owner',
      hasPassword: false,
      passkeys: [{ ...user.first, name: 'first', hasWrap: true }],
    });
    expect(await call(w, 'GET', `/account/wraps/${user.first.credentialId}`, session)).toEqual({
      status: 200,
      body: { wrappedDek: sealedLike('wrap') },
    });
    expect(await call(w, 'GET', '/account/recovery', session)).toEqual({
      status: 200,
      body: { recoveryWrappedDek: sealedLike('recovery') },
    });
  });

  it('can be made with a password alone, which then signs in and holds its wrap', async () => {
    const w = testWorld();
    const user = w.user();
    const session = w.signIn(user.id);

    const created = await ok(
      w,
      'POST',
      '/account',
      session,
      {
        ...(await newAccount(crypto.randomUUID(), user.first.credentialId)),
        passkey: null,
        password: { authValue: authValue('a'), wrappedDek: sealedLike('password-wrap') },
      },
      201,
    );

    expect(created).toMatchObject({ hasPassword: true, passkeys: [{ hasWrap: false }] });
    const wrapFor = (letter: string) =>
      call(w, 'POST', '/account/password/wrap', session, { authValue: authValue(letter) });
    expect(await wrapFor('a')).toEqual({
      status: 200,
      body: { wrappedDek: sealedLike('password-wrap') },
    });
    // A session alone is not enough: the wrap goes to whoever knows the password.
    expect(await wrapFor('z')).toMatchObject({
      status: 403,
      body: { code: 'WrongPasswordError' },
    });
    // Better Auth's own credential row, written in the same batch: only a hash of the login value.
    expect(w.sqlite.prepare('SELECT providerId, accountId, password FROM account').all()).toEqual([
      { providerId: 'credential', accountId: user.id, password: `hashed:${authValue('a')}` },
    ]);
  });

  it('a second creation is refused before it touches the password: a link’s session cannot replace it', async () => {
    const w = testWorld();
    const user = w.user();
    const session = w.signIn(user.id);
    const account = {
      ...(await newAccount(crypto.randomUUID(), user.first.credentialId)),
      passkey: null,
      password: { authValue: authValue('a'), wrappedDek: sealedLike('password-wrap') },
    };
    await ok(w, 'POST', '/account', session, account, 201);

    expect(
      await call(w, 'POST', '/account', session, {
        ...account,
        password: { authValue: authValue('z'), wrappedDek: sealedLike('thief-wrap') },
      }),
    ).toMatchObject({ status: 409, body: { code: 'AlreadyExistsError' } });
    expect(w.sqlite.prepare('SELECT password FROM account').all()).toEqual([
      { password: `hashed:${authValue('a')}` },
    ]);
    expect(
      await call(w, 'POST', '/account/password/wrap', session, { authValue: authValue('a') }),
    ).toEqual({ status: 200, body: { wrappedDek: sealedLike('password-wrap') } });
  });

  it('is made once per user, for a passkey that is the user’s own, with something to open it', async () => {
    const { w, user, locked } = await storeWorld();
    const other = w.user('user-2');
    const otherSession = w.signIn(other.id);
    const account = await newAccount(crypto.randomUUID(), user.first.credentialId);

    expect(await call(w, 'POST', '/account', locked, account)).toMatchObject({
      status: 409,
      body: { code: 'AlreadyExistsError' },
    });
    expect(await call(w, 'POST', '/account', otherSession, account)).toMatchObject({
      status: 404,
      body: { code: 'NotFoundError' },
    });
    expect(
      await call(w, 'POST', '/account', otherSession, { ...account, passkey: null }),
    ).toMatchObject({ status: 404, body: { code: 'NotFoundError' } });
  });

  it('refuses a service account’s bearer and a request with no credential', async () => {
    const { w, pair } = await storeWorld();
    const serviceAccount = await pair();

    expect(await call(w, 'GET', '/account', serviceAccount.headers)).toMatchObject({
      status: 403,
      body: { code: 'OwnerRequiredError' },
    });
    expect(await call(w, 'GET', '/account', {})).toMatchObject({
      status: 401,
      body: { code: 'UnauthorizedError' },
    });
  });

  it('takes a session’s write only from the dashboard’s own origin', async () => {
    const { w, owner } = await storeWorld();

    expect(
      await call(
        w,
        'PUT',
        '/account/recovery',
        { ...owner, origin: 'https://evil.example' },
        { recoveryWrappedDek: sealedLike('x') },
      ),
    ).toMatchObject({ status: 401, body: { code: 'UnauthorizedError' } });
  });
});

describe('a session whose vault is locked', () => {
  it('reads, and changes nothing: not the account, not an environment, not a service account', async () => {
    const { w, user, owner, locked, environment, pair } = await storeWorld();
    const environmentId = await environment('app/production');
    const serviceAccount = await pair();
    const second = user.passkey('second');

    // What a magic link gives: enough to look around.
    for (const path of ['/account', '/environments', '/credentials', '/audit']) {
      expect(await call(w, 'GET', path, locked)).toMatchObject({ status: 200 });
    }

    for (const [method, path, body] of [
      ['PUT', `/account/wraps/${second.credentialId}`, { wrappedDek: sealedLike('w') }],
      ['DELETE', `/account/passkeys/${second.passkeyId}`, undefined],
      ['PUT', '/account/recovery', { recoveryWrappedDek: sealedLike('r') }],
      ['PUT', '/account/password', { authValue: authValue('h'), wrappedDek: sealedLike('p') }],
      ['DELETE', '/account/password', undefined],
      ['DELETE', `/environments/${environmentId}`, undefined],
      ['DELETE', `/credentials/${serviceAccount.id}`, undefined],
      [
        'PUT',
        `/environments/${environmentId}/grants/${serviceAccount.id}`,
        { canWrite: true, readWrap: null, keyProof: sealedLike('p'), keyVersion: 1 },
      ],
      [
        'PUT',
        `/environments/${environmentId}/secrets/API_KEY`,
        { version: 1, keyVersion: 1, ciphertext: sealedLike('c', 96) },
      ],
      [
        'POST',
        '/credentials/pair',
        {
          id: crypto.randomUUID(),
          name: 'planted',
          publicKey: keyLike('x'),
          bearerHash: keyLike('y'),
          endorsement: sealedLike('e'),
          welcome: sealedLike('w'),
        },
      ],
    ] as const) {
      expect(await call(w, method, path, locked, body)).toMatchObject({
        status: 403,
        body: { code: 'VaultLockedError' },
      });
    }
    // A proof that is not the vault's is no proof.
    expect(
      await call(w, 'DELETE', `/environments/${environmentId}`, {
        ...locked,
        'x-baymutt-vault-proof': 'a-guess',
      }),
    ).toMatchObject({ status: 403, body: { code: 'VaultLockedError' } });
    expect(await call(w, 'DELETE', `/environments/${environmentId}`, owner)).toMatchObject({
      status: 200,
    });
  });

  it('is told apart by a proof whose hash the account was made with', async () => {
    const { w } = await storeWorld();

    expect(w.sqlite.prepare('SELECT vault_proof_hash FROM store_account').all()).toEqual([
      { vault_proof_hash: await tokenHash(VAULT_PROOF) },
    ]);
  });
});

describe('what opens the vault', () => {
  it('a second passkey signs in at once and opens the vault once it is given a wrap', async () => {
    const { w, user, owner } = await storeWorld();
    const second = user.passkey('second');

    expect(await call(w, 'GET', `/account/wraps/${second.credentialId}`, owner)).toMatchObject({
      status: 404,
      body: { code: 'NotFoundError' },
    });

    const account = await ok<{ passkeys: unknown[] }>(
      w,
      'PUT',
      `/account/wraps/${second.credentialId}`,
      owner,
      { wrappedDek: sealedLike('second-wrap') },
    );

    expect(account.passkeys).toMatchObject([
      { name: 'first', hasWrap: true },
      { name: 'second', hasWrap: true },
    ]);
  });

  it('a password is set, replaced and removed with its wrap, signing every other session out', async () => {
    const { w, user, owner } = await storeWorld();
    const elsewhere = w.signIn(user.id);
    w.sqlite
      .prepare(
        "INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES ('s1', 'x', 'another-device', 'x', 'x', ?)",
      )
      .run(user.id);

    expect(
      await ok(w, 'PUT', '/account/password', owner, {
        authValue: authValue('a'),
        wrappedDek: sealedLike('first-wrap'),
      }),
    ).toMatchObject({ hasPassword: true });
    await ok(w, 'PUT', '/account/password', owner, {
      authValue: authValue('b'),
      wrappedDek: sealedLike('second-wrap'),
    });

    expect(
      await call(w, 'POST', '/account/password/wrap', elsewhere, { authValue: authValue('b') }),
    ).toEqual({ status: 200, body: { wrappedDek: sealedLike('second-wrap') } });
    expect(w.sqlite.prepare('SELECT password FROM account').all()).toEqual([
      { password: `hashed:${authValue('b')}` },
    ]);
    expect(w.sqlite.prepare('SELECT COUNT(*) AS others FROM session').get()).toEqual({ others: 0 });

    expect(await ok(w, 'DELETE', '/account/password', owner)).toMatchObject({ hasPassword: false });
    expect(w.sqlite.prepare('SELECT COUNT(*) AS rows FROM account').get()).toEqual({ rows: 0 });
    expect(
      await call(w, 'POST', '/account/password/wrap', owner, { authValue: authValue('b') }),
    ).toMatchObject({ status: 404 });
  });

  it('never loses its last way in: a passkey goes only while another or a password remains', async () => {
    const { w, user, owner } = await storeWorld();
    const second = user.passkey('second');

    // The second signs in but holds no wrap, so the first is still the only thing that opens the vault.
    expect(
      await call(w, 'DELETE', `/account/passkeys/${user.first.passkeyId}`, owner),
    ).toMatchObject({ status: 409, body: { code: 'LastUnlockError' } });

    await ok(w, 'PUT', '/account/password', owner, {
      authValue: authValue('a'),
      wrappedDek: sealedLike('password-wrap'),
    });
    await ok(w, 'DELETE', `/account/passkeys/${user.first.passkeyId}`, owner);

    // Now the password is the last way in.
    expect(await call(w, 'DELETE', '/account/password', owner)).toMatchObject({
      status: 409,
      body: { code: 'LastUnlockError' },
    });
    expect(w.sqlite.prepare('SELECT passkey_id FROM passkey_wrap').all()).toEqual([]);
    expect(await call(w, 'DELETE', '/account/passkeys/nope', owner)).toMatchObject({ status: 404 });
    expect(second.passkeyId).toBeDefined();
  });

  it('replaces the recovery key’s wrap', async () => {
    const { w, owner } = await storeWorld();

    await ok(w, 'PUT', '/account/recovery', owner, {
      recoveryWrappedDek: sealedLike('new-recovery'),
    });

    expect(await call(w, 'GET', '/account/recovery', owner)).toEqual({
      status: 200,
      body: { recoveryWrappedDek: sealedLike('new-recovery') },
    });
  });
});

describe('a store that predates vouchers', () => {
  it('still reads to a newer client: a missing voucher is null', () => {
    const me = Schema.decodeUnknownSync(MeSchema)({
      accountId: 'a',
      accountName: 'Made up',
      accountPublicKey: keyLike('a'),
      credential: { id: 'c', name: 'ci', parentId: 'l', welcome: null },
    });
    expect(me.credential?.accountVoucher).toBeNull();
  });
});
