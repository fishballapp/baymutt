// runtime.ts builds it over the live `env`; test-support.ts over fakes. The two differ only in
// Better Auth.
import * as D1Client from '@effect/sql-d1/D1Client';
import type * as Config from 'effect/Config';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Layer from 'effect/Layer';
import * as Str from 'effect/String';
import type { Auth } from './platform/auth.ts';
import { Access } from './services/access.ts';
import { Accounts } from './services/accounts.ts';
import { Audit } from './services/audit.ts';
import { Bin } from './services/bin.ts';
import { Secrets } from './services/secrets.ts';

export const makeWorkerLayer = (
  env: Env,
  edges: { readonly auth: Layer.Layer<Auth, Config.ConfigError> },
) =>
  Layer.mergeAll(Secrets.layer, Bin.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(Access.layer, Accounts.layer)),
    Layer.provideMerge(Audit.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        edges.auth,
        D1Client.layer({ db: env.DB, transformResultNames: Str.snakeToCamel }),
      ),
    ),
    // A key that is absent altogether is a broken deployment: the build fails, and with it every
    // request (the deploy itself succeeds, as the web handler rejects each request).
    Layer.provideMerge(
      ConfigProvider.layer(ConfigProvider.fromUnknown(env, { preserveEmptyStrings: true })),
    ),
    Layer.orDie,
  );
