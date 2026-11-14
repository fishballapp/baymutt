// Environments from a credential's side: finding one by its address, knowing which public key is
// really its own, and opening it. The store's answers are checked against a proof the store cannot
// make.
import type { Environment } from '@baymutt/api';
import {
  createEnvironmentKey,
  openValue,
  unwrapEnvironmentKey,
  vouchedEnvironmentKey,
} from '@baymutt/keys';
import * as Effect from 'effect/Effect';
import { crypto_, usage } from './errors.ts';
import { ServiceAccount } from './service-account.ts';

/** How an environment is named wherever a name is taken: `<org slug>/<name>`. */
export const addressOf = ({ orgSlug, name }: Pick<Environment, 'orgSlug' | 'name'>): string =>
  `${orgSlug}/${name}`;

/** An environment by its address (or id), among those this credential reaches. */
export const resolveEnvironment = Effect.fn('environments.resolve')(function* (address: string) {
  const { api, key } = yield* ServiceAccount;
  const { environments } = yield* api.environments.list();
  const found = environments.find(
    environment => addressOf(environment) === address || environment.id === address,
  );
  if (found === undefined) {
    const hint = address.includes('/')
      ? ''
      : ' An environment is named with its org first: `<org>/<name>`.';
    return yield* usage(
      isLogin(key)
        ? `None of your orgs has an environment ${address}.${hint} See them with \`baymutt environments\`, or create it with \`baymutt environments create <org>/<name>\`.`
        : `No environment ${address} is granted to this service account.${hint} See what is with \`baymutt environments\`. The CLI login that made it, or the owner, can hand it one.`,
      'notFound',
    );
  }
  return found;
});

/** A CLI login: made by `baymutt login`, so its key names no maker. It is meant to hold every environment. */
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
  const binding = { environmentId: environment.id, keyVersion: environment.keyVersion };
  // A login is listed every environment; one with no grant yet was made by another login, and only
  // the owner's browser can wrap it to this one.
  if (environment.keyProof === null && isLogin(serviceAccount.key)) {
    return yield* usage(
      `This CLI login has full access, but ${addressOf(environment)} was made by another CLI login and is not wrapped to this one yet: only the owner's browser can do that. Ask the owner to open the baymutt dashboard once; it grants every environment a CLI login lacks.`,
      'noAccess',
    );
  }
  if (environment.keyProof === null) {
    return yield* usage(
      `The store answered ${addressOf(environment)} with no proof of its public key. Nothing was used.`,
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
      `The store shows a public key for ${addressOf(environment)} that is not the one vouched for to this key. Nothing was used.`,
      'integrity',
    );
  }
  return { publicKey, binding };
});

/** The environment's ciphertexts and its private key, unwrapped with this service account's. Needs a read grant. */
export const openEnvironment = Effect.fn('environments.open')(function* (environment: Environment) {
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
    ({ name, version, keyVersion, ciphertext }) =>
      Effect.map(
        crypto_(() =>
          openValue({
            environmentKey,
            slot: { ...binding, keyVersion, name, version },
            ciphertext,
          }),
        ),
        value => [name, value] as const,
      ),
    { concurrency: 8 },
  );
  return { environment, values: Object.fromEntries(values) };
});

/**
 * A new environment in one of the person's orgs, its key made here, wrapped to the person's account
 * (their member copy) and to this login, and vouched for to both.
 */
export const createEnvironment = Effect.fn('environments.create')(function* ({
  orgSlug,
  name,
}: {
  readonly orgSlug: string;
  readonly name: string;
}) {
  const serviceAccount = yield* ServiceAccount;
  const account = yield* serviceAccount.account;
  if (!account.isPinned) {
    return yield* usage(
      'This key comes from BAYMUTT_KEY, so it has no account key it can trust to wrap a new environment’s key to. Create the environment from a computer where `baymutt login` ran.',
    );
  }
  const { orgs } = yield* serviceAccount.api.orgs.list();
  const org = orgs.find(listed => listed.slug === orgSlug);
  if (org === undefined) {
    return yield* usage(
      `You have no org ${orgSlug}. The owner creates orgs in the dashboard, under Account.`,
      'notFound',
    );
  }
  const id = crypto.randomUUID();
  const {
    publicKey,
    grants: [member, creator],
  } = yield* crypto_(() =>
    createEnvironmentKey({
      voucherKey: serviceAccount.key.privateKey,
      binding: { environmentId: id, keyVersion: 1 },
      readers: [
        { id: account.id, publicKey: account.publicKey },
        { id: serviceAccount.key.credentialId, publicKey: serviceAccount.key.publicKey },
      ],
    }),
  );
  if (member === undefined || creator === undefined) {
    return yield* Effect.die('an environment key came back without its two grants');
  }
  const environment = yield* serviceAccount.api.environments.create({
    payload: {
      id,
      orgId: org.id,
      name,
      publicKey,
      memberWrap: member.wrap,
      memberProof: member.proof,
      creatorWrap: creator.wrap,
      creatorProof: creator.proof,
    },
  });
  // What was made here is the environment; the store's answer only has to agree with it.
  if (environment.id !== id || environment.publicKey !== publicKey) {
    return yield* usage(
      `The store answered the new environment with a different key than the one made here. Do not use ${orgSlug}/${name}.`,
      'integrity',
    );
  }
  return environment;
});
