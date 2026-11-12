// Owns `store_account` and `passkey_wrap`: the owner's account, and the vault's data key wrapped
// once per passkey. It also deletes a passkey's row (Better Auth's table) with its wrap, because
// the two must go together.
import {
  type Account,
  AccountRequiredError,
  AlreadyExistsError,
  LastUnlockError,
  NotFoundError,
  VaultLockedError,
  WrongPasswordError,
} from '@baymutt/api';
import * as D1Client from '@effect/sql-d1/D1Client';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import { Auth } from '../platform/auth.ts';
import { Audit } from './audit.ts';

/** A signed-in person and whether their request proved the vault open (`CurrentUser`). */
type Caller = {
  readonly userId: string;
  readonly hasOpenVault: boolean;
  /** The session making the request, which a password change leaves signed in. */
  readonly sessionToken: string;
};

/** A password as the store sees it: the login value derived from it, and the data key wrapped to its key. */
type PasswordWrap = { readonly authValue: string; readonly wrappedDek: string };

const AccountRowSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  publicKey: Schema.String,
  encryptedPrivateKey: Schema.String,
  recoveryWrappedDek: Schema.String,
  passwordWrappedDek: Schema.NullOr(Schema.String),
  vaultProofHash: Schema.String,
  createdAt: Schema.Finite,
});
type AccountRow = typeof AccountRowSchema.Type;

const PasskeyRowSchema = Schema.Struct({
  passkeyId: Schema.String,
  credentialId: Schema.String,
  name: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(Schema.Finite),
  hasWrap: Schema.Finite,
});

type NewAccount = {
  readonly id: string;
  readonly name: string;
  readonly publicKey: string;
  readonly encryptedPrivateKey: string;
  readonly passkey: { readonly credentialId: string; readonly wrappedDek: string } | null;
  readonly password: PasswordWrap | null;
  readonly recoveryWrappedDek: string;
  readonly vaultProofHash: string;
};

const OWNER = { kind: 'owner', name: 'Owner' } as const;

export class Accounts extends Context.Service<
  Accounts,
  {
    /** The account a signed-in user owns, for the guard: every other call names it. */
    readonly ownedBy: (
      userId: string,
    ) => Effect.Effect<
      { readonly accountId: string; readonly vaultProofHash: string },
      AccountRequiredError
    >;
    readonly get: (userId: string) => Effect.Effect<Account | null>;
    /** Once per user, opened by a passkey, a password or both. */
    readonly create: (request: {
      readonly userId: string;
      readonly account: NewAccount;
    }) => Effect.Effect<Account, AlreadyExistsError | NotFoundError>;
    /** The data key wrapped to the password's key, for a caller who sends the password's login value. */
    readonly passwordWrap: (request: {
      readonly userId: string;
      readonly authValue: string;
    }) => Effect.Effect<
      { readonly wrappedDek: string },
      NotFoundError | AccountRequiredError | WrongPasswordError
    >;
    /** Sets or replaces the password: its login value and the data key wrapped to its key, together. */
    readonly setPassword: (request: {
      readonly caller: Caller;
      readonly password: PasswordWrap;
    }) => Effect.Effect<Account, AccountRequiredError | VaultLockedError>;
    readonly removePassword: (
      caller: Caller,
    ) => Effect.Effect<Account, AccountRequiredError | VaultLockedError | LastUnlockError>;
    readonly wrap: (request: {
      readonly userId: string;
      readonly credentialId: string;
    }) => Effect.Effect<{ readonly wrappedDek: string }, NotFoundError | AccountRequiredError>;
    /** Lets one more passkey open the vault. The caller proved it holds the data key by wrapping it. */
    readonly putWrap: (request: {
      readonly caller: Caller;
      readonly credentialId: string;
      readonly wrappedDek: string;
    }) => Effect.Effect<Account, NotFoundError | AccountRequiredError | VaultLockedError>;
    /** The passkey and its wrap, together. Never the last thing that can open the vault. */
    readonly removePasskey: (request: {
      readonly caller: Caller;
      readonly passkeyId: string;
    }) => Effect.Effect<
      Account,
      NotFoundError | AccountRequiredError | VaultLockedError | LastUnlockError
    >;
    readonly recoveryWrap: (
      userId: string,
    ) => Effect.Effect<{ readonly recoveryWrappedDek: string }, AccountRequiredError>;
    readonly rotateRecovery: (request: {
      readonly caller: Caller;
      readonly recoveryWrappedDek: string;
    }) => Effect.Effect<Account, AccountRequiredError | VaultLockedError>;
  }
>()('@baymutt/worker-web/services/Accounts') {
  static readonly layer = Layer.effect(
    Accounts,
    Effect.gen(function* () {
      const sql = yield* D1Client.D1Client;
      const audit = yield* Audit;
      const auth = yield* Auth;

      const findRow = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: AccountRowSchema,
        execute: userId =>
          sql`SELECT id, name, public_key, encrypted_private_key, recovery_wrapped_dek,
                password_wrapped_dek, vault_proof_hash, created_at
              FROM store_account WHERE user_id = ${userId}`,
      });

      const passkeysOf = SqlSchema.findAll({
        Request: Schema.String,
        Result: PasskeyRowSchema,
        execute: userId =>
          sql`SELECT p.id AS passkey_id, p.credentialID AS credential_id, p.name,
                unixepoch(p.createdAt) * 1000 AS created_at, w.passkey_id IS NOT NULL AS has_wrap
              FROM passkey p LEFT JOIN passkey_wrap w ON w.passkey_id = p.id
              WHERE p.userId = ${userId} ORDER BY p.createdAt`,
      });

      const passkeyId = SqlSchema.findOneOption({
        Request: Schema.Struct({ userId: Schema.String, credentialId: Schema.String }),
        Result: Schema.Struct({ id: Schema.String }),
        execute: ({ userId, credentialId }) =>
          sql`SELECT id FROM passkey WHERE userId = ${userId} AND credentialID = ${credentialId}`,
      });

      const view = Effect.fnUntraced(function* (userId: string, row: AccountRow) {
        const passkeys = yield* passkeysOf(userId).pipe(Effect.orDie);
        return {
          id: row.id,
          name: row.name,
          publicKey: row.publicKey,
          encryptedPrivateKey: row.encryptedPrivateKey,
          createdAt: row.createdAt,
          passkeys: passkeys.map(({ hasWrap, createdAt, ...passkey }) => ({
            ...passkey,
            createdAt: createdAt ?? row.createdAt,
            hasWrap: hasWrap !== 0,
          })),
          hasPassword: row.passwordWrappedDek !== null,
        } satisfies Account;
      });

      const required = Effect.fnUntraced(function* (userId: string) {
        const row = yield* findRow(userId).pipe(Effect.orDie);
        if (Option.isNone(row)) {
          return yield* new AccountRequiredError({
            message: 'This sign-in has no vault yet. Finish setting it up in the dashboard.',
          });
        }
        return row.value;
      });

      // What opens the vault changes only from a request that proved the vault open: a session a
      // magic link made can read these routes and change none of them.
      const open = ({ hasOpenVault }: Caller) =>
        hasOpenVault
          ? Effect.void
          : Effect.fail(
              new VaultLockedError({
                message: 'Unlock your vault first: this changes what opens it.',
              }),
            );

      /**
       * The statements that make `authValue` the user's Better Auth password and keep the data key
       * wrapped to the password's key beside it. They go in the caller's batch: the library's own
       * `setPassword` writes through its adapter, which cannot join one, and a password that signs
       * in with no wrap to open (or the reverse) is an account half changed. `when` holds all of
       * them to the batch's own condition: a refused request must not replace a password.
       */
      const passwordStatements = Effect.fnUntraced(function* (
        userId: string,
        accountId: string,
        { authValue, wrappedDek }: PasswordWrap,
        now: number,
        when = sql`TRUE`,
      ) {
        const hash = yield* auth.hashPassword(authValue);
        // Better Auth keeps its dates as ISO strings.
        const at = sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${now} / 1000.0, 'unixepoch')`;
        return [
          sql`DELETE FROM account
              WHERE userId = ${userId} AND providerId = 'credential' AND ${when}`,
          sql`INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
              SELECT ${crypto.randomUUID()}, ${userId}, 'credential', ${userId}, ${hash}, ${at}, ${at}
              WHERE EXISTS (SELECT 1 FROM store_account
                            WHERE id = ${accountId} AND user_id = ${userId}) AND ${when}`,
          sql`UPDATE store_account SET password_wrapped_dek = ${wrappedDek}
              WHERE id = ${accountId} AND user_id = ${userId} AND ${when}`,
        ] as const;
      });

      const passwordHash = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Schema.Struct({ password: Schema.String }),
        execute: userId =>
          sql`SELECT password FROM account
              WHERE userId = ${userId} AND providerId = 'credential' AND password IS NOT NULL`,
      });

      const ownPasskey = Effect.fnUntraced(function* (userId: string, credentialId: string) {
        const found = yield* passkeyId({ userId, credentialId }).pipe(Effect.orDie);
        if (Option.isNone(found)) {
          return yield* new NotFoundError({ message: 'You have no passkey with this id.' });
        }
        return found.value.id;
      });

      return Accounts.of({
        ownedBy: Effect.fn('Accounts.ownedBy')(function* (userId: string) {
          const { id, vaultProofHash } = yield* required(userId);
          return { accountId: id, vaultProofHash };
        }),

        get: Effect.fn('Accounts.get')(function* (userId: string) {
          const row = yield* findRow(userId).pipe(Effect.orDie);
          return Option.isNone(row) ? null : yield* view(userId, row.value);
        }),

        create: Effect.fn('Accounts.create')(function* ({ userId, account }) {
          if (account.passkey === null && account.password === null) {
            return yield* new NotFoundError({
              message: 'A vault needs a passkey or a password to open it.',
            });
          }
          const passkey =
            account.passkey === null
              ? null
              : {
                  id: yield* ownPasskey(userId, account.passkey.credentialId),
                  wrappedDek: account.passkey.wrappedDek,
                };
          const now = yield* Clock.currentTimeMillis;
          const made = sql`EXISTS (SELECT 1 FROM store_account
            WHERE id = ${account.id} AND user_id = ${userId} AND created_at = ${now})`;
          // One batch: the account, what opens it and the log entry, or none. `OR IGNORE` leaves
          // a second attempt for the same user without a row, and everything after is conditioned
          // on this request's own row.
          const [created] = yield* sql
            .batch([
              sql`INSERT OR IGNORE INTO store_account
                    (id, user_id, name, public_key, encrypted_private_key, recovery_wrapped_dek,
                     vault_proof_hash, created_at)
                  VALUES (${account.id}, ${userId}, ${account.name}, ${account.publicKey},
                    ${account.encryptedPrivateKey}, ${account.recoveryWrappedDek},
                    ${account.vaultProofHash}, ${now})
                  RETURNING id`,
              ...(passkey === null
                ? []
                : [
                    sql`INSERT INTO passkey_wrap (passkey_id, account_id, wrapped_dek, created_at)
                        SELECT ${passkey.id}, ${account.id}, ${passkey.wrappedDek}, ${now}
                        WHERE ${made}`,
                  ]),
              ...(account.password === null
                ? []
                : yield* passwordStatements(userId, account.id, account.password, now, made)),
              yield* audit.entry(
                {
                  accountId: account.id,
                  actor: { ...OWNER, id: account.id },
                  action: 'account.create',
                },
                made,
              ),
            ])
            .pipe(Effect.orDie);
          if ((created ?? []).length === 0) {
            return yield* new AlreadyExistsError({ message: 'This sign-in already has a vault.' });
          }
          return yield* view(userId, yield* required(userId).pipe(Effect.orDie));
        }),

        passwordWrap: Effect.fn('Accounts.passwordWrap')(function* ({ userId, authValue }) {
          const { passwordWrappedDek } = yield* required(userId);
          const stored = yield* passwordHash(userId).pipe(Effect.orDie);
          if (passwordWrappedDek === null || Option.isNone(stored)) {
            return yield* new NotFoundError({
              message: 'This account has no password. Unlock with a passkey, or the recovery key.',
            });
          }
          if (!(yield* auth.verifyPassword({ hash: stored.value.password, authValue }))) {
            return yield* new WrongPasswordError({
              message: 'That password does not open this vault.',
            });
          }
          return { wrappedDek: passwordWrappedDek };
        }),

        setPassword: Effect.fn('Accounts.setPassword')(function* ({ caller, password }) {
          yield* open(caller);
          const account = yield* required(caller.userId);
          const now = yield* Clock.currentTimeMillis;
          yield* sql
            .batch([
              ...(yield* passwordStatements(caller.userId, account.id, password, now)),
              // A new password ends every other session: whoever knew the old one is out.
              sql`DELETE FROM session
                  WHERE userId = ${caller.userId} AND token != ${caller.sessionToken}`,
              yield* audit.entry({
                accountId: account.id,
                actor: { ...OWNER, id: account.id },
                action: 'password.set',
              }),
            ])
            .pipe(Effect.orDie);
          return yield* view(caller.userId, {
            ...account,
            passwordWrappedDek: password.wrappedDek,
          });
        }),

        removePassword: Effect.fn('Accounts.removePassword')(function* (caller) {
          yield* open(caller);
          const account = yield* required(caller.userId);
          // One batch, the refusal inside it: a password goes only while a passkey still opens
          // the vault, so two removals at once cannot leave nothing.
          const [removed] = yield* sql
            .batch([
              sql`UPDATE store_account SET password_wrapped_dek = NULL
                  WHERE id = ${account.id}
                    AND EXISTS (SELECT 1 FROM passkey_wrap WHERE account_id = ${account.id})
                  RETURNING id`,
              sql`DELETE FROM account
                  WHERE userId = ${caller.userId} AND providerId = 'credential'
                    AND EXISTS (SELECT 1 FROM store_account
                                WHERE id = ${account.id} AND password_wrapped_dek IS NULL)`,
              yield* audit.entry(
                {
                  accountId: account.id,
                  actor: { ...OWNER, id: account.id },
                  action: 'password.remove',
                },
                sql`EXISTS (SELECT 1 FROM store_account
                            WHERE id = ${account.id} AND password_wrapped_dek IS NULL)`,
              ),
            ])
            .pipe(Effect.orDie);
          if ((removed ?? []).length === 0) {
            return yield* new LastUnlockError({
              message:
                'The password is the only thing that opens the vault. Add a passkey before removing it.',
            });
          }
          return yield* view(caller.userId, { ...account, passwordWrappedDek: null });
        }),

        wrap: Effect.fn('Accounts.wrap')(function* ({ userId, credentialId }) {
          yield* required(userId);
          const rows = yield* sql<{ wrappedDek: string }>`
            SELECT w.wrapped_dek FROM passkey_wrap w JOIN passkey p ON p.id = w.passkey_id
            WHERE p.userId = ${userId} AND p.credentialID = ${credentialId}`.pipe(Effect.orDie);
          const [found] = rows;
          if (found === undefined) {
            return yield* new NotFoundError({
              message:
                'This passkey signs in but cannot open the vault yet. Open the vault with another passkey, or with the recovery key, to add it.',
            });
          }
          return { wrappedDek: found.wrappedDek };
        }),

        putWrap: Effect.fn('Accounts.putWrap')(function* ({ caller, credentialId, wrappedDek }) {
          yield* open(caller);
          const account = yield* required(caller.userId);
          const passkey = yield* ownPasskey(caller.userId, credentialId);
          const now = yield* Clock.currentTimeMillis;
          yield* sql
            .batch([
              sql`INSERT INTO passkey_wrap (passkey_id, account_id, wrapped_dek, created_at)
                  VALUES (${passkey}, ${account.id}, ${wrappedDek}, ${now})
                  ON CONFLICT (passkey_id) DO UPDATE SET wrapped_dek = excluded.wrapped_dek`,
              yield* audit.entry({
                accountId: account.id,
                actor: { ...OWNER, id: account.id },
                action: 'passkey.add',
              }),
            ])
            .pipe(Effect.orDie);
          return yield* view(caller.userId, account);
        }),

        removePasskey: Effect.fn('Accounts.removePasskey')(function* ({ caller, passkeyId: id }) {
          yield* open(caller);
          const account = yield* required(caller.userId);
          // One batch. The delete refuses the last passkey that holds a wrap, inside the
          // statement, so two removals at once cannot both pass; the wrap goes by its foreign key.
          const [removed] = yield* sql
            .batch([
              sql`DELETE FROM passkey
                  WHERE id = ${id} AND userId = ${caller.userId}
                    AND (EXISTS (SELECT 1 FROM passkey_wrap
                                 WHERE account_id = ${account.id} AND passkey_id != ${id})
                         OR EXISTS (SELECT 1 FROM store_account
                                    WHERE id = ${account.id} AND password_wrapped_dek IS NOT NULL))
                  RETURNING id`,
              yield* audit.entry(
                {
                  accountId: account.id,
                  actor: { ...OWNER, id: account.id },
                  action: 'passkey.remove',
                },
                sql`NOT EXISTS (SELECT 1 FROM passkey WHERE id = ${id})`,
              ),
            ])
            .pipe(Effect.orDie);
          if ((removed ?? []).length > 0) return yield* view(caller.userId, account);
          const [own] = yield* sql`SELECT 1 FROM passkey
            WHERE id = ${id} AND userId = ${caller.userId}`.pipe(Effect.orDie);
          if (own === undefined) {
            return yield* new NotFoundError({ message: 'You have no passkey with this id.' });
          }
          return yield* new LastUnlockError({
            message:
              'This passkey is the only thing that opens the vault. Add another, or set a password, before removing it.',
          });
        }),

        recoveryWrap: Effect.fn('Accounts.recoveryWrap')(function* (userId: string) {
          const { recoveryWrappedDek } = yield* required(userId);
          return { recoveryWrappedDek };
        }),

        rotateRecovery: Effect.fn('Accounts.rotateRecovery')(function* ({
          caller,
          recoveryWrappedDek,
        }) {
          yield* open(caller);
          const account = yield* required(caller.userId);
          yield* sql
            .batch([
              sql`UPDATE store_account SET recovery_wrapped_dek = ${recoveryWrappedDek}
                  WHERE id = ${account.id}`,
              yield* audit.entry({
                accountId: account.id,
                actor: { ...OWNER, id: account.id },
                action: 'recovery.rotate',
              }),
            ])
            .pipe(Effect.orDie);
          return yield* view(caller.userId, { ...account, recoveryWrappedDek });
        }),
      });
    }),
  );
}
