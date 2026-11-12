// The owner's open vault. A passkey, the password or the recovery key opens it, and it stays open
// in this browser until the owner signs out: the key that opened it is kept (`kept-unlock.ts`)
// and `resume` opens the vault with it again after a reload. Everything that needs the vault
// takes it as an argument.
import type { Account } from '@baymutt/api';
import {
  createAccountKey,
  createVault,
  derivePasskeyEncKey,
  derivePasswordKeys,
  generateRecoveryKey,
  type OwnerKeys,
  openAccountKey,
  openVault,
  recoveryVaultKey,
  rewrapDek,
  tokenHash,
  VaultError,
  type VaultKey,
  vaultProof,
} from '@baymutt/keys';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { create } from 'zustand';
import { ApiClient, faultsAsDefects, provideVaultProof } from './api.ts';
import { type PasskeyProof, SignIn } from './auth.ts';
import { forgetUnlock, keepUnlock, keptUnlock } from './kept-unlock.ts';

/** The unlocked account: its keys, the proof the store asks for, and what re-wraps the data key. */
export type Owner = OwnerKeys & {
  readonly accountName: string;
  readonly email: string;
  /** Sent with every request while the vault is open (`VAULT_PROOF_HEADER`). */
  readonly proof: string;
  readonly unlockedWith: VaultKey;
  readonly wrappedDek: string;
};

export const useOwnerStore = create<{ readonly owner: Owner | null }>(() => ({ owner: null }));

provideVaultProof(() => useOwnerStore.getState().owner?.proof ?? null);

/** A key, a wrap or a record that did not authenticate, or a password that is not the one. */
export class OwnerError extends Schema.TaggedError<OwnerError>()('OwnerError', {
  message: Schema.String,
}) {}

/** A promise from `@baymutt/keys`: its rejection is a `VaultError`, or a fault. */
export const keys = <A>(run: () => Promise<A>, refusal?: string): Effect.Effect<A, OwnerError> =>
  Effect.tryPromise(run).pipe(
    Effect.catchTag('UnknownError', ({ cause }) =>
      cause instanceof VaultError
        ? Effect.fail(
            new OwnerError({ message: refusal ?? `${cause.message}. Nothing was changed.` }),
          )
        : Effect.die(cause),
    ),
  );

const passkeyKey = (proof: PasskeyProof) =>
  keys(async (): Promise<VaultKey> => ({ encKey: await derivePasskeyEncKey(proof.prf) }));

/** What a password gives: the value that signs in, and the key that opens the vault. About a second of work. */
const passwordKeys = (email: string, password: string) =>
  keys(() => derivePasswordKeys({ email, password }));

const opened = Effect.fnUntraced(function* (
  { account, email }: { readonly account: Account; readonly email: string },
  unlockedWith: VaultKey,
  wrappedDek: string,
  refusal?: string,
) {
  const owner = yield* keys(async (): Promise<Owner> => {
    const vault = await openVault(unlockedWith, wrappedDek);
    return {
      vault,
      accountId: account.id,
      accountName: account.name,
      email,
      accountKey: await openAccountKey(vault, account),
      proof: await vaultProof(vault, account.id),
      unlockedWith,
      wrappedDek,
    };
  }, refusal);
  yield* Effect.sync(() => useOwnerStore.setState({ owner }));
  return owner;
});

// A browser that refuses IndexedDB keeps nothing: the vault then locks on a reload, and the
// owner opens it again.
const keep = (owner: Owner) =>
  Effect.ignore(
    Effect.tryPromise(() =>
      keepUnlock({
        accountId: owner.accountId,
        unlockedWith: owner.unlockedWith,
        wrappedDek: owner.wrappedDek,
      }),
    ),
  );

const forget = Effect.ignore(Effect.tryPromise(forgetUnlock));

/** Opens the vault and keeps it open in this browser until `signOut`. */
const unlocked = Effect.fnUntraced(function* (
  session: { readonly account: Account; readonly email: string },
  unlockedWith: VaultKey,
  wrappedDek: string,
  refusal?: string,
) {
  const owner = yield* opened(session, unlockedWith, wrappedDek, refusal);
  yield* keep(owner);
  return owner;
});

const session = ApiClient.use(client => client.account.get());

const withSignIn = Effect.provide(SignIn.layer);

/** How a new vault is first opened. */
export type FirstUnlock =
  | { readonly _tag: 'Passkey' }
  | { readonly _tag: 'Password'; readonly password: string };

/**
 * The vault and the account, for a user a magic link just signed in. A passkey or a password
 * opens it from now on; the recovery key comes back to be shown once.
 */
export const setUp = Effect.fn('owner.setUp')(
  function* ({ name, unlock }: { readonly name: string; readonly unlock: FirstUnlock }) {
    const { email } = yield* session;
    const first = yield* Effect.gen(function* () {
      if (unlock._tag === 'Password') {
        const { authValue, encKey } = yield* passwordKeys(email, unlock.password);
        return { unlockedWith: { encKey }, authValue, credentialId: null };
      }
      const proof = yield* (yield* SignIn).registerPasskey(null);
      return {
        unlockedWith: yield* passkeyKey(proof),
        authValue: null,
        credentialId: proof.credentialId,
      };
    });
    const id = crypto.randomUUID();
    const recoveryKey = generateRecoveryKey();
    const made = yield* keys(async () => {
      const { vault, wrappedDek } = await createVault(first.unlockedWith);
      return {
        wrappedDek,
        account: await createAccountKey(vault),
        recoveryWrappedDek: await rewrapDek(
          first.unlockedWith,
          await recoveryVaultKey(recoveryKey),
          wrappedDek,
        ),
        vaultProofHash: await tokenHash(await vaultProof(vault, id)),
      };
    });
    const account = yield* ApiClient.use(client =>
      client.account.create({
        payload: {
          id,
          name,
          ...made.account,
          passkey:
            first.credentialId === null
              ? null
              : { credentialId: first.credentialId, wrappedDek: made.wrappedDek },
          password:
            first.authValue === null
              ? null
              : { authValue: first.authValue, wrappedDek: made.wrappedDek },
          recoveryWrappedDek: made.recoveryWrappedDek,
          vaultProofHash: made.vaultProofHash,
        },
      }),
    );
    yield* unlocked({ account, email }, first.unlockedWith, made.wrappedDek);
    return { recoveryKey };
  },
  faultsAsDefects,
  withSignIn,
);

const NO_VAULT = new OwnerError({
  message:
    'This account has no vault yet. Sign in with the link we emailed to finish setting it up.',
});

/** Signs in and opens the vault with one gesture. Also how a locked session unlocks. */
export const signInWithPasskey = Effect.fn('owner.signInWithPasskey')(
  function* () {
    const proof = yield* (yield* SignIn).withPasskey;
    const { account, email } = yield* session;
    if (account === null) return yield* NO_VAULT;
    const { wrappedDek } = yield* ApiClient.use(client =>
      client.account.wrap({ params: { credentialId: proof.credentialId } }),
    );
    yield* unlocked({ account, email }, yield* passkeyKey(proof), wrappedDek);
  },
  faultsAsDefects,
  withSignIn,
);

const WRONG_PASSWORD = 'That password does not open this vault.';

/** Opens the vault of the session that is already signed in. */
const unlockWithKeys = Effect.fnUntraced(function* ({
  authValue,
  encKey,
}: VaultKey & { readonly authValue: string }) {
  const { account, email } = yield* session;
  if (account === null) return yield* NO_VAULT;
  // The store hands the wrap only to the password's own login value.
  const { wrappedDek } = yield* ApiClient.use(client =>
    client.account.passwordWrap({ payload: { authValue } }),
  );
  yield* unlocked({ account, email }, { encKey }, wrappedDek, WRONG_PASSWORD);
});

/** Email and password: one derivation signs in and opens the vault. */
export const signInWithPassword = Effect.fn('owner.signInWithPassword')(
  function* ({ email, password }: { readonly email: string; readonly password: string }) {
    const { authValue, encKey } = yield* passwordKeys(email, password);
    yield* (yield* SignIn).withPassword({ email, authValue });
    yield* unlockWithKeys({ authValue, encKey });
  },
  faultsAsDefects,
  withSignIn,
);

/** For a session that is signed in with its vault locked: the password alone, no second sign-in. */
export const unlockWithPassword = Effect.fn('owner.unlockWithPassword')(function* (
  password: string,
) {
  const { email } = yield* session;
  yield* unlockWithKeys(yield* passwordKeys(email, password));
}, faultsAsDefects);

/** A new recovery key in place of the old one, which stops working. */
export const rotateRecoveryKey = Effect.fn('owner.rotateRecoveryKey')(function* (owner: Owner) {
  const recoveryKey = generateRecoveryKey();
  const recoveryWrappedDek = yield* keys(async () =>
    rewrapDek(owner.unlockedWith, await recoveryVaultKey(recoveryKey), owner.wrappedDek),
  );
  yield* ApiClient.use(client =>
    client.account.rotateRecovery({ payload: { recoveryWrappedDek } }),
  );
  return { recoveryKey };
}, faultsAsDefects);

/**
 * Every passkey and the password are lost: a magic link signed in, and the recovery key opens the
 * vault. The key is then spent and a new one comes back to be shown; the owner sets a new
 * password or passkey from the account page, with the vault open.
 */
export const recover = Effect.fn('owner.recover')(function* (recoveryKey: string) {
  const { account, email } = yield* session;
  if (account === null) return yield* NO_VAULT;
  const { recoveryWrappedDek } = yield* ApiClient.use(client => client.account.recoveryWrap());
  const unlockedWith = yield* keys(() => recoveryVaultKey(recoveryKey));
  const owner = yield* unlocked(
    { account, email },
    unlockedWith,
    recoveryWrappedDek,
    'That recovery key does not open this vault.',
  );
  return yield* rotateRecoveryKey(owner);
}, faultsAsDefects);

/** One more passkey that signs in and opens this vault. */
export const addPasskey = Effect.fn('owner.addPasskey')(
  function* (owner: Owner) {
    const proof = yield* (yield* SignIn).registerPasskey(owner.proof);
    const to = yield* passkeyKey(proof);
    const wrappedDek = yield* keys(() => rewrapDek(owner.unlockedWith, to, owner.wrappedDek));
    return yield* ApiClient.use(client =>
      client.account.putWrap({
        params: { credentialId: proof.credentialId },
        payload: { wrappedDek },
      }),
    );
  },
  faultsAsDefects,
  withSignIn,
);

/** Sets or replaces the password that signs in and opens this vault. */
export const setPassword = Effect.fn('owner.setPassword')(function* ({
  owner,
  password,
}: {
  readonly owner: Owner;
  readonly password: string;
}) {
  const { authValue, encKey } = yield* passwordKeys(owner.email, password);
  const wrappedDek = yield* keys(() => rewrapDek(owner.unlockedWith, { encKey }, owner.wrappedDek));
  return yield* ApiClient.use(client =>
    client.account.setPassword({ payload: { authValue, wrappedDek } }),
  );
}, faultsAsDefects);

export const sendLink = Effect.fn('owner.sendLink')(function* (link: {
  readonly email: string;
  readonly landOn: '/projects' | '/recover';
}) {
  yield* (yield* SignIn).sendLink(link);
}, withSignIn);

/**
 * After a page load: opens the vault with the key this browser kept, when the session is still
 * the same account's. A session that ended, another account or a key that no longer opens
 * anything forgets the key, and the owner unlocks by hand.
 */
export const resume = Effect.fn('owner.resume')(function* () {
  const kept = yield* Effect.orElseSucceed(Effect.tryPromise(keptUnlock), () => null);
  if (kept === null) return;
  yield* Effect.gen(function* () {
    const { account, email } = yield* session;
    if (account?.id !== kept.accountId) return yield* forget;
    yield* opened({ account, email }, kept.unlockedWith, kept.wrappedDek);
  }).pipe(
    faultsAsDefects,
    Effect.catch(() => forget),
  );
});

export const signOut = Effect.fn('owner.signOut')(function* () {
  yield* forget;
  yield* (yield* SignIn).out;
}, withSignIn);
