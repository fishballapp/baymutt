/** Secrets (`Secrets`). */
import { Api, CurrentActor } from '@baymutt/api';
import * as Effect from 'effect/Effect';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
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

export const SecretsHandlers = SecretHandlers;
