// This service account as the store knows it: its key, a client that sends its bearer, and the account it
// belongs to.
import { Api } from '@baymutt/api';
import {
  type ServiceAccountKey,
  serviceAccountKeyFromToken,
  vouchedAccountKey,
} from '@baymutt/keys';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpApiClient from 'effect/http-api/HttpApiClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import { crypto_, report, usage } from './errors.ts';
import { KeyStore } from './key-store.ts';
import { readState, Settings } from './settings.ts';

export const NOT_LOGGED_IN =
  'Not logged in. Run `baymutt login` and have the owner approve the link, or set BAYMUTT_KEY.';

export const serviceAccountFromToken = Effect.fn('serviceAccount.fromToken')(function* (
  token: Redacted.Redacted<string>,
) {
  const { origin } = yield* Settings;
  const key = yield* crypto_(() => serviceAccountKeyFromToken(Redacted.value(token)));
  const api = yield* HttpApiClient.make(Api, {
    baseUrl: origin,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.bearerToken(Redacted.make(key.bearer)),
    ),
  });
  return { key, api };
});

export type Account = {
  readonly id: string;
  readonly publicKey: string;
  /** Whether the key came from the browser that approved this service account, and not from the store. */
  readonly isPinned: boolean;
};

const make = Effect.gen(function* () {
  const store = yield* KeyStore;
  const token = yield* store.read;
  if (Option.isNone(token)) return yield* usage(NOT_LOGGED_IN, 'notLoggedIn');
  const { key, api } = yield* serviceAccountFromToken(token.value);
  const state = yield* readState;
  const context = yield* Effect.context<never>();
  const issuer = key.issuerPublicKey;
  // Fetched only when a proof opens with none of `vouchers`, so a load stays two requests.
  const vouchedAccount = yield* Effect.cached(
    Effect.gen(function* () {
      if (issuer === null) return null;
      // Unreachable or refused: no account key, and the proof that needed one fails as it would have.
      const me = yield* api.credentials.me().pipe(Effect.orElseSucceed(() => null));
      const accountVoucher = me?.credential?.accountVoucher ?? null;
      if (me === null || accountVoucher === null) return null;
      return yield* crypto_(() =>
        vouchedAccountKey({
          serviceAccountKey: key.privateKey,
          serviceAccountId: key.credentialId,
          makerPublicKey: issuer,
          accountId: me.accountId,
          accountVoucher,
        }),
      ).pipe(Effect.orElseSucceed(() => null));
    }),
  );
  return {
    key,
    api,
    vouchers: [
      key.publicKey,
      ...(state.account === undefined ? [] : [state.account.publicKey]),
      ...(key.issuerPublicKey === null ? [] : [key.issuerPublicKey]),
    ],
    vouchedAccount,
    account: Effect.gen(function* () {
      if (state.account !== undefined) return { ...state.account, isPinned: true };
      if (store.source !== 'environment') {
        return yield* usage(
          'This login is not finished. Run `baymutt login` again once the owner has approved it.',
          'notLoggedIn',
        );
      }
      const me = yield* api.credentials.me().pipe(Effect.orDie);
      return { id: me.accountId, publicKey: me.accountPublicKey, isPinned: false };
    }).pipe(Effect.provideContext(context)),
  };
});

export class ServiceAccount extends Context.Service<
  ServiceAccount,
  {
    readonly key: ServiceAccountKey;
    readonly api: HttpApiClient.ForApi<typeof Api>;
    /**
     * The public keys whose word this service account takes for which key is an environment's: its own (for an
     * environment it created), the account's it belongs to, and the service account's that made it.
     */
    readonly vouchers: ReadonlyArray<string>;
    /**
     * The account's public key as the login that made this service account vouched for it, or
     * null: a login, or a service account made before its maker wrote one. With it, this service
     * account also takes the owner's proof, for an environment the owner handed it from the dashboard.
     */
    readonly vouchedAccount: Effect.Effect<string | null>;
    /**
     * The account this service account belongs to. A service account made by `baymutt login` keeps it; one whose key comes from
     * `BAYMUTT_KEY` (a CI job) has no state and takes the store's word, which is enough to open
     * what was sealed to it and not enough to wrap a new environment's key to. Which key is an
     * environment's never rests on it: that is `vouchers`'.
     */
    readonly account: Effect.Effect<Account, ReturnType<typeof usage>>;
  }
>()('@baymutt/cli/ServiceAccount') {
  static readonly layer = Layer.effect(ServiceAccount, report(make));
  /** For a caller that reports failures itself (`load.ts`). */
  static readonly layerUnreported = Layer.effect(ServiceAccount, make);
}
