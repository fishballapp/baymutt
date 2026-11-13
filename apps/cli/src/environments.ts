// Environments from this service account's side: finding one by name, knowing which public key is really its
// own, and opening it. The store's answers are checked against a proof the store cannot make.
import type { Environment } from '@baymutt/api';
import { createEnvironmentKey, unwrapEnvironmentKey, vouchedEnvironmentKey } from '@baymutt/keys';
import * as Effect from 'effect/Effect';
import { crypto_, usage } from './errors.ts';
import { ServiceAccount } from './service-account.ts';

/** What a command asks the store for: the environments this service account holds, and one's bundle. */
export const currentSource = {
  list: Effect.gen(function* () {
    const { api } = yield* ServiceAccount;
    return (yield* api.environments.list()).environments;
  }),
  bundle: Effect.fnUntraced(function* (environment: Environment) {
    const { api } = yield* ServiceAccount;
    return yield* api.secrets.bundle({ params: { environmentId: environment.id } });
  }),
};
export type Source = typeof currentSource;

/** An environment by its name (or id), among those `source` lists: the ones this service account holds a grant on. */
export const resolveEnvironmentFrom = (source: Source) =>
  Effect.fn('environments.resolve')(function* (name: string) {
    const { key } = yield* ServiceAccount;
    const environments = yield* source.list;
    const found = environments.find(
      environment => environment.name === name || environment.id === name,
    );
    if (found === undefined) {
      return yield* usage(
        isLogin(key)
          ? `This account has no environment named ${name}. See what it has with \`baymutt environments\`, or create it with \`baymutt environments create ${name}\`.`
          : `No environment named ${name} is granted to this service account. See what is with \`baymutt environments\`. The login that made it, or the owner, can hand it one.`,
        'notFound',
      );
    }
    return found;
  });

export const resolveEnvironment = resolveEnvironmentFrom(currentSource);

/** A login: made by `baymutt login`, so its key names no maker. It is meant to hold every environment. */
const isLogin = (key: { readonly issuerPublicKey: string | null }) => key.issuerPublicKey === null;

/**
 * The environment's public key, as someone this service account trusts vouched for it: the owner who granted
 * it (whose key a scoped one learns from its maker), the login that made this one, or this service
 * account itself when it created the environment. Every
 * value is sealed to this key and every wrap is checked against it. The key the store lists
 * beside the environment is only compared with it.
 */
export const trustedKey = Effect.fn('environments.trustedKey')(function* (
  environment: Environment,
) {
  const serviceAccount = yield* ServiceAccount;
  const account = yield* serviceAccount.account;
  const binding = {
    accountId: account.id,
    environmentId: environment.id,
    keyVersion: environment.keyVersion,
  };
  // A login is listed every environment; one with no grant yet was made by another service account,
  // and only the owner's browser can wrap it to this login.
  if (environment.keyProof === null && isLogin(serviceAccount.key)) {
    return yield* usage(
      `This login has full access, but ${environment.name} was made by another service account and is not wrapped to it yet: only the owner's browser can do that. Ask the owner to open the baymutt dashboard once; it grants every environment a login lacks.`,
      'noAccess',
    );
  }
  if (environment.keyProof === null) {
    return yield* usage(
      `The store answered ${environment.name} with no proof of its public key. Nothing was used.`,
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
  // The owner's proof, for an environment the owner handed this one: its maker vouched for the
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
      `The store shows a public key for ${environment.name} that is not the one vouched for to this service account. Nothing was used.`,
      'integrity',
    );
  }
  return { publicKey, binding };
});

/** The environment's ciphertexts and its private key, unwrapped with this service account's. Needs a read grant. */
export const openEnvironmentFrom = (source: Source) =>
  Effect.fn('environments.open')(function* (environment: Environment) {
    const serviceAccount = yield* ServiceAccount;
    const { publicKey, binding } = yield* trustedKey(environment);
    const bundle = yield* source.bundle(environment);
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

export const openEnvironment = openEnvironmentFrom(currentSource);

/** A new environment, its key made here, wrapped to the owner's account and to this service account, and vouched for to both. */
export const createEnvironment = Effect.fn('environments.create')(function* (name: string) {
  const serviceAccount = yield* ServiceAccount;
  const account = yield* serviceAccount.account;
  if (!account.isPinned) {
    return yield* usage(
      'This service account’s key comes from BAYMUTT_KEY, so it has no account key it can trust to wrap a new environment’s key to. Create the environment from a service account made by `baymutt login`.',
    );
  }
  const id = crypto.randomUUID();
  const {
    publicKey,
    grants: [owner, creator],
  } = yield* crypto_(() =>
    createEnvironmentKey({
      voucherKey: serviceAccount.key.privateKey,
      binding: { accountId: account.id, environmentId: id, keyVersion: 1 },
      readers: [
        { id: account.id, publicKey: account.publicKey },
        { id: serviceAccount.key.credentialId, publicKey: serviceAccount.key.publicKey },
      ],
    }),
  );
  if (owner === undefined || creator === undefined) {
    return yield* Effect.die('an environment key came back without its two grants');
  }
  const environment = yield* serviceAccount.api.environments.create({
    payload: {
      id,
      name,
      publicKey,
      ownerWrap: owner.wrap,
      ownerProof: owner.proof,
      creatorWrap: creator.wrap,
      creatorProof: creator.proof,
    },
  });
  // What was made here is the environment; the store's answer only has to agree with it.
  if (environment.id !== id || environment.publicKey !== publicKey) {
    return yield* usage(
      `The store answered the new environment with a different key than the one made here. Do not use ${name}.`,
      'integrity',
    );
  }
  return environment;
});
