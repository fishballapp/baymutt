// A Better Auth call that throws is a fault (a defect, so 500); no session comes back as an error
// the guards answer 401 with.
import { UnauthorizedError } from '@baymutt/api';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import type * as HttpHeaders from 'effect/http/Headers';
import * as Layer from 'effect/Layer';
import { AuthConfig, type MakeBetterAuth, makeBetterAuth } from './better-auth.ts';
import { MailConfig, magicLinkSender } from './mail.ts';

export type Session = {
  readonly userId: string;
  readonly email: string;
  readonly token: string;
};

export class Auth extends Context.Service<
  Auth,
  {
    readonly handler: (request: Request) => Promise<Response>;
    readonly signedIn: (headers: HttpHeaders.Headers) => Effect.Effect<Session, UnauthorizedError>;
    /** A password's login value as Better Auth stores and checks it. */
    readonly hashPassword: (authValue: string) => Effect.Effect<string>;
    readonly verifyPassword: (check: {
      readonly hash: string;
      readonly authValue: string;
    }) => Effect.Effect<boolean>;
  }
>()('@baymutt/worker-web/platform/Auth') {
  static readonly layer = (db: D1Database) =>
    Layer.unwrap(
      Effect.gen(function* () {
        return Auth.layerFromInstance(
          makeBetterAuth(db, yield* AuthConfig, magicLinkSender(yield* MailConfig)),
        );
      }),
    );

  static readonly layerFromInstance = (makeAuth: MakeBetterAuth) =>
    Layer.succeed(
      Auth,
      Auth.of({
        handler: request => makeAuth().handler(request),

        signedIn: Effect.fn('Auth.signedIn')(function* (headers: HttpHeaders.Headers) {
          const found = yield* Effect.tryPromise(() =>
            makeAuth().api.getSession({ headers: new Headers(headers) }),
          ).pipe(Effect.orDie);
          if (found === null) {
            return yield* new UnauthorizedError({
              message: 'Your session has ended. Sign in again.',
            });
          }
          return {
            userId: found.user.id,
            email: found.user.email,
            token: found.session.token,
          };
        }),

        hashPassword: Effect.fn('Auth.hashPassword')(function* (authValue: string) {
          return yield* Effect.tryPromise(async () =>
            (await makeAuth().$context).password.hash(authValue),
          ).pipe(Effect.orDie);
        }),

        verifyPassword: Effect.fn('Auth.verifyPassword')(function* ({ hash, authValue }) {
          return yield* Effect.tryPromise(async () =>
            (await makeAuth().$context).password.verify({ hash, password: authValue }),
          ).pipe(Effect.orDie);
        }),
      }),
    );
}
