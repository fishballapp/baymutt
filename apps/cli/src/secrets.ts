// Secrets from a credential's side: their names opened here, and a value sealed here to the
// environment's public key, for the one slot it will fill.
import { MAX_VALUE_BYTES, type Secret } from '@baymutt/api';
import { sealValue } from '@baymutt/keys';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { type NamedEnvironment, trustedKey } from './environments.ts';
import { crypto_, usage } from './errors.ts';
import { openStoredName, sealNewName, storedNameOf } from './names.ts';
import { ServiceAccount } from './service-account.ts';

/** A secret with its name opened, and the name the store files it under, which routes take. */
export type NamedSecret = Omit<Secret, 'sealedName'> & { readonly storedName: string };

export const openSecret = (
  environment: NamedEnvironment,
  { name, sealedName, ...secret }: Secret,
) =>
  Effect.map(
    openStoredName(environment.namesKey, {
      scopeId: environment.id,
      stored: { name, sealedName },
    }),
    (opened): NamedSecret => ({ ...secret, name: opened, storedName: name }),
  );

/** What a command prints of a secret: its name as written, and nothing of how the store files it. */
export const shownSecret = ({ storedName: _, ...secret }: NamedSecret) => secret;

/** An environment's secrets, live and deleted, names opened. */
export const listSecrets = Effect.fn('secrets.list')(function* (environment: NamedEnvironment) {
  const { api } = yield* ServiceAccount;
  const { secrets } = yield* api.secrets.list({ params: { environmentId: environment.id } });
  return yield* Effect.forEach(secrets, secret => openSecret(environment, secret), {
    concurrency: 'unbounded',
  });
});

/** The route parameters of an existing secret: the environment's id, and the name as the store files it. */
export const secretParams = Effect.fn('secrets.params')(function* (
  environment: NamedEnvironment,
  name: string,
) {
  const { api } = yield* ServiceAccount;
  const stored = yield* storedNameOf(environment.namesKey, {
    scopeId: environment.id,
    name,
    listed: Effect.map(
      api.secrets.list({ params: { environmentId: environment.id } }),
      ({ secrets }) => secrets,
    ),
  });
  if (Option.isNone(stored)) {
    return yield* usage(`${environment.address} has no secret ${name}.`, 'notFound');
  }
  return { environmentId: environment.id, name: stored.value };
});

export const writeValue = Effect.fn('secrets.write')(function* ({
  environment,
  name,
  value,
}: {
  readonly environment: NamedEnvironment;
  readonly name: string;
  readonly value: string;
}) {
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > MAX_VALUE_BYTES) {
    return yield* usage(`${name} is ${bytes} bytes; a value may be ${MAX_VALUE_BYTES}.`);
  }
  const { api } = yield* ServiceAccount;
  const { publicKey: environmentPublicKey, binding } = yield* trustedKey(environment, 'write');
  const existing = (yield* listSecrets(environment)).find(secret => secret.name === name);
  // A new name goes to the store sealed; an existing one is addressed as the store files it.
  const stored =
    existing === undefined
      ? yield* sealNewName(environment.namesKey, {
          scopeId: environment.id,
          name,
          orgSlug: environment.orgSlug,
        })
      : { name: existing.storedName, sealedName: undefined };

  const writeAs = Effect.fnUntraced(function* (version: number) {
    const ciphertext = yield* crypto_(() =>
      sealValue({ environmentPublicKey, slot: { ...binding, name, version }, value }),
    );
    return yield* api.secrets.write({
      params: { environmentId: environment.id, name: stored.name },
      payload: {
        version,
        keyVersion: environment.keyVersion,
        ciphertext,
        ...(stored.sealedName === undefined ? {} : { sealedName: stored.sealedName }),
      },
    });
  });

  // Another writer may take the slot between the read and the write: seal again for the next
  // one, once. A second loss is reported, with the slot the store names.
  const written = yield* writeAs((existing?.latestVersion ?? 0) + 1).pipe(
    Effect.catchTag('VersionConflictError', conflict =>
      conflict.keyVersion === environment.keyVersion
        ? writeAs(conflict.latestVersion + 1)
        : Effect.fail(conflict),
    ),
  );
  return yield* openSecret(environment, written);
});

/** What a command reports of a value: never the value. */
export const describeWrite = (
  environment: NamedEnvironment,
  secret: NamedSecret,
  value: string,
) => ({
  environment: environment.address,
  name: secret.name,
  version: secret.currentVersion,
  length: value.length,
});
