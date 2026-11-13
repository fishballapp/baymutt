// The Worker answers `/api/*` only; the dashboard is static assets beside it, on the same origin,
// so nothing here needs CORS.
import { Api } from '@baymutt/api';
import { ErrorContract, errorResponse, jsonBodies } from '@internal/effect-worker';
import * as Effect from 'effect/Effect';
import * as HttpEffect from 'effect/http/HttpEffect';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServer from 'effect/http/HttpServer';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as SqlClient from 'effect/sql/SqlClient';
import * as SqlSchema from 'effect/sql/SqlSchema';
import { Auth } from '../platform/auth.ts';
import { BaymuttConfig } from '../platform/config.ts';
import { AccessHandlers } from './api/access.ts';
import { AccountHandlers } from './api/account.ts';
import { LegacyLoadHandlers } from './api/legacy.ts';
import { SecretsHandlers } from './api/secrets.ts';
import { GuardsLive } from './guards.ts';

export const ApiHandlers = Layer.mergeAll(
  AccountHandlers,
  AccessHandlers,
  SecretsHandlers,
  LegacyLoadHandlers,
).pipe(Layer.provideMerge(GuardsLive));

const ApiLive = HttpApiBuilder.layer(Api).pipe(Layer.provide(ApiHandlers));

const HealthRoute = HttpRouter.add(
  'GET',
  '/api/health',
  Effect.sync(() => HttpServerResponse.jsonUnsafe({ name: 'baymutt', status: 'ok' })),
);

const BetterAuthRoute = HttpRouter.add(
  '*',
  '/api/auth/*',
  Effect.gen(function* () {
    const auth = yield* Auth;
    return yield* HttpEffect.fromWebHandler(auth.handler);
  }),
);

// Local dev only, never registered in production: no mail is sent there, so the drive reads the
// newest sign-in link's token for an address from the database.
const DevRoutes = Layer.unwrap(
  Effect.gen(function* () {
    if (!(yield* BaymuttConfig).isDev) return Layer.empty;
    const sql = yield* SqlClient.SqlClient;
    const latestToken = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ identifier: Schema.String }),
      execute: email =>
        sql`SELECT identifier FROM verification WHERE json_extract(value, '$.email') = ${email}
            ORDER BY createdAt DESC LIMIT 1`,
    });
    return HttpRouter.add(
      'GET',
      '/api/dev/magic-link',
      Effect.gen(function* () {
        const { email } = yield* HttpServerRequest.schemaSearchParams(
          Schema.Struct({ email: Schema.String }),
        );
        return Option.match(yield* latestToken(email).pipe(Effect.orDie), {
          onNone: () => errorResponse(404, { code: 'NotFound', message: `No link for ${email}.` }),
          onSome: ({ identifier }) => HttpServerResponse.jsonUnsafe({ token: identifier }),
        });
      }).pipe(
        Effect.catchTag('SchemaError', () =>
          Effect.succeed(
            errorResponse(400, {
              code: 'InvalidRequestError',
              message: 'Name the email: ?email=…',
            }),
          ),
        ),
      ),
    );
  }),
);

// Every `/api/v1` request body is JSON, whatever its `Content-Type` says (`jsonBodies`).
const JsonBodies = jsonBodies(path => path.startsWith('/api/v1/'));

export const HttpApp = Layer.mergeAll(ApiLive, HealthRoute, BetterAuthRoute, DevRoutes).pipe(
  Layer.provide(ErrorContract),
  Layer.provide(JsonBodies),
  Layer.provide(HttpServer.layerServices),
);
