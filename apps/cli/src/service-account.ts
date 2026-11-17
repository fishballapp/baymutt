// This credential (a CLI login or a service account) as the store knows it: its key, a client that
// sends its bearer, and the account it belongs to.
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
  'Not logged in. Run `baymutt auth login` and have the owner approve the link, or set BAYMUTT_KEY.';

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

/** The account this CLI login belongs to, as the browser that approved it named it at login. */
export type PinnedAccount = {
  readonly id: string;
  readonly name: string;
  readonly publicKey: string;
};

const make = Effect.gen(function* () {
  const store = yield* KeyStore;
  const token = yield* store.read;
  if (Option.isNone(token)) return yield* usage(NOT_LOGGED_IN, 'notLoggedIn');
  const { key, api } = yield* serviceAccountFromToken(token.value);
  const state = yield* readState;
  const issuer = key.issuerPublicKey;
  const isLogin = issuer === null;
  // Fetched only when a proof opens with none of `vouchers`, or a names key needs it.
  const vouchedAccount = yield* Effect.cached(
    Effect.gen(function* () {
      if (issuer === null) return null;
      // Unreachable or refused: no account key, and what needed one fails as it would have.
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
  const pinnedAccount =
    !isLogin || state.account === undefined
      ? Effect.fail(
          usage(
            isLogin
              ? 'This login is not finished. Run `baymutt auth login` again once the owner has approved it.'
              : 'This key comes from a request, so it has no account key pinned at login. Run this from a computer where `baymutt auth login` ran, without BAYMUTT_KEY or BAYMUTT_KEY_FILE.',
            'notLoggedIn',
          ),
        )
      : Effect.succeed<PinnedAccount>(state.account);
  return {
    key,
    api,
    isLogin,
    vouchers: [
      key.publicKey,
      ...(state.account === undefined ? [] : [state.account.publicKey]),
      ...(issuer === null ? [] : [issuer]),
    ],
    vouchedAccount,
    pinnedAccount,
    trustedAccountKey: isLogin
      ? Effect.map(pinnedAccount, account => account.publicKey)
      : Effect.filterOrFail(
          vouchedAccount,
          (account): account is string => account !== null,
          () =>
            usage(
              'Nothing this key trusts vouches for its account’s key, so the names it was handed cannot be opened. Nothing was used.',
              'integrity',
            ),
        ),
  };
});

export class ServiceAccount extends Context.Service<
  ServiceAccount,
  {
    readonly key: ServiceAccountKey;
    readonly api: HttpApiClient.ForApi<typeof Api>;
    /** Made by `baymutt auth login`, so its key names no maker. It lists names and holds no environment. */
    readonly isLogin: boolean;
    /**
     * The public keys whose word this key takes for which key is an environment's: its own, the
     * account's pinned at login, and the CLI login's that asked for it.
     */
    readonly vouchers: ReadonlyArray<string>;
    /**
     * The account's public key as the login that asked for this service account vouched for it,
     * or null for a login. With it, a service account takes the owner's proof of an environment's
     * key, which is what approving a request writes.
     */
    readonly vouchedAccount: Effect.Effect<string | null>;
    /** The CLI login this computer pinned at login; refused for a service account, which has none. */
    readonly pinnedAccount: Effect.Effect<PinnedAccount, ReturnType<typeof usage>>;
    /**
     * The account's public key as this key already trusts it: pinned at login, or vouched for by
     * the login that asked for this service account. Never the one the store serves.
     */
    readonly trustedAccountKey: Effect.Effect<string, ReturnType<typeof usage>>;
  }
>()('@baymutt/cli/ServiceAccount') {
  static readonly layer = Layer.effect(ServiceAccount, report(make));
  /** For a caller that reports failures itself (`load.ts`). */
  static readonly layerUnreported = Layer.effect(ServiceAccount, make);
}
