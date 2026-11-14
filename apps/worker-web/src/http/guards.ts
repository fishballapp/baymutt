// Declared with the API (`@baymutt/api` guards.ts) so the clients type their errors; implemented
// here over `Auth` (the owner's session) and `Access` (a service account's bearer).
import {
  type ActorIdentity,
  Authenticated,
  type Credential,
  Credentials,
  CurrentActor,
  CurrentCaller,
  CurrentCredential,
  CurrentUser,
  InvalidRequestError,
  MaybeAuthenticated,
  OwnerRequiredError,
  RequestValidation,
  SignedIn,
  UnauthorizedError,
  VAULT_PROOF_HEADER,
  VaultLockedError,
} from '@baymutt/api';
import { tokenHash } from '@baymutt/keys/wire';
import { sessionMaySign } from '@internal/effect-worker';
import * as Effect from 'effect/Effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import { Auth } from '../platform/auth.ts';
import { BaymuttConfig } from '../platform/config.ts';
import { Access } from '../services/access.ts';
import { Accounts } from '../services/accounts.ts';

const isPresent = (credential: Redacted.Redacted<string>) => Redacted.value(credential) !== '';

const withCredential = <A, E, R>(effect: Effect.Effect<A, E, R>, credential: Credential) =>
  Effect.provideService(effect, CurrentCredential, credential);

// Picks the first credential the request sends and verifies nothing, so a bearer that fails can't
// fall over to the session cookie. The session scheme is last and always answers (`None` when
// there is no cookie either).
const CredentialsLive = Layer.succeed(
  Credentials,
  Credentials.of({
    credential: (httpEffect, { credential }) =>
      isPresent(credential)
        ? withCredential(httpEffect, { _tag: 'Bearer', bearer: credential })
        : Effect.fail(
            new UnauthorizedError({ message: 'This request sends no service account bearer.' }),
          ),
    session: (httpEffect, { credential }) =>
      withCredential(httpEffect, isPresent(credential) ? { _tag: 'Session' } : { _tag: 'None' }),
  }),
);

const verifier = Effect.gen(function* () {
  const { origin } = yield* BaymuttConfig;
  return {
    auth: yield* Auth,
    access: yield* Access,
    accounts: yield* Accounts,
    origins: new Set([origin]),
  };
});
type Verifier = Effect.Success<typeof verifier>;

// The session cookie rides every request from its site, so a write counts only from the dashboard.
const session = Effect.fn(function* ({ auth, origins }: Verifier) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!sessionMaySign(request, origins)) {
    return yield* new UnauthorizedError({
      message: 'This session only signs writes from the baymutt dashboard.',
    });
  }
  return yield* auth.signedIn(request.headers);
});

const READS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Whether the request carries the proof that the account's vault is open. */
const provesOpenVault = Effect.fnUntraced(function* (vaultProofHash: string) {
  const { headers } = yield* HttpServerRequest.HttpServerRequest;
  const proof = headers[VAULT_PROOF_HEADER];
  if (proof === undefined) return false;
  return (yield* Effect.promise(() => tokenHash(proof))) === vaultProofHash;
});

const actorOf = Effect.fn(function* (verify: Verifier, credential: Credential) {
  switch (credential._tag) {
    case 'Bearer':
      return yield* verify.access.authenticate(credential.bearer);
    case 'Session': {
      const { userId } = yield* session(verify);
      const { accountId, vaultProofHash } = yield* verify.accounts.ownedBy(userId);
      // A session says who signed in; a magic link can make one. Only the open vault changes
      // anything, so a locked session reads and no more.
      const { method } = yield* HttpServerRequest.HttpServerRequest;
      if (!READS.has(method) && !(yield* provesOpenVault(vaultProofHash))) {
        return yield* new VaultLockedError({
          message:
            'Unlock your vault with a passkey first: a signed-in session alone changes nothing.',
        });
      }
      return { _tag: 'Owner', accountId, userId } satisfies ActorIdentity;
    }
    case 'None':
      return null;
  }
});

const AuthenticatedLive = Layer.effect(
  Authenticated,
  Effect.gen(function* () {
    const verify = yield* verifier;
    return Authenticated.of(
      Effect.fn(function* (httpEffect) {
        const actor = yield* actorOf(verify, yield* CurrentCredential);
        if (actor === null) {
          return yield* new UnauthorizedError({
            message:
              'Send a service account bearer (`Authorization: Bearer …`, from `baymutt login`), or sign in to the dashboard.',
          });
        }
        return yield* Effect.provideService(httpEffect, CurrentActor, actor);
      }),
    );
  }),
);

const SignedInLive = Layer.effect(
  SignedIn,
  Effect.gen(function* () {
    const verify = yield* verifier;
    return SignedIn.of(
      Effect.fn(function* (httpEffect) {
        const credential = yield* CurrentCredential;
        if (credential._tag === 'Bearer') {
          return yield* new OwnerRequiredError({
            message: 'Only the owner, signed in to the dashboard, manages the account.',
          });
        }
        if (credential._tag === 'None') {
          return yield* new UnauthorizedError({ message: 'Sign in with your passkey.' });
        }
        const { userId, email, token } = yield* session(verify);
        const account = yield* Effect.option(verify.accounts.ownedBy(userId));
        return yield* Effect.provideService(httpEffect, CurrentUser, {
          userId,
          email,
          sessionToken: token,
          hasOpenVault:
            Option.isSome(account) && (yield* provesOpenVault(account.value.vaultProofHash)),
        });
      }),
    );
  }),
);

const MaybeAuthenticatedLive = Layer.effect(
  MaybeAuthenticated,
  Effect.gen(function* () {
    const verify = yield* verifier;
    return MaybeAuthenticated.of(
      Effect.fn(function* (httpEffect) {
        // A paste link's holder may be signed in to nothing, to a session with no vault yet, to
        // one whose vault is locked, or carry a cookie for a session that has ended: the link's
        // token then answers for itself. A bearer that fails stays refused.
        const credential = yield* CurrentCredential;
        const actor = yield* actorOf(verify, credential).pipe(
          Effect.catchTags({
            AccountRequiredError: () => Effect.succeed(null),
            VaultLockedError: () => Effect.succeed(null),
            UnauthorizedError: error =>
              credential._tag === 'Session' ? Effect.succeed(null) : Effect.fail(error),
          }),
        );
        return yield* Effect.provideService(httpEffect, CurrentCaller, { actor });
      }),
    );
  }),
);

// A request that fails its schema is `400 InvalidRequestError`; a response that fails ITS schema is
// our bug, so it stays a defect (→ 500).
const RequestValidationLive = HttpApiMiddleware.layerSchemaErrorTransform(
  RequestValidation,
  error =>
    error.kind === 'Body' || error.kind === 'ResponseHeaders'
      ? Effect.die(error)
      : Effect.fail(new InvalidRequestError({ message: `${error.kind}: ${error.cause.message}` })),
);

export const GuardsLive = Layer.mergeAll(
  CredentialsLive,
  AuthenticatedLive,
  SignedInLive,
  MaybeAuthenticatedLive,
  RequestValidationLive,
);
