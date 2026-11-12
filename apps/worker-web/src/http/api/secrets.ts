/** Secrets and paste requests (`Secrets`). */
import { Api, CurrentActor, CurrentCaller, PASTE_TOKEN_HEADER } from '@baymutt/api';
import * as Effect from 'effect/Effect';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import * as Layer from 'effect/Layer';
import { Secrets } from '../../services/secrets.ts';

const SecretHandlers = HttpApiBuilder.group(
  Api,
  'secrets',
  Effect.fn(function* (handlers) {
    const secrets = yield* Secrets;
    return handlers.handleAll({
      list: Effect.fn(function* ({ params }) {
        return { secrets: yield* secrets.list({ actor: yield* CurrentActor, ...params }) };
      }),
      bundle: Effect.fn(function* ({ params }) {
        return yield* secrets.bundle({ actor: yield* CurrentActor, ...params });
      }),
      write: Effect.fn(function* ({ params, payload }) {
        return yield* secrets.write({
          actor: yield* CurrentActor,
          write: { ...params, ...payload },
        });
      }),
      remove: Effect.fn(function* ({ params }) {
        return yield* secrets.remove({ actor: yield* CurrentActor, ...params });
      }),
      rollback: Effect.fn(function* ({ params, payload }) {
        return yield* secrets.rollback({ actor: yield* CurrentActor, ...params, ...payload });
      }),
      versions: Effect.fn(function* ({ params }) {
        return { versions: yield* secrets.versions({ actor: yield* CurrentActor, ...params }) };
      }),
      reveal: Effect.fn(function* ({ params, payload }) {
        return yield* secrets.reveal({ actor: yield* CurrentActor, ...params, ...payload });
      }),
    });
  }),
);

const PasteRequestHandlers = HttpApiBuilder.group(
  Api,
  'pasteRequests',
  Effect.fn(function* (handlers) {
    const secrets = yield* Secrets;
    return handlers.handleAll({
      list: Effect.fn(function* () {
        return { requests: yield* secrets.listPasteRequests(yield* CurrentActor) };
      }),
      create: Effect.fn(function* ({ payload }) {
        return yield* secrets.requestPaste({ actor: yield* CurrentActor, paste: payload });
      }),
      cancel: Effect.fn(function* ({ params }) {
        return yield* secrets.cancelPaste({ actor: yield* CurrentActor, id: params.id });
      }),
    });
  }),
);

const PasteHandlers = HttpApiBuilder.group(
  Api,
  'paste',
  Effect.fn(function* (handlers) {
    const secrets = yield* Secrets;
    const caller = Effect.fnUntraced(function* (headers: {
      readonly [PASTE_TOKEN_HEADER]?: string;
    }) {
      return { actor: (yield* CurrentCaller).actor, token: headers[PASTE_TOKEN_HEADER] };
    });
    return handlers.handleAll({
      target: Effect.fn(function* ({ params, headers }) {
        return yield* secrets.pasteTarget({ caller: yield* caller(headers), id: params.id });
      }),
      fulfil: Effect.fn(function* ({ params, headers, payload }) {
        return yield* secrets.fulfilPaste({
          caller: yield* caller(headers),
          id: params.id,
          write: payload,
        });
      }),
    });
  }),
);

export const SecretsHandlers = Layer.mergeAll(SecretHandlers, PasteRequestHandlers, PasteHandlers);
