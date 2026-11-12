// Projects from this machine's side: finding one by name, knowing which public key is really its
// own, and opening it. The store's answers are checked against a proof the store cannot make.
import type { Project } from '@baymutt/api';
import { createProjectKey, openValue, unwrapProjectKey, vouchedProjectKey } from '@baymutt/keys';
import * as Effect from 'effect/Effect';
import { crypto_, usage } from './errors.ts';
import { Machine } from './machine.ts';

/** A project by its name (or id), among those this machine holds a grant on. */
export const resolveProject = Effect.fn('projects.resolve')(function* (name: string) {
  const { api } = yield* Machine;
  const { projects } = yield* api.projects.list();
  const found = projects.find(project => project.name === name || project.id === name);
  if (found === undefined) {
    return yield* usage(
      `No project named ${name} is granted to this machine. See what is with \`baymutt projects\`, ask for it with \`baymutt access request ${name} --read --reason "…"\`, or create it with \`baymutt projects create ${name}\`.`,
      'notFound',
    );
  }
  return found;
});

/**
 * The project's public key, as someone this machine trusts vouched for it: the owner who granted
 * it, the machine that made this one, or this machine itself when it created the project. Every
 * value is sealed to this key and every wrap is checked against it. The key the store lists
 * beside the project is only compared with it.
 */
export const trustedKey = Effect.fn('projects.trustedKey')(function* (project: Project) {
  const machine = yield* Machine;
  const account = yield* machine.account;
  const binding = {
    accountId: account.id,
    projectId: project.id,
    keyVersion: project.keyVersion,
  };
  if (project.keyProof === null) {
    return yield* usage(
      `The store answered ${project.name} with no proof of its public key. Nothing was used.`,
      'integrity',
    );
  }
  const proof = project.keyProof;
  const publicKey = yield* crypto_(() =>
    vouchedProjectKey({
      proof,
      readerKey: machine.key.privateKey,
      readerId: machine.key.credentialId,
      vouchers: machine.vouchers,
      binding,
    }),
  );
  if (publicKey !== project.publicKey) {
    return yield* usage(
      `The store shows a public key for ${project.name} that is not the one vouched for to this machine. Nothing was used.`,
      'integrity',
    );
  }
  return { publicKey, binding };
});

/** The project's ciphertexts and its private key, unwrapped with this machine's. Needs a read grant. */
export const openProject = Effect.fn('projects.open')(function* (project: Project) {
  const machine = yield* Machine;
  const { publicKey, binding } = yield* trustedKey(project);
  const bundle = yield* machine.api.secrets.bundle({ params: { projectId: project.id } });
  const { key, encoded } = yield* crypto_(() =>
    unwrapProjectKey({
      wrap: bundle.wrap,
      readerKey: machine.key.privateKey,
      // Its own id, never the one the store names: the wrap opens only if it was sealed for this
      // machine. And it must open to the pair of the key that was vouched for: anyone can seal a
      // key pair of their own making to this machine.
      readerId: machine.key.credentialId,
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

/** A new project, its key made here, wrapped to the owner's account and to this machine, and vouched for to both. */
export const createProject = Effect.fn('projects.create')(function* (name: string) {
  const machine = yield* Machine;
  const account = yield* machine.account;
  if (!account.isPinned) {
    return yield* usage(
      'This machine’s key comes from BAYMUTT_KEY, so it has no account key it can trust to wrap a new project’s key to. Create the project from a machine paired with `baymutt pair`.',
    );
  }
  const id = crypto.randomUUID();
  const {
    publicKey,
    grants: [owner, creator],
  } = yield* crypto_(() =>
    createProjectKey({
      voucherKey: machine.key.privateKey,
      binding: { accountId: account.id, projectId: id, keyVersion: 1 },
      readers: [
        { id: account.id, publicKey: account.publicKey },
        { id: machine.key.credentialId, publicKey: machine.key.publicKey },
      ],
    }),
  );
  if (owner === undefined || creator === undefined) {
    return yield* Effect.die('a project key came back without its two grants');
  }
  const project = yield* machine.api.projects.create({
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
