// This machine as the store knows it: its key, a client that sends its bearer, and the account it
// was paired with.
import { Api } from '@baymutt/api';
import { type MachineKey, machineKeyFromToken } from '@baymutt/keys';
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

export const NOT_PAIRED =
  'This machine is not paired. Run `baymutt pair` and have the owner approve the link, or set BAYMUTT_KEY.';

export const machineFromToken = Effect.fn('machine.fromToken')(function* (
  token: Redacted.Redacted<string>,
) {
  const { origin } = yield* Settings;
  const key = yield* crypto_(() => machineKeyFromToken(Redacted.value(token)));
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
  /** Whether the key came from the browser that paired this machine, and not from the store. */
  readonly isPinned: boolean;
};

const make = Effect.gen(function* () {
  const store = yield* KeyStore;
  const token = yield* store.read;
  if (Option.isNone(token)) return yield* usage(NOT_PAIRED, 'notPaired');
  const { key, api } = yield* machineFromToken(token.value);
  const state = yield* readState;
  const context = yield* Effect.context<never>();
  return {
    key,
    api,
    vouchers: [
      key.publicKey,
      ...(state.account === undefined ? [] : [state.account.publicKey]),
      ...(key.issuerPublicKey === null ? [] : [key.issuerPublicKey]),
    ],
    account: Effect.gen(function* () {
      if (state.account !== undefined) return { ...state.account, isPinned: true };
      if (store.source !== 'environment') {
        return yield* usage(
          'This machine’s pairing is not finished. Run `baymutt pair` again once the owner has approved it.',
          'notPaired',
        );
      }
      const me = yield* api.credentials.me().pipe(Effect.orDie);
      return { id: me.accountId, publicKey: me.accountPublicKey, isPinned: false };
    }).pipe(Effect.provideContext(context)),
  };
});

export class Machine extends Context.Service<
  Machine,
  {
    readonly key: MachineKey;
    readonly api: HttpApiClient.ForApi<typeof Api>;
    /**
     * The public keys whose word this machine takes for which key is a project's: its own (for a
     * project it created), the account's it was paired with, and the machine's that made it.
     */
    readonly vouchers: ReadonlyArray<string>;
    /**
     * The account this machine belongs to. A paired machine keeps it; one whose key comes from
     * the environment (a CI job) has no state and takes the store's word, which is enough to open
     * what was sealed to it and not enough to wrap a new project's key to. Which key is a
     * project's never rests on it: that is `vouchers`'.
     */
    readonly account: Effect.Effect<Account, ReturnType<typeof usage>>;
  }
>()('@baymutt/cli/Machine') {
  static readonly layer = Layer.effect(Machine, report(make));
  /** For a caller that reports failures itself (`load.ts`). */
  static readonly layerUnreported = Layer.effect(Machine, make);
}
