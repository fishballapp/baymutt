// The load path, on the routes and in the shapes of 0.5.0 (`LegacyLoadGroup`): `GET /projects` and
// `GET /projects/:id/bundle`, with `project` where a bundle now says `environment`. It is what the
// plugin runs, and the deploy runs the plugin it has just built against the Worker that is still
// live, which answers nothing else. Every other command and the dashboard use `/environments`.
// DELETE THIS FILE in the release after this one, with `packages/api/src/legacy.ts`: `loadValues`
// then takes `currentSource` (`environments.ts`) and nothing else changes.
import { openValue } from '@baymutt/keys';
import * as Effect from 'effect/Effect';
import { openEnvironmentFrom, resolveEnvironmentFrom, type Source } from './environments.ts';
import { crypto_ } from './errors.ts';
import { ServiceAccount } from './service-account.ts';

const legacySource: Source = {
  list: Effect.gen(function* () {
    const { api } = yield* ServiceAccount;
    return (yield* api.legacyLoad.list()).projects;
  }),
  bundle: Effect.fnUntraced(function* (environment) {
    const { api } = yield* ServiceAccount;
    const { project, ...rest } = yield* api.legacyLoad.bundle({
      params: { projectId: environment.id },
    });
    return { environment: project, ...rest };
  }),
};

/** Every current value of an environment, opened here. The caller must not print them. */
export const loadValues = Effect.fn('environments.load')(function* (name: string) {
  const environment = yield* resolveEnvironmentFrom(legacySource)(name);
  const { bundle, binding, environmentKey } = yield* openEnvironmentFrom(legacySource)(environment);
  const values = yield* Effect.forEach(
    bundle.secrets,
    ({ name, version, keyVersion, ciphertext }) =>
      Effect.map(
        crypto_(() =>
          openValue({
            environmentKey,
            slot: { ...binding, keyVersion, name, version },
            ciphertext,
          }),
        ),
        value => [name, value] as const,
      ),
    { concurrency: 8 },
  );
  return { environment, values: Object.fromEntries(values) };
});
