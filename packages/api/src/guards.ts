// A caller is the owner (the dashboard's session cookie) or a machine (its bearer). A credential
// that doesn't verify is refused, never downgraded.

import { coded, ErrorMessageSchema } from '@internal/effect-api';
import * as Context from 'effect/Context';
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware';
import * as HttpApiSecurity from 'effect/http-api/HttpApiSecurity';
import * as OpenApi from 'effect/http-api/OpenApi';
import type * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';

export const MachineSecurity = HttpApiSecurity.bearer.pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    'A machine’s bearer (`Authorization: Bearer baymutt_<credentialId>_<secret>`), derived from its machine key.',
  ),
);

// The Worker pins Better Auth to its `__Secure-` cookie name in every environment.
export const SessionSecurity = HttpApiSecurity.apiKey({
  in: 'cookie',
  key: '__Secure-better-auth.session_token',
}).pipe(HttpApiSecurity.annotate(OpenApi.Description, 'The dashboard’s session cookie.'));

export class InvalidRequestError extends Schema.TaggedError<InvalidRequestError>()(
  'InvalidRequestError',
  { message: ErrorMessageSchema },
  { httpApiStatus: 400 },
) {}

export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()(
  'UnauthorizedError',
  { message: ErrorMessageSchema },
  { httpApiStatus: 401 },
) {}

/** The session is real, and has not set its vault up yet. */
export class AccountRequiredError extends Schema.TaggedError<AccountRequiredError>()(
  'AccountRequiredError',
  { message: ErrorMessageSchema },
  { httpApiStatus: 409 },
) {}

/**
 * The session is real and its vault is locked: it may look, and may change nothing. A magic link
 * signs in without opening the vault, so this is what stands between an inbox and the account.
 */
export class VaultLockedError extends Schema.TaggedError<VaultLockedError>()(
  'VaultLockedError',
  { message: ErrorMessageSchema },
  { httpApiStatus: 403 },
) {}

/** Carries the open vault's proof (`vaultProof` in `@baymutt/keys`) on every request from the dashboard that has one. */
export const VAULT_PROOF_HEADER = 'x-baymutt-vault-proof';

/** Only the owner, signed in at the dashboard, may do this: it lets a new party read, or it cannot be undone. */
export class OwnerRequiredError extends Schema.TaggedError<OwnerRequiredError>()(
  'OwnerRequiredError',
  { message: ErrorMessageSchema },
  { httpApiStatus: 403 },
) {}

export type Credential =
  | { readonly _tag: 'Bearer'; readonly bearer: Redacted.Redacted<string> }
  | { readonly _tag: 'Session' }
  | { readonly _tag: 'None' };

export class CurrentCredential extends Context.Service<CurrentCredential, Credential>()(
  '@baymutt/api/CurrentCredential',
) {}

export type OwnerActor = {
  readonly _tag: 'Owner';
  readonly accountId: string;
  readonly userId: string;
};

export type MachineActor = {
  readonly _tag: 'Machine';
  readonly accountId: string;
  readonly credentialId: string;
  readonly name: string;
  /** The machine that made this one, which bounds what it can ever hold. */
  readonly parentId: string | null;
};

export type ActorIdentity = OwnerActor | MachineActor;

export class CurrentActor extends Context.Service<CurrentActor, ActorIdentity>()(
  '@baymutt/api/CurrentActor',
) {}

/** A signed-in person, whether or not their account's vault exists yet. */
export class CurrentUser extends Context.Service<
  CurrentUser,
  {
    readonly userId: string;
    readonly email: string;
    /** Whether the request proved the account's vault is open. False too when there is no account yet. */
    readonly hasOpenVault: boolean;
    readonly sessionToken: string;
  }
>()('@baymutt/api/CurrentUser') {}

/** The caller when there is one. A paste link names its own target, so its holder needs no account. */
export class CurrentCaller extends Context.Service<
  CurrentCaller,
  { readonly actor: ActorIdentity | null }
>()('@baymutt/api/CurrentCaller') {}

/**
 * The bearer or the session cookie the request sends, or neither. It only picks: a credential that
 * doesn't verify must fail in the guard after it, never fall back to the next scheme. Every group
 * attaches it last, so it runs first.
 * @effect-expect-leaking HttpServerRequest ParsedSearchParams RouteContext
 */
export class Credentials extends HttpApiMiddleware.Service<
  Credentials,
  { provides: CurrentCredential }
>()('@baymutt/api/Credentials', {
  error: coded(UnauthorizedError),
  security: { machine: MachineSecurity, session: SessionSecurity },
}) {}

/** The owner with the vault open (a locked session may only read), or a machine of an account. */
export class Authenticated extends HttpApiMiddleware.Service<
  Authenticated,
  { requires: CurrentCredential; provides: CurrentActor }
>()('@baymutt/api/Authenticated', {
  error: [coded(UnauthorizedError), coded(AccountRequiredError), coded(VaultLockedError)],
}) {}

/** A dashboard session; a machine's bearer is refused. */
export class SignedIn extends HttpApiMiddleware.Service<
  SignedIn,
  { requires: CurrentCredential; provides: CurrentUser }
>()('@baymutt/api/SignedIn', { error: [coded(UnauthorizedError), coded(OwnerRequiredError)] }) {}

/** No credential is an anonymous caller; one that doesn't verify is 401, never anonymous. */
export class MaybeAuthenticated extends HttpApiMiddleware.Service<
  MaybeAuthenticated,
  { requires: CurrentCredential; provides: CurrentCaller }
>()('@baymutt/api/MaybeAuthenticated', { error: coded(UnauthorizedError) }) {}

export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
  '@baymutt/api/RequestValidation',
  { error: coded(InvalidRequestError) },
) {}
