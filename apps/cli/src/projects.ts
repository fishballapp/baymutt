// Projects from this service account's side: finding one by name, knowing which public key is really its
// own, and opening it. The store's answers are checked against a proof the store cannot make.
import type { Project } from '@baymutt/api';
import { createProjectKey, openValue, unwrapProjectKey, vouchedProjectKey } from '@baymutt/keys';
import * as Effect from 'effect/Effect';
import { crypto_, usage } from './errors.ts';
import { ServiceAccount } from './service-account.ts';

/** A project by its name (or id), among those this service account holds a grant on. */
export const resolveProject = Effect.fn('projects.resolve')(function* (name: string) {
  const { api, key } = yield* ServiceAccount;
  const { projects } = yield* api.projects.list();
  const found = projects.find(project => project.name === name || project.id === name);
  if (found === undefined) {
    return yield* usage(
      isLogin(key)
        ? `This account has no project named ${name}. See what it has with \`baymutt projects\`, or create it with \`baymutt projects create ${name}\`.`
        : `No project named ${name} is granted to this service account. See what is with \`baymutt projects\`. The login that made it, or the owner, can hand it one.`,
      'notFound',
    );
  }
  return found;
});

/** A login: made by `baymutt login`, so its key names no maker. It is meant to hold every project. */
const isLogin = (key: { readonly issuerPublicKey: string | null }) => key.issuerPublicKey === null;

/**
 * The project's public key, as someone this service account trusts vouched for it: the owner who granted
 * it (whose key a scoped one learns from its maker), the login that made this one, or this service
 * account itself when it created the project. Every
 * value is sealed to this key and every wrap is checked against it. The key the store lists
 * beside the project is only compared with it.
 */
export const trustedKey = Effect.fn('projects.trustedKey')(function* (project: Project) {
  const serviceAccount = yield* ServiceAccount;
  const account = yield* serviceAccount.account;
  const binding = {
    accountId: account.id,
    projectId: project.id,
    keyVersion: project.keyVersion,
  };
  // A login is listed every project; one with no grant yet was made by another service account,
  // and only the owner's browser can wrap it to this login.
  if (project.keyProof === null && isLogin(serviceAccount.key)) {
    return yield* usage(
      `This login has full access, but ${project.name} was made by another service account and is not wrapped to it yet: only the owner's browser can do that. Ask the owner to open the baymutt dashboard once; it grants every project a login lacks.`,
      'noAccess',
    );
  }
  if (project.keyProof === null) {
    return yield* usage(
      `The store answered ${project.name} with no proof of its public key. Nothing was used.`,
      'integrity',
    );
  }
  const proof = project.keyProof;
  const vouchedBy = (vouchers: ReadonlyArray<string>) =>
    crypto_(() =>
      vouchedProjectKey({
        proof,
        readerKey: serviceAccount.key.privateKey,
        readerId: serviceAccount.key.credentialId,
        vouchers,
        binding,
      }),
    );
  // The owner's proof, for a project the owner handed this one: its maker vouched for the
  // account's key.
  const publicKey = yield* vouchedBy(serviceAccount.vouchers).pipe(
    Effect.catchTag('IntegrityError', error =>
      Effect.flatMap(serviceAccount.vouchedAccount, account =>
        account === null ? Effect.fail(error) : vouchedBy([account]),
      ),
    ),
  );
  if (publicKey !== project.publicKey) {
    return yield* usage(
      `The store shows a public key for ${project.name} that is not the one vouched for to this service account. Nothing was used.`,
      'integrity',
    );
  }
  return { publicKey, binding };
});

/** The project's ciphertexts and its private key, unwrapped with this service account's. Needs a read grant. */
export const openProject = Effect.fn('projects.open')(function* (project: Project) {
  const serviceAccount = yield* ServiceAccount;
  const { publicKey, binding } = yield* trustedKey(project);
  const bundle = yield* serviceAccount.api.secrets.bundle({ params: { projectId: project.id } });
  const { key, encoded } = yield* crypto_(() =>
    unwrapProjectKey({
      wrap: bundle.wrap,
      readerKey: serviceAccount.key.privateKey,
      // Its own id, never the one the store names: the wrap opens only if it was sealed for this
      // service account. And it must open to the pair of the key that was vouched for: anyone can seal a
      // key pair of their own making to this service account.
      readerId: serviceAccount.key.credentialId,
      binding,
      projectPublicKey: publicKey,
    }),
  );
  return { bundle, binding, publicKey, projectKey: key, encodedProjectKey: encoded };
});

/** Every current value of a project, opened here. The caller must not print them. */
export const loadValues = Effect.fn('projects.load')(function* (name: string) {
  const project = yield* resolveProject(name);
  const { bundle, binding, projectKey } = yield* openProject(project);
  const values = yield* Effect.forEach(
    bundle.secrets,
    ({ name, version, keyVersion, ciphertext }) =>
      Effect.map(
        crypto_(() =>
          openValue({
            projectKey,
            slot: { ...binding, keyVersion, name, version },
            ciphertext,
          }),
        ),
        value => [name, value] as const,
      ),
    { concurrency: 8 },
  );
  return { project, values: Object.fromEntries(values) };
});

/** A new project, its key made here, wrapped to the owner's account and to this service account, and vouched for to both. */
export const createProject = Effect.fn('projects.create')(function* (name: string) {
  const serviceAccount = yield* ServiceAccount;
  const account = yield* serviceAccount.account;
  if (!account.isPinned) {
    return yield* usage(
      'This service account’s key comes from BAYMUTT_KEY, so it has no account key it can trust to wrap a new project’s key to. Create the project from a service account made by `baymutt login`.',
    );
  }
  const id = crypto.randomUUID();
  const {
    publicKey,
    grants: [owner, creator],
  } = yield* crypto_(() =>
    createProjectKey({
      voucherKey: serviceAccount.key.privateKey,
      binding: { accountId: account.id, projectId: id, keyVersion: 1 },
      readers: [
        { id: account.id, publicKey: account.publicKey },
        { id: serviceAccount.key.credentialId, publicKey: serviceAccount.key.publicKey },
      ],
    }),
  );
  if (owner === undefined || creator === undefined) {
    return yield* Effect.die('a project key came back without its two grants');
  }
  const project = yield* serviceAccount.api.projects.create({
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
  // What was made here is the project; the store's answer only has to agree with it.
  if (project.id !== id || project.publicKey !== publicKey) {
    return yield* usage(
      `The store answered the new project with a different key than the one made here. Do not use ${name}.`,
      'integrity',
    );
  }
  return project;
});
