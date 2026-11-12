// The API definition (`@baymutt/api`) derives this client, so a contract change is a compile
// error here. The dashboard and the API share an origin: the session cookie rides along by
// default and nothing is cross-origin.
import { Api, VAULT_PROOF_HEADER } from '@baymutt/api';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientError from 'effect/http/HttpClientError';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as Layer from 'effect/Layer';
import * as Predicate from 'effect/Predicate';
import * as Atom from 'effect/reactivity/Atom';
import * as AtomHttpApi from 'effect/reactivity/AtomHttpApi';
import * as Schema from 'effect/Schema';

// No request carries `b3` / `traceparent`: the dashboard exports no traces.
Atom.runtime.addGlobalLayer(Layer.succeed(HttpClient.TracerPropagationEnabled, false));

/** Pages a visitor may be on with no session: a refusal there is theirs to show. */
const isPublicPage = () =>
  window.location.pathname === '/signin' ||
  window.location.pathname === '/signup' ||
  window.location.pathname === '/recover' ||
  window.location.pathname.startsWith('/paste/');

let vaultProofNow: () => string | null = () => null;

/** Lets the owner's store say what the open vault's proof is, without this module importing it. */
export const provideVaultProof = (read: () => string | null) => {
  vaultProofNow = read;
};

// A session that ended under an open vault sends the browser to sign in as a full page load, so
// nothing of it, the vault least of all, lingers in memory. With no vault open there is nothing to
// clear, and the gate shows sign-in where the visitor is: a pairing link keeps its fragment.
const toSignInWhenUnauthorized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(Predicate.isTagged('UnauthorizedError'), error =>
      isPublicPage() || vaultProofNow() === null
        ? Effect.fail(error)
        : Effect.sync(() => window.location.assign('/signin')).pipe(Effect.andThen(Effect.never)),
    ),
  );

export class ApiClient extends AtomHttpApi.Service<ApiClient>()('@baymutt/web/ApiClient', {
  api: Api,
  httpClient: FetchHttpClient.layer,
  baseUrl: window.location.origin,
  // While the vault is open every request shows its proof: the store lets a session change
  // something only then. Read at send time, as the session cookie is, and never by an atom.
  transformClient: HttpClient.mapRequest(request => {
    const proof = vaultProofNow();
    return proof === null
      ? request
      : HttpClientRequest.setHeader(request, VAULT_PROOF_HEADER, proof);
  }),
  transformResponse: toSignInWhenUnauthorized,
}) {}

// A lost connection or a response that fails its schema is a fault, so it dies. A view then shows
// an error's `message` only when the API sent it, and its own fallback for anything else.
export const faultsAsDefects = <A, E, R>(
  effect: Effect.Effect<A, E | HttpClientError.HttpClientError | Schema.SchemaError, R>,
): Effect.Effect<A, E, R> =>
  Effect.catchIf(
    effect,
    (error): error is HttpClientError.HttpClientError | Schema.SchemaError =>
      HttpClientError.isHttpClientError(error) || Schema.isSchemaError(error),
    Effect.die,
  );
