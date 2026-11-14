// Where the store is, and what this computer remembers about it: the account key it logged in
// to. Nothing here is secret; the service account key is `KeyStore`'s.
import { homedir } from 'node:os';
import { PublicKeySchema } from '@baymutt/api';
import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';
import { report, usage } from './errors.ts';

const DEFAULT_URL = new URL('https://baymutt.fsh.ba');

const StateSchema = Schema.Struct({
  /** The account this service account belongs to, learned from the browser that approved its login. */
  account: Schema.optionalKey(
    Schema.Struct({ id: Schema.String, name: Schema.String, publicKey: PublicKeySchema }),
  ),
  /** A pairing the owner has not approved yet. Its secret seals the browser's answer. */
  pendingPairing: Schema.optionalKey(
    Schema.Struct({
      pairingSecret: Schema.String,
      name: Schema.String,
      description: Schema.optionalKey(Schema.String),
      expiresAt: Schema.optionalKey(Schema.Finite),
    }),
  ),
});
export type State = typeof StateSchema.Type;

const StateFileSchema = Schema.fromJsonString(StateSchema, { space: 2 });

const resolve = Effect.gen(function* () {
  const path = yield* Path.Path;
  const url = yield* Config.URL('BAYMUTT_URL').pipe(
    Config.withDefault(DEFAULT_URL),
    Effect.mapError(() =>
      usage('BAYMUTT_URL is not a URL. Set it to one like https://baymutt.fsh.ba, or unset it.'),
    ),
  );
  const configHome = yield* Config.String('XDG_CONFIG_HOME').pipe(
    Config.withDefault(path.join(homedir(), '.config')),
    Effect.orDie,
  );
  // One store per origin: a local Worker and production never share a key or a pin.
  const directory = path.join(configHome, 'baymutt', url.host.replaceAll(':', '-'));
  return {
    origin: url.origin,
    stateFile: path.join(directory, 'state.json'),
    keyFile: path.join(directory, 'key'),
    keychainService: `baymutt ${url.origin}`,
  };
});

export class Settings extends Context.Service<Settings, Effect.Success<typeof resolve>>()(
  '@baymutt/cli/Settings',
) {
  static readonly layer = Layer.effect(Settings, report(resolve));
  /** For a caller that reports failures itself (`load.ts`). */
  static readonly layerUnreported = Layer.effect(Settings, resolve);
}

// A missing file reads as empty, as on a first run; one that isn't a state file fails, so a save
// never replaces the account key it may hold.
export const readState = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { stateFile } = yield* Settings;
  return yield* fs.readFileString(stateFile).pipe(
    Effect.flatMap(Schema.decodeEffect(StateFileSchema)),
    Effect.catchTag('SchemaError', () =>
      Effect.fail(usage(`This file is not baymutt's state: ${stateFile}. Fix or delete it.`)),
    ),
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed<State>({})),
  );
});

export const updateState = Effect.fn('settings.updateState')(function* (
  update: (state: State) => State,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateFile } = yield* Settings;
  const text = yield* Schema.encodeEffect(StateFileSchema)(update(yield* readState)).pipe(
    Effect.orDie,
  );
  yield* fs.makeDirectory(path.dirname(stateFile), { recursive: true });
  yield* fs.writeFileString(stateFile, `${text}\n`, { mode: 0o600 });
});

/** Forgets what this computer remembers about the store: the account it logged in to, or a login under way. */
export const removeState = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { stateFile } = yield* Settings;
  yield* fs.remove(stateFile).pipe(
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.void),
    Effect.orDie,
  );
});
