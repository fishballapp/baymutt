// Secrets from a credential's side: their names opened here. Nothing here writes one: a value is
// asked for in a plan, and the owner writes it.
import type { Secret } from '@baymutt/api';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import type { NamedEnvironment } from './environments.ts';
import { usage } from './errors.ts';
import { openStoredName, storedNameOf } from './names.ts';
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
