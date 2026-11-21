// Environments from a credential's side: finding one by its address (its name opened here),
// knowing which public key is really its own, and opening it. The store's answers are checked
// against a proof the store cannot make.
import type { Environment } from '@baymutt/api';
import {
  type NamesKey,
  openValue,
  unwrapEnvironmentKey,
  vouchedEnvironmentKey,
} from '@baymutt/keys';
import * as Effect from 'effect/Effect';
import { crypto_, usage } from './errors.ts';
import { openNamesKeys, openStoredName } from './names.ts';
import { ServiceAccount } from './service-account.ts';

/** An environment with its name opened: `name` is what a person wrote, `address` is `<org slug>/<name>`. */
export type NamedEnvironment = Omit<Environment, 'name' | 'sealedName'> & {
  readonly name: string;
  readonly address: string;
  /** Its org's names key; null in an org whose names are not sealed yet. */
  readonly namesKey: NamesKey | null;
};

/** Every environment this key reaches, names opened, and the names key of each org it reaches. */
export const listEnvironments = Effect.fn('environments.list')(function* () {
  const { api } = yield* ServiceAccount;
  const { environments, namesKeys: wraps } = yield* api.environments.list();
  const namesKeys = yield* openNamesKeys(wraps ?? []);
  const named = yield* Effect.forEach(
    environments,
    ({ name: stored, sealedName, ...environment }) => {
      const namesKey = namesKeys.get(environment.orgId) ?? null;
      return Effect.map(
        openStoredName(namesKey, {
          scopeId: environment.orgId,
          stored: { name: stored, sealedName },
        }),
        (name): NamedEnvironment => ({
          ...environment,
          name,
          address: `${environment.orgSlug}/${name}`,
          namesKey,
        }),
      );
    },
    { concurrency: 'unbounded' },
  );
  return { environments: named, namesKeys };
});

export const findEnvironment = (
  environments: ReadonlyArray<NamedEnvironment>,
  address: string,
): NamedEnvironment | undefined =>
  environments.find(environment => environment.address === address || environment.id === address);

/** What to run to get at an environment: a CLI login asks the owner for it. */
export const askFor = (address: string) =>
  `a plan with an \`access\` step that reads ${address}: \`baymutt ask\` (see \`baymutt ask --help\`)`;

/** How the CLI login that asked for key `id` asks to add `address` to it, on the same key. */
export const changeFor = (id: string, address: string) =>
  `a plan with a \`change\` step for key ${id} that reads ${address}, sent by the CLI login with \`baymutt ask\` (without BAYMUTT_KEY_FILE)`;

/** An environment by its address (or id), among `environments`; refused with what to do next. */
export const resolveIn = Effect.fn('environments.resolveIn')(function* (
  environments: ReadonlyArray<NamedEnvironment>,
  address: string,
) {
  const { isLogin, key } = yield* ServiceAccount;
  const found = findEnvironment(environments, address);
  if (found !== undefined) return found;
  const hint = ' An environment is named with its org first: `<org>/<name>`.';
  return yield* usage(
    isLogin
      ? `None of your orgs has an environment ${address}.${hint} See them with \`baymutt env list\`. To ask the owner for a new one, send a plan with an \`environments\` step that creates it: \`baymutt ask\`.`
      : `No environment ${address} is granted to this key.${hint} See what is with \`baymutt env list\`. The CLI login that asked for it asks to add one with ${changeFor(key.credentialId, address)}.`,
    'notFound',
  );
});

/** An environment by its address (or id), among those this key reaches. */
export const resolveEnvironment = Effect.fn('environments.resolve')(function* (address: string) {
  const { environments } = yield* listEnvironments();
  return yield* resolveIn(environments, address);
});

/**
 * The environment's public key, as someone this key trusts vouched for it: the owner who approved
 * its plan's step (whose key it learns from the login that asked), or a login that made it before
 * 0.8.
 * Every value is sealed to this key and every wrap is checked against it. The key the store lists
 * beside the environment is only compared with it.
 */
export const trustedKey = Effect.fn('environments.trustedKey')(function* (
  environment: NamedEnvironment,
) {
  const serviceAccount = yield* ServiceAccount;
  const binding = { environmentId: environment.id, keyVersion: environment.keyVersion };
  if (serviceAccount.isLogin) {
    return yield* usage(
      `This CLI login lists names and holds no environment, so it cannot load ${environment.address}. Ask the owner for it with ${askFor(environment.address)}, then use the key it gives through BAYMUTT_KEY_FILE.`,
      'noAccess',
    );
  }
  if (!environment.canRead) {
    return yield* usage(
      `This key may not load ${environment.address}. The CLI login that asked for it asks to add that with ${changeFor(serviceAccount.key.credentialId, environment.address)}.`,
      'noAccess',
    );
  }
  if (environment.keyProof === null) {
    return yield* usage(
      `The store answered ${environment.address} with no proof of its public key. Nothing was used.`,
      'integrity',
    );
  }
  const proof = environment.keyProof;
  const vouchedBy = (vouchers: ReadonlyArray<string>) =>
    crypto_(() =>
      vouchedEnvironmentKey({
        proof,
        readerKey: serviceAccount.key.privateKey,
        readerId: serviceAccount.key.credentialId,
        vouchers,
        binding,
      }),
    );
  // The owner's proof, which approving a plan's step writes: the login that asked vouched for the
  // account's key.
  const publicKey = yield* vouchedBy(serviceAccount.vouchers).pipe(
    Effect.catchTag('IntegrityError', error =>
      Effect.flatMap(serviceAccount.vouchedAccount, account =>
        account === null ? Effect.fail(error) : vouchedBy([account]),
      ),
    ),
  );
  if (publicKey !== environment.publicKey) {
    return yield* usage(
      `The store shows a public key for ${environment.address} that is not the one vouched for to this key. Nothing was used.`,
      'integrity',
    );
  }
  return { publicKey, binding };
});

/** The environment's ciphertexts and its private key, unwrapped with this service account's. Needs a read grant. */
export const openEnvironment = Effect.fn('environments.open')(function* (
  environment: NamedEnvironment,
) {
  const serviceAccount = yield* ServiceAccount;
  const { publicKey, binding } = yield* trustedKey(environment);
  const bundle = yield* serviceAccount.api.secrets.bundle({
    params: { environmentId: environment.id },
  });
  const { key, encoded } = yield* crypto_(() =>
    unwrapEnvironmentKey({
      wrap: bundle.wrap,
      readerKey: serviceAccount.key.privateKey,
      // Its own id, never the one the store names: the wrap opens only if it was sealed for this
      // service account. And it must open to the pair of the key that was vouched for: anyone can seal a
      // key pair of their own making to this service account.
      readerId: serviceAccount.key.credentialId,
      binding,
      environmentPublicKey: publicKey,
    }),
  );
  return { bundle, binding, publicKey, environmentKey: key, encodedEnvironmentKey: encoded };
});

/** Every current value of an environment, opened here. The caller must not print them. */
export const loadValues = Effect.fn('environments.load')(function* (name: string) {
  const environment = yield* resolveEnvironment(name);
  const { bundle, binding, environmentKey } = yield* openEnvironment(environment);
  const values = yield* Effect.forEach(
    bundle.secrets,
    Effect.fnUntraced(function* ({ name: stored, sealedName, version, keyVersion, ciphertext }) {
      const name = yield* openStoredName(environment.namesKey, {
        scopeId: environment.id,
        stored: { name: stored, sealedName },
      });
      // The value is bound to the name as written, so a name the store swapped does not open.
      const value = yield* crypto_(() =>
        openValue({ environmentKey, slot: { ...binding, keyVersion, name, version }, ciphertext }),
      );
      return [name, value] as const;
    }),
    { concurrency: 8 },
  );
  return { environment, values: Object.fromEntries(values) };
});
