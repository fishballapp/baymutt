/**
 * The HTTP pieces every Effect Worker's app shares: the JSON error contract for everything its API
 * doesn't answer itself, leniency for request bodies that are JSON whatever their `Content-Type`,
 * and which requests a session cookie may sign.
 */
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as HttpHeaders from 'effect/http/Headers';
import * as HttpRouter from 'effect/http/HttpRouter';
import type * as HttpServerError from 'effect/http/HttpServerError';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import type * as Types from 'effect/Types';

/** An error response outside the API definition (a raw route, the router's own answers), in the
 * API's shape: `{ "code": …, "message": … }`. */
export const errorResponse = (
  status: number,
  error: { readonly code: string; readonly message: string },
) => HttpServerResponse.jsonUnsafe(error, { status });

/** Logs an unhandled fault's `cause` with `annotations` and answers the contract's 500. */
const internalError = (cause: Cause.Cause<unknown>, annotations: Record<string, unknown> = {}) =>
  Effect.logError('unhandled', cause).pipe(
    Effect.annotateLogs(annotations),
    Effect.as(
      errorResponse(500, {
        code: 'InternalServerError',
        message: 'An unexpected error occurred on the server — try again shortly.',
      }),
    ),
  );

/** A server error's fault: its reason, its path and its underlying cause. Never its message: that
 * quotes the request URL, whose query can carry a secret (a magic-link token, an OAuth code). */
const serverError = (reason: HttpServerError.HttpServerErrorReason) =>
  internalError(reason.cause === undefined ? Cause.empty : Cause.die(reason.cause), {
    reason: reason._tag,
    path: new URL(reason.request.url, 'http://path.invalid').pathname,
  });

/**
 * The JSON error contract for what the API doesn't answer itself: an unmatched route is
 * `404 NotFound`; any other server error and any defect is logged and becomes
 * `500 InternalServerError` instead of an empty body.
 */
export const ErrorContract = HttpRouter.middleware<{ handles: HttpServerError.HttpServerError }>()(
  httpEffect =>
    httpEffect.pipe(
      Effect.catchReason(
        'HttpServerError',
        'RouteNotFound',
        () =>
          Effect.succeed(
            errorResponse(404, {
              code: 'NotFound',
              message:
                'No endpoint matches this method and path. The endpoints are listed at /reference.',
            }),
          ),
        serverError,
      ),
      Effect.catchCauseFilter(Cause.findDefect, (_defect, cause) => internalError(cause)),
    ),
  { global: true },
);

/**
 * Every API request body is JSON, whatever its `Content-Type` says: `curl -d` sends a form type and
 * a bare `fetch` sends `text/plain`, and HttpApi picks its body parser from the header and would
 * answer those with a plain-text 415. `isApiPath` keeps raw routes out, as their bodies are
 * someone else's bytes.
 */
export const jsonBodies = (isApiPath: (path: string) => boolean) =>
  HttpRouter.middleware(
    // Annotated: a generic `Effect.fn` takes no parameter type from the middleware's signature.
    Effect.fn(function* (
      httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>,
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const contentType = request.headers['content-type'];
      if (!isApiPath(request.url) || contentType === undefined || contentType.includes('json')) {
        return yield* httpEffect;
      }
      const asJson = request.modify({
        headers: HttpHeaders.set(request.headers, 'content-type', 'application/json'),
      });
      return yield* Effect.provideService(httpEffect, HttpServerRequest.HttpServerRequest, asJson);
    }),
    { global: true },
  );

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether the session cookie may sign `request`: a read always, a write only from one of `origins`
 * (the app's own pages) or with no `Origin` (no browser sent it). The cookie is `SameSite=Lax`, so
 * it rides every request from its site, user content on a subdomain included, and a `text/plain`
 * POST needs no preflight ({@link jsonBodies} reads it as JSON), so CORS alone doesn't stop a
 * same-site page writing as its visitor.
 */
export const sessionMaySign = (
  request: HttpServerRequest.HttpServerRequest,
  origins: ReadonlySet<string>,
) => {
  const { origin } = request.headers;
  return READS.has(request.method) || origin === undefined || origins.has(origin);
};
