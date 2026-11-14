// Writing a value: sealed here to the environment's public key, for the one slot it will fill.
import { type Environment, MAX_VALUE_BYTES } from '@baymutt/api';
import { sealValue } from '@baymutt/keys';
import * as Effect from 'effect/Effect';
import { addressOf, trustedKey } from './environments.ts';
import { crypto_, usage } from './errors.ts';
import { ServiceAccount } from './service-account.ts';

export const writeValue = Effect.fn('secrets.write')(function* ({
  environment,
  name,
  value,
}: {
  readonly environment: Environment;
  readonly name: string;
  readonly value: string;
}) {
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > MAX_VALUE_BYTES) {
    return yield* usage(`${name} is ${bytes} bytes; a value may be ${MAX_VALUE_BYTES}.`);
  }
  const { api } = yield* ServiceAccount;
  const { publicKey: environmentPublicKey, binding } = yield* trustedKey(environment);
  const { secrets } = yield* api.secrets.list({ params: { environmentId: environment.id } });
  const latest = secrets.find(secret => secret.name === name)?.latestVersion ?? 0;

  const writeAs = Effect.fnUntraced(function* (version: number) {
    const ciphertext = yield* crypto_(() =>
      sealValue({
        environmentPublicKey,
        slot: { ...binding, name, version },
        value,
      }),
    );
    return yield* api.secrets.write({
      params: { environmentId: environment.id, name },
      payload: { version, keyVersion: environment.keyVersion, ciphertext },
    });
  });

  // Another writer may take the slot between the read and the write: seal again for the next
  // one, once. A second loss is reported, with the slot the store names.
  return yield* writeAs(latest + 1).pipe(
    Effect.catchTag('VersionConflictError', conflict =>
      conflict.keyVersion === environment.keyVersion
        ? writeAs(conflict.latestVersion + 1)
        : Effect.fail(conflict),
    ),
  );
});

/** What a command reports of a value: never the value. */
export const describeWrite = (
  environment: Environment,
  secret: { readonly name: string; readonly currentVersion: number | null },
  value: string,
) => ({
  environment: addressOf(environment),
  name: secret.name,
  version: secret.currentVersion,
  length: value.length,
});
