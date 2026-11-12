/** `/api/v1/account`: the owner's account and what opens its vault (`Accounts`). */
import { Api, CurrentUser } from '@baymutt/api';
import * as Effect from 'effect/Effect';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import { Accounts } from '../../services/accounts.ts';

export const AccountHandlers = HttpApiBuilder.group(
  Api,
  'account',
  Effect.fn(function* (handlers) {
    const accounts = yield* Accounts;
    return handlers.handleAll({
      get: Effect.fn(function* () {
        const { userId, email } = yield* CurrentUser;
        return { userId, email, account: yield* accounts.get(userId) };
      }),
      create: Effect.fn(function* ({ payload }) {
        const { userId } = yield* CurrentUser;
        return yield* accounts.create({ userId, account: payload });
      }),
      wrap: Effect.fn(function* ({ params }) {
        const { userId } = yield* CurrentUser;
        return yield* accounts.wrap({ userId, credentialId: params.credentialId });
      }),
      putWrap: Effect.fn(function* ({ params, payload }) {
        return yield* accounts.putWrap({
          caller: yield* CurrentUser,
          credentialId: params.credentialId,
          wrappedDek: payload.wrappedDek,
        });
      }),
      removePasskey: Effect.fn(function* ({ params }) {
        return yield* accounts.removePasskey({
          caller: yield* CurrentUser,
          passkeyId: params.passkeyId,
        });
      }),
      passwordWrap: Effect.fn(function* ({ payload }) {
        return yield* accounts.passwordWrap({
          userId: (yield* CurrentUser).userId,
          authValue: payload.authValue,
        });
      }),
      setPassword: Effect.fn(function* ({ payload }) {
        return yield* accounts.setPassword({ caller: yield* CurrentUser, password: payload });
      }),
      removePassword: Effect.fn(function* () {
        return yield* accounts.removePassword(yield* CurrentUser);
      }),
      recoveryWrap: Effect.fn(function* () {
        return yield* accounts.recoveryWrap((yield* CurrentUser).userId);
      }),
      rotateRecovery: Effect.fn(function* ({ payload }) {
        return yield* accounts.rotateRecovery({ caller: yield* CurrentUser, ...payload });
      }),
    });
  }),
);
