/** Secrets and paste links (`Secrets`). */
import { Api, CurrentActor, CurrentCaller, PASTE_TOKEN_HEADER } from '@baymutt/api';
import * as Effect from 'effect/Effect';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import * as Layer from 'effect/Layer';
import { Bin } from '../../services/bin.ts';
import { Secrets } from '../../services/secrets.ts';

const SecretHandlers = HttpApiBuilder.group(
  Api,
  'secrets',
  Effect.fn(function* (handlers) {
    const secrets = yield* Secrets;
    const bin = yield* Bin;
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
      purge: Effect.fn(function* ({ params }) {
        yield* bin.purgeSecret({ actor: yield* CurrentActor, ...params });
      }),
    });
  }),
);

const PasteLinkHandlers = HttpApiBuilder.group(
  Api,
  'pasteLinks',
  Effect.fn(function* (handlers) {
    const secrets = yield* Secrets;
    return handlers.handleAll({
      list: Effect.fn(function* () {
        return { links: yield* secrets.listPasteLinks(yield* CurrentActor) };
      }),
      create: Effect.fn(function* ({ payload }) {
        return yield* secrets.createPasteLink({ actor: yield* CurrentActor, paste: payload });
      }),
      cancel: Effect.fn(function* ({ params }) {
        return yield* secrets.cancelPasteLink({ actor: yield* CurrentActor, id: params.id });
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

export const SecretsHandlers = Layer.mergeAll(SecretHandlers, PasteLinkHandlers, PasteHandlers);
