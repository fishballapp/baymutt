/** The config more than one layer reads, from the provider the composition root installs over `env`. */
import * as Config from 'effect/Config';

export const MODES = ['production', 'development'] as const;
export type Mode = (typeof MODES)[number];

/**
 * The one origin: the dashboard and the API are the same site, so the session cookie needs no CORS
 * and a passkey's relying party is this host. In development it is the Vite server, which proxies
 * `/api` to the Worker; `DEV_ORIGIN` names it when it runs on another port than 5183, so several
 * checkouts can each run their own.
 */
const PRODUCTION_ORIGIN = 'https://baymutt.fsh.ba';

export const BaymuttConfig = Config.all({
  mode: Config.Literals(MODES, 'MODE'),
  devOrigin: Config.String('DEV_ORIGIN').pipe(Config.withDefault('http://localhost:5183')),
}).pipe(
  Config.map(({ mode, devOrigin }) => ({
    isDev: mode === 'development',
    origin: mode === 'production' ? PRODUCTION_ORIGIN : devOrigin,
  })),
);
