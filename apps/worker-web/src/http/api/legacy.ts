/**
 * The two routes a 0.5.0 load calls (`LegacyLoad`), answered by the services that answer
 * `/environments`, in the shape 0.5.0 sent. Deleted with the group in the release after this one.
 */
import { Api, CurrentActor } from '@baymutt/api';
import * as Effect from 'effect/Effect';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import { Access } from '../../services/access.ts';
import { Secrets } from '../../services/secrets.ts';

export const LegacyLoadHandlers = HttpApiBuilder.group(
  Api,
  'legacyLoad',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    const secrets = yield* Secrets;
    return handlers.handleAll({
      list: Effect.fn(function* () {
        return { projects: yield* access.listEnvironments(yield* CurrentActor) };
      }),
      bundle: Effect.fn(function* ({ params }) {
        const { environment, ...rest } = yield* secrets.bundle({
          actor: yield* CurrentActor,
          environmentId: params.projectId,
        });
        return { project: environment, ...rest };
      }),
    });
  }),
);
