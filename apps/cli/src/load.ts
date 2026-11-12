// For the varlock plugin, and anything else that needs a project's values in-process: one call,
// no Effect in its signature. It reads the service account key the way the CLI does.
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import { describeFailure } from './errors.ts';
import { KeyStore } from './key-store.ts';
import { loadValues } from './projects.ts';
import { ServiceAccount } from './service-account.ts';
import { Settings } from './settings.ts';

/**
 * A project's current values by name. `key` and `url` stand in for `BAYMUTT_KEY` and
 * `BAYMUTT_URL` when the caller holds them itself. Rejects with an error whose `message` says what
 * to do next.
 */
export const loadProject = (
  project: string,
  { key, url }: { readonly key?: string | undefined; readonly url?: string | undefined } = {},
): Promise<Record<string, string>> =>
  loadValues(project).pipe(
    Effect.map(({ values }) => values),
    Effect.provide(
      ServiceAccount.layerUnreported.pipe(
        Layer.provideMerge(KeyStore.layer),
        Layer.provideMerge(Settings.layerUnreported),
        Layer.provideMerge(
          Layer.mergeAll(
            NodeServices.layer,
            FetchHttpClient.layer,
            Layer.succeed(HttpClient.TracerPropagationEnabled, false),
          ),
        ),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.orElse(
              ConfigProvider.fromUnknown({
                ...(key === undefined ? {} : { BAYMUTT_KEY: key }),
                ...(url === undefined ? {} : { BAYMUTT_URL: url }),
              }),
              ConfigProvider.fromEnv(),
            ),
          ),
        ),
      ),
    ),
    // One message that says what to do next, whatever failed.
    Effect.catch(error =>
      Effect.flatMap(describeFailure(error), ({ code, message }) =>
        Effect.die(new Error(`${code}: ${message}`)),
      ),
    ),
    Effect.runPromise,
  );
