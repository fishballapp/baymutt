// The owner's account and what opens its vault. Every endpoint here is the dashboard's: a machine's
// bearer is refused.

import { coded, ErrorMessageSchema } from '@internal/effect-api';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import { AlreadyExistsError, NotFoundError } from './errors.ts';
import {
  HashSchema,
  LabelSchema,
  PublicKeySchema,
  SealedSchema,
  TimestampSchema,
} from './fields.ts';
import { AccountRequiredError, Credentials, SignedIn, VaultLockedError } from './guards.ts';

/** A passkey that may sign in. `hasWrap` is whether it can also open the vault: a passkey added on another device gets its wrap the first time the vault is opened beside it. */
export const PasskeySchema = Schema.Struct({
  /** Better Auth's row id: what removal takes. */
  passkeyId: Schema.String,
  /** The WebAuthn credential id, base64url. */
  credentialId: Schema.String,
  name: Schema.NullOr(Schema.String),
  createdAt: TimestampSchema,
  hasWrap: Schema.Boolean,
}).annotate({ identifier: 'Passkey' });
export type Passkey = typeof PasskeySchema.Type;

export const AccountSchema = Schema.Struct({
  id: Schema.String,
  name: LabelSchema,
  publicKey: PublicKeySchema,
  /** The account key's private half, sealed by the vault. */
  encryptedPrivateKey: SealedSchema,
  createdAt: TimestampSchema,
  passkeys: Schema.Array(PasskeySchema),
  /** Whether a password also signs in and opens the vault. */
  hasPassword: Schema.Boolean,
}).annotate({ identifier: 'Account' });
export type Account = typeof AccountSchema.Type;

/** Removing it would leave nothing that opens the vault. */
export class LastUnlockError extends Schema.TaggedError<LastUnlockError>()(
  'LastUnlockError',
  { message: ErrorMessageSchema },
  { httpApiStatus: 409 },
) {}

/** The login value sent is not the password's: nothing is handed over. */
export class WrongPasswordError extends Schema.TaggedError<WrongPasswordError>()(
  'WrongPasswordError',
  { message: ErrorMessageSchema },
  { httpApiStatus: 403 },
) {}

const passkeyWrap = Schema.Struct({
  /** The WebAuthn credential id of the passkey whose PRF output wraps the data key. */
  credentialId: Schema.String,
  wrappedDek: SealedSchema,
});

/** `authValue` is derived from the password in the browser and is what signs in; the password itself never arrives. */
export const AuthValueSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9+/]{43}=$/u),
).annotate({
  description: 'The password’s login value: base64 of 32 bytes, derived in the browser.',
});

const passwordWrap = Schema.Struct({ authValue: AuthValueSchema, wrappedDek: SealedSchema });

const recoveryPayload = Schema.Struct({ recoveryWrappedDek: SealedSchema });

export class AccountGroup extends HttpApiGroup.make('account')
  .add(
    HttpApiEndpoint.get('get', '/account', {
      success: Schema.Struct({
        userId: Schema.String,
        email: Schema.String,
        account: Schema.NullOr(AccountSchema),
      }),
    }),
    HttpApiEndpoint.post('create', '/account', {
      payload: Schema.Struct({
        id: Schema.String,
        name: LabelSchema,
        publicKey: PublicKeySchema,
        encryptedPrivateKey: SealedSchema,
        /** The first way to open the vault: a passkey, a password, or both. At least one. */
        passkey: Schema.NullOr(passkeyWrap),
        password: Schema.NullOr(passwordWrap),
        ...recoveryPayload.fields,
        /** SHA-256 of the vault's proof: what later tells the store this vault is open. */
        vaultProofHash: HashSchema,
      }),
      success: AccountSchema.pipe(HttpApiSchema.status(201)),
      error: [coded(AlreadyExistsError), coded(NotFoundError)],
    }),
    HttpApiEndpoint.get('wrap', '/account/wraps/:credentialId', {
      params: { credentialId: Schema.String },
      success: Schema.Struct({ wrappedDek: SealedSchema }),
      error: [coded(NotFoundError), coded(AccountRequiredError)],
    }),
    HttpApiEndpoint.put('putWrap', '/account/wraps/:credentialId', {
      params: { credentialId: Schema.String },
      payload: Schema.Struct({ wrappedDek: SealedSchema }),
      success: AccountSchema,
      error: [coded(NotFoundError), coded(AccountRequiredError), coded(VaultLockedError)],
    }),
    HttpApiEndpoint.delete('removePasskey', '/account/passkeys/:passkeyId', {
      params: { passkeyId: Schema.String },
      success: AccountSchema,
      error: [
        coded(NotFoundError),
        coded(AccountRequiredError),
        coded(VaultLockedError),
        coded(LastUnlockError),
      ],
    }),
    // A POST that changes nothing: the wrap can be guessed at offline, so it goes only to a
    // caller who already knows the password, never to a session alone.
    HttpApiEndpoint.post('passwordWrap', '/account/password/wrap', {
      payload: Schema.Struct({ authValue: AuthValueSchema }),
      success: Schema.Struct({ wrappedDek: SealedSchema }),
      error: [coded(NotFoundError), coded(AccountRequiredError), coded(WrongPasswordError)],
    }),
    HttpApiEndpoint.put('setPassword', '/account/password', {
      payload: passwordWrap,
      success: AccountSchema,
      error: [coded(AccountRequiredError), coded(VaultLockedError)],
    }),
    HttpApiEndpoint.delete('removePassword', '/account/password', {
      success: AccountSchema,
      error: [coded(AccountRequiredError), coded(VaultLockedError), coded(LastUnlockError)],
    }),
    HttpApiEndpoint.get('recoveryWrap', '/account/recovery', {
      success: Schema.Struct({ recoveryWrappedDek: SealedSchema }),
      error: [coded(AccountRequiredError)],
    }),
    HttpApiEndpoint.put('rotateRecovery', '/account/recovery', {
      payload: recoveryPayload,
      success: AccountSchema,
      error: [coded(AccountRequiredError), coded(VaultLockedError)],
    }),
  )
  .middleware(SignedIn)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Account', exclude: true })) {}
