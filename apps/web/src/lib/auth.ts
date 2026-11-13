// Better Auth's client behind a service: its calls resolve `{ data, error }` rather than rejecting,
// so each goes through here and fails as an `AuthError`. The client stays inside the layer: its
// inferred type is too large for TypeScript to emit.
import { VAULT_PROOF_HEADER } from '@baymutt/api';
import { passkeyClient } from '@better-auth/passkey/client';
import { createAuthClient } from 'better-auth/client';
import { magicLinkClient } from 'better-auth/client/plugins';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { evaluatePrf, isPrfEnabled, PRF_ENABLE, prfEval, prfOutput } from './prf.ts';

export class AuthError extends Schema.TaggedError<AuthError>()('AuthError', {
  message: Schema.String,
  reason: Schema.Literals(['cancelled', 'no-prf', 'refused']),
}) {}

/** A passkey that just proved itself, and the bytes it gives to wrap the vault's data key. */
export type PasskeyProof = {
  /** The WebAuthn credential id, base64url. */
  readonly credentialId: string;
  readonly prf: Uint8Array;
};

const NO_PRF =
  'This passkey cannot open a vault: its password manager or security key lacks the WebAuthn PRF extension. iCloud Keychain, Google Password Manager, Windows Hello and 1Password all have it. You can use a password instead.';

type Answer<A> = {
  readonly data: A | null;
  readonly error: { readonly message?: string | undefined } | null;
  /** With `returnWebAuthnResponse`, beside `data` and not inside it. */
  readonly webauthn?: unknown;
};

const WebAuthnSchema = Schema.Struct({
  response: Schema.Struct({ id: Schema.String }),
  clientExtensionResults: Schema.Unknown,
});

export class SignIn extends Context.Service<
  SignIn,
  {
    /** Emails a link that signs in, and makes the account when the address is new. */
    readonly sendLink: (link: {
      readonly email: string;
      /** Where the link lands once it has signed in. */
      readonly landOn: '/environments' | '/recover';
    }) => Effect.Effect<void, AuthError>;
    /** `authValue` is what the browser derives from the password; the password is never sent. */
    readonly withPassword: (login: {
      readonly email: string;
      readonly authValue: string;
    }) => Effect.Effect<void, AuthError>;
    readonly withPasskey: Effect.Effect<PasskeyProof, AuthError>;
    /**
     * Registers a passkey for the signed-in user. Once the account has a vault the store wants
     * its proof: a session a magic link made cannot plant a passkey.
     */
    readonly registerPasskey: (vaultProof: string | null) => Effect.Effect<PasskeyProof, AuthError>;
    readonly out: Effect.Effect<void, AuthError>;
  }
>()('@baymutt/web/SignIn') {
  static readonly layer = Layer.sync(SignIn, () => {
    const makeClient = (headers: Record<string, string> = {}) =>
      createAuthClient({
        baseURL: window.location.origin,
        plugins: [passkeyClient(), magicLinkClient()],
        fetchOptions: { headers },
      });
    const client = makeClient();

    const call = <A>(request: () => Promise<Answer<A>>, fallback: string) =>
      Effect.tryPromise({
        try: request,
        catch: () => new AuthError({ message: fallback, reason: 'refused' }),
      }).pipe(
        Effect.flatMap(answer =>
          answer.data !== null && answer.error === null
            ? Effect.succeed(answer)
            : Effect.fail(
                new AuthError({
                  message: answer.error?.message ?? fallback,
                  reason: /cancel/i.test(answer.error?.message ?? '') ? 'cancelled' : 'refused',
                }),
              ),
        ),
      );

    const webauthnOf = (answer: Answer<unknown>) =>
      Schema.decodeUnknownEffect(WebAuthnSchema)(answer.webauthn).pipe(
        Effect.mapError(
          () =>
            new AuthError({
              message: 'The browser did not answer the passkey request.',
              reason: 'refused',
            }),
        ),
      );

    const noPrf = new AuthError({ message: NO_PRF, reason: 'no-prf' });

    return SignIn.of({
      sendLink: Effect.fn('SignIn.sendLink')(function* ({ email, landOn }) {
        yield* call(
          // The address is the name a passkey manager files the passkey under.
          () => client.signIn.magicLink({ email, name: email, callbackURL: landOn }),
          'The sign-in link could not be sent. Try again in a minute.',
        );
      }),

      withPassword: Effect.fn('SignIn.withPassword')(function* ({ email, authValue }) {
        yield* call(
          () => client.signIn.email({ email, password: authValue }),
          'That email and password do not match an account.',
        );
      }),

      withPasskey: Effect.gen(function* () {
        const { response, clientExtensionResults } = yield* webauthnOf(
          yield* call(
            () =>
              client.signIn.passkey({
                extensions: prfEval(),
                returnWebAuthnResponse: true,
              }) as Promise<Answer<unknown>>,
            'Signing in did not finish.',
          ),
        );
        const prf = prfOutput(clientExtensionResults);
        if (prf === null) return yield* noPrf;
        return { credentialId: response.id, prf };
      }).pipe(Effect.withSpan('SignIn.withPasskey')),

      registerPasskey: Effect.fn('SignIn.registerPasskey')(function* (vaultProof: string | null) {
        // The plugin sends call-site options with the verification only, so the proof rides on a
        // client of its own, which puts it on both of the ceremony's requests.
        const registering =
          vaultProof === null ? client : makeClient({ [VAULT_PROOF_HEADER]: vaultProof });
        const { response, clientExtensionResults } = yield* webauthnOf(
          yield* call(
            () =>
              registering.passkey.addPasskey({
                extensions: PRF_ENABLE,
                returnWebAuthnResponse: true,
              }) as Promise<Answer<unknown>>,
            'The passkey was not created.',
          ),
        );
        if (!isPrfEnabled(clientExtensionResults)) return yield* noPrf;
        // A second prompt, for the passkey just made: creation only says the PRF exists.
        const prf = yield* Effect.tryPromise({
          try: () => evaluatePrf(response.id),
          catch: () =>
            new AuthError({
              message:
                'The passkey was created, but the second prompt was dismissed. Try once more.',
              reason: 'cancelled',
            }),
        });
        if (prf === null) return yield* noPrf;
        return { credentialId: response.id, prf };
      }),

      out: Effect.gen(function* () {
        yield* call(() => client.signOut(), 'Could not sign out. Try again.');
        yield* Effect.sync(() => window.location.assign('/signin'));
      }).pipe(Effect.withSpan('SignIn.out')),
    });
  });
}
