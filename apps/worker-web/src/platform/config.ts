/** The config more than one layer reads, from the provider the composition root installs over `env`. */
import * as Config from 'effect/Config';

export const MODES = ['production', 'development'] as const;
export type Mode = (typeof MODES)[number];

/**
 * The one origin: the dashboard and the API are the same site, so the session cookie needs no CORS
 * and a passkey's relying party is this host. In development it is the Vite server, which proxies
 * `/api` to the Worker.
 */
const ORIGINS = {
  production: 'https://baymutt.fsh.ba',
  development: 'http://localhost:5183',
} as const satisfies Record<Mode, string>;

export const BaymuttConfig = Config.Literals(MODES, 'MODE').pipe(
  Config.map(mode => ({ isDev: mode === 'development', origin: ORIGINS[mode] })),
);
