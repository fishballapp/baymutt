// Server state as atoms derived from the API definition, and the writes that change it. A write
// that needs the vault takes the owner in its argument: the open vault is never module state an
// atom reads behind a component's back.
import type { AccessRequest, Grant, PairingRequest, Project } from '@baymutt/api';
import {
  approvePairing,
  createProjectKey,
  grantToMachine,
  openOwnedProject,
  publicKeyFingerprint,
  sealValue,
} from '@baymutt/keys';
import * as Effect from 'effect/Effect';
import * as Atom from 'effect/reactivity/Atom';
import { ApiClient, faultsAsDefects } from './api.ts';
import {
  addPasskey,
  keys,
  type Owner,
  OwnerError,
  recover,
  resume,
  rotateRecoveryKey,
  sendLink,
  setPassword,
  setUp,
  signInWithPasskey,
  signInWithPassword,
  signOut,
  unlockWithPassword,
} from './owner.ts';

// --- the session -------------------------------------------------------------------------------

/** Whether this browser is signed in, read once per page load. A signed-out visitor is a failure here. */
export const sessionAtom = ApiClient.query('account', 'get', { reactivityKeys: ['account'] }).pipe(
  Atom.keepAlive,
);

/** Runs once per page load: the vault this browser kept open, opened again. */
export const resumeAtom = ApiClient.runtime.atom(resume()).pipe(Atom.keepAlive);

export const sendLinkAtom = ApiClient.runtime.fn(sendLink);
export const setUpAtom = ApiClient.runtime.fn(setUp, { reactivityKeys: ['account'] });
export const signInWithPasskeyAtom = ApiClient.runtime.fn(() => signInWithPasskey(), {
  reactivityKeys: ['account'],
});
export const signInWithPasswordAtom = ApiClient.runtime.fn(signInWithPassword, {
  reactivityKeys: ['account'],
});
export const unlockWithPasswordAtom = ApiClient.runtime.fn(unlockWithPassword);
export const recoverAtom = ApiClient.runtime.fn(recover, { reactivityKeys: ['account'] });
export const signOutAtom = ApiClient.runtime.fn(() => signOut());
export const addPasskeyAtom = ApiClient.runtime.fn(addPasskey, { reactivityKeys: ['account'] });
export const setPasswordAtom = ApiClient.runtime.fn(setPassword, { reactivityKeys: ['account'] });
export const rotateRecoveryKeyAtom = ApiClient.runtime.fn(rotateRecoveryKey);

export const removePasskeyAtom = ApiClient.runtime.fn(
  (passkeyId: string) =>
    ApiClient.use(client => client.account.removePasskey({ params: { passkeyId } })).pipe(
      faultsAsDefects,
    ),
  { reactivityKeys: ['account'] },
);

export const removePasswordAtom = ApiClient.runtime.fn(
  () => ApiClient.use(client => client.account.removePassword()).pipe(faultsAsDefects),
  { reactivityKeys: ['account'] },
);

// --- projects and secrets ----------------------------------------------------------------------

export const projectsAtom = ApiClient.query('projects', 'list', {
  reactivityKeys: ['projects'],
}).pipe(Atom.mapResult(({ projects }) => projects));

export const projectAtom = Atom.family((id: string) =>
  ApiClient.query('projects', 'get', { params: { id }, reactivityKeys: ['projects'] }),
);

export const secretsAtom = Atom.family((projectId: string) =>
  ApiClient.query('secrets', 'list', { params: { projectId }, reactivityKeys: ['secrets'] }).pipe(
    Atom.mapResult(({ secrets }) => secrets),
  ),
);

export const versionsAtom = Atom.family(
  ({ projectId, name }: { readonly projectId: string; readonly name: string }) =>
    ApiClient.query('secrets', 'versions', {
      params: { projectId, name },
      reactivityKeys: ['secrets'],
    }).pipe(Atom.mapResult(({ versions }) => versions)),
);

export const grantsAtom = Atom.family((id: string) =>
  ApiClient.query('projects', 'grants', { params: { id }, reactivityKeys: ['grants'] }).pipe(
    Atom.mapResult(({ grants }) => grants),
  ),
);

export const createProjectAtom = ApiClient.runtime.fn(
  ({ owner, name }: { readonly owner: Owner; readonly name: string }) =>
    Effect.gen(function* () {
      const id = crypto.randomUUID();
      const accountPublicKey = owner.accountKey.publicKey.toBase64({
        alphabet: 'base64url',
        omitPadding: true,
      });
      const { publicKey, grants } = yield* keys(() =>
        createProjectKey({
          voucherKey: owner.accountKey,
          binding: { accountId: owner.accountId, projectId: id, keyVersion: 1 },
          readers: [{ id: owner.accountId, publicKey: accountPublicKey }],
        }),
      );
      const [own] = grants;
      if (own === undefined) return yield* Effect.die('a project key came with no grant');
      return yield* ApiClient.use(client =>
        client.projects.create({
          payload: {
            id,
            name,
            publicKey,
            ownerWrap: own.wrap,
            ownerProof: own.proof,
            creatorWrap: null,
            creatorProof: null,
          },
        }),
      );
    }).pipe(faultsAsDefects),
  { reactivityKeys: ['projects'] },
);

export const archiveProjectAtom = ApiClient.runtime.fn(
  (id: string) =>
    ApiClient.use(client => client.projects.archive({ params: { id } })).pipe(faultsAsDefects),
  { reactivityKeys: ['projects', 'requests'] },
);

/**
 * The project as the owner's vault proves it: the public key its creator vouched for (the owner,
 * or a machine the vault endorsed) and the private key the owner's wrap opens to. Nothing the
 * store lists beside the project is used past this point.
 */
const ownedProject = Effect.fnUntraced(function* (owner: Owner, projectId: string) {
  const { ownerWrap, ownerProof, keyVersion, creator } = yield* ApiClient.use(client =>
    client.projects.ownerWrap({ params: { id: projectId } }),
  );
  const owned = {
    accountId: owner.accountId,
    projectId,
    keyVersion,
    ownerWrap,
    ownerProof,
    creator,
  };
  const { publicKey } = yield* keys(() => openOwnedProject(owner, owned));
  return { owned, publicKey, keyVersion };
});

/** Seals `value` here, to a public key the vault has just proved, and writes it as the next version. */
export const writeSecretAtom = ApiClient.runtime.fn(
  ({
    owner,
    project,
    name,
    value,
  }: {
    readonly owner: Owner;
    readonly project: Project;
    readonly name: string;
    readonly value: string;
  }) =>
    Effect.gen(function* () {
      const { keyVersion, publicKey } = yield* ownedProject(owner, project.id);
      const { secrets } = yield* ApiClient.use(client =>
        client.secrets.list({ params: { projectId: project.id } }),
      );
      const version = (secrets.find(secret => secret.name === name)?.latestVersion ?? 0) + 1;
      const ciphertext = yield* keys(() =>
        sealValue({
          projectPublicKey: publicKey,
          slot: { accountId: owner.accountId, projectId: project.id, keyVersion, name, version },
          value,
        }),
      );
      return yield* ApiClient.use(client =>
        client.secrets.write({
          params: { projectId: project.id, name },
          payload: { version, keyVersion, ciphertext },
        }),
      );
    }).pipe(faultsAsDefects),
  { reactivityKeys: ['secrets', 'projects', 'audit'] },
);

type SecretKey = { readonly projectId: string; readonly name: string };

export const removeSecretAtom = ApiClient.runtime.fn(
  (params: SecretKey) =>
    ApiClient.use(client => client.secrets.remove({ params })).pipe(faultsAsDefects),
  { reactivityKeys: ['secrets', 'projects', 'audit'] },
);

export const rollbackSecretAtom = ApiClient.runtime.fn(
  ({ version, ...params }: SecretKey & { readonly version: number }) =>
    ApiClient.use(client => client.secrets.rollback({ params, payload: { version } })).pipe(
      faultsAsDefects,
    ),
  { reactivityKeys: ['secrets', 'projects', 'audit'] },
);

// --- machines and access -----------------------------------------------------------------------

export const machinesAtom = ApiClient.query('credentials', 'list', {
  reactivityKeys: ['machines', 'grants'],
}).pipe(Atom.mapResult(({ credentials }) => credentials));

/** Approves a pairing link: the vault vouches for the machine's key and tells it which account key to trust. */
export const pairAtom = ApiClient.runtime.fn(
  ({ owner, request }: { readonly owner: Owner; readonly request: PairingRequest }) =>
    Effect.gen(function* () {
      const { pairingSecret, ...machine } = request;
      const sealed = yield* keys(() => approvePairing(owner, { ...machine, pairingSecret }));
      return yield* ApiClient.use(client =>
        client.credentials.pair({ payload: { ...machine, ...sealed } }),
      );
    }).pipe(faultsAsDefects),
  { reactivityKeys: ['machines', 'audit'] },
);

export const revokeMachineAtom = ApiClient.runtime.fn(
  (id: string) =>
    ApiClient.use(client => client.credentials.revoke({ params: { id } })).pipe(faultsAsDefects),
  { reactivityKeys: ['machines', 'grants', 'requests', 'audit'] },
);

type Reader = Pick<Grant, 'credentialId' | 'credentialPublicKey' | 'endorsement'>;

/** A grant for a machine the vault vouches for: the proof of the project's key, and the wrap when it may read. */
const grantFor = Effect.fnUntraced(function* (
  owner: Owner,
  projectId: string,
  reader: Reader,
  canRead: boolean,
) {
  const { owned, keyVersion } = yield* ownedProject(owner, projectId);
  const grant = yield* keys(() =>
    grantToMachine(
      owner,
      owned,
      {
        id: reader.credentialId,
        publicKey: reader.credentialPublicKey,
        endorsement: reader.endorsement,
      },
      { canRead },
    ),
  );
  return { ...grant, keyVersion };
});

export const setGrantAtom = ApiClient.runtime.fn(
  ({
    owner,
    project,
    reader,
    canRead,
    canWrite,
  }: {
    readonly owner: Owner;
    readonly project: Project;
    readonly reader: Reader;
    readonly canRead: boolean;
    readonly canWrite: boolean;
  }) =>
    Effect.gen(function* () {
      const wrap = yield* grantFor(owner, project.id, reader, canRead);
      return yield* ApiClient.use(client =>
        client.projects.setGrant({
          params: { id: project.id, credentialId: reader.credentialId },
          payload: { canWrite, ...wrap },
        }),
      );
    }).pipe(faultsAsDefects),
  { reactivityKeys: ['grants', 'machines', 'audit'] },
);

export const removeGrantAtom = ApiClient.runtime.fn(
  (params: { readonly id: string; readonly credentialId: string }) =>
    ApiClient.use(client => client.projects.removeGrant({ params })).pipe(faultsAsDefects),
  { reactivityKeys: ['grants', 'machines', 'audit'] },
);

// --- requests ----------------------------------------------------------------------------------

export const accessRequestsAtom = ApiClient.query('accessRequests', 'list', {
  reactivityKeys: ['requests'],
}).pipe(Atom.mapResult(({ requests }) => requests));

export const pasteRequestsAtom = ApiClient.query('pasteRequests', 'list', {
  reactivityKeys: ['requests'],
}).pipe(Atom.mapResult(({ requests }) => requests));

/** One per request, so answering one never interrupts another. */
export const approveAccessAtom = Atom.family((id: string) =>
  ApiClient.runtime.fn(
    ({
      owner,
      request,
      project,
    }: {
      readonly owner: Owner;
      readonly request: AccessRequest;
      readonly project: Project;
    }) =>
      Effect.gen(function* () {
        const wrap = yield* grantFor(owner, project.id, request, request.wantsRead);
        return yield* ApiClient.use(client =>
          client.accessRequests.approve({
            params: { id },
            payload: { canWrite: request.wantsWrite, ...wrap },
          }),
        );
      }).pipe(faultsAsDefects),
    { reactivityKeys: ['requests', 'grants', 'machines', 'audit'] },
  ),
);

export const denyAccessAtom = Atom.family((id: string) =>
  ApiClient.runtime.fn(
    () =>
      ApiClient.use(client => client.accessRequests.deny({ params: { id } })).pipe(faultsAsDefects),
    { reactivityKeys: ['requests', 'audit'] },
  ),
);

export const cancelPasteAtom = Atom.family((id: string) =>
  ApiClient.runtime.fn(
    () =>
      ApiClient.use(client => client.pasteRequests.cancel({ params: { id } })).pipe(
        faultsAsDefects,
      ),
    { reactivityKeys: ['requests', 'audit'] },
  ),
);

// --- the paste page ----------------------------------------------------------------------------

/** How the page is allowed to answer: the link's token and the key fingerprint it carries, or the owner's session. */
export type PasteAccess = {
  readonly id: string;
  readonly token: string | undefined;
  readonly fingerprint: string | undefined;
};

const tokenHeader = (token: string | undefined) =>
  token === undefined ? {} : { 'x-baymutt-paste-token': token };

export const pasteTargetAtom = Atom.family(({ id, token }: PasteAccess) =>
  ApiClient.query('paste', 'target', {
    params: { id },
    headers: tokenHeader(token),
    reactivityKeys: ['paste'],
  }),
);

export const fulfilPasteAtom = ApiClient.runtime.fn(
  ({
    access: { id, token, fingerprint },
    owner,
    value,
  }: {
    readonly access: PasteAccess;
    readonly owner: Owner | null;
    readonly value: string;
  }) =>
    Effect.gen(function* () {
      const target = yield* ApiClient.use(client =>
        client.paste.target({ params: { id }, headers: tokenHeader(token) }),
      );
      // The key to seal to must be one the store could not have swapped: the one the owner's vault
      // proves, or the one the link named in its fragment, which never reached the store. The key
      // the store sent with the target is only ever compared with it.
      const projectPublicKey = yield* Effect.gen(function* () {
        // Someone signed in to an account of their own is, for this request, a link holder.
        if (owner !== null && owner.accountId === target.accountId) {
          const proven = yield* ownedProject(owner, target.request.projectId);
          return proven.keyVersion === target.keyVersion ? proven.publicKey : null;
        }
        if (fingerprint === undefined) return null;
        const shown = yield* keys(() => publicKeyFingerprint(target.projectPublicKey));
        return shown === fingerprint ? target.projectPublicKey : null;
      });
      if (projectPublicKey === null || projectPublicKey !== target.projectPublicKey) {
        return yield* new OwnerError({
          message:
            'The store shows a different project key than the one this request was made for. Nothing was sent.',
        });
      }
      const ciphertext = yield* keys(() =>
        sealValue({
          projectPublicKey,
          slot: {
            accountId: target.accountId,
            projectId: target.request.projectId,
            keyVersion: target.keyVersion,
            name: target.request.name,
            version: target.nextVersion,
          },
          value,
        }),
      );
      return yield* ApiClient.use(client =>
        client.paste.fulfil({
          params: { id },
          headers: tokenHeader(token),
          payload: { version: target.nextVersion, keyVersion: target.keyVersion, ciphertext },
        }),
      );
    }).pipe(faultsAsDefects),
  { reactivityKeys: ['paste', 'requests', 'secrets', 'audit'] },
);

// --- the audit log -----------------------------------------------------------------------------

export const auditAtom = Atom.family((projectId: string | null) =>
  ApiClient.query('audit', 'list', {
    query: { limit: 100, ...(projectId === null ? {} : { projectId }) },
    reactivityKeys: ['audit'],
  }).pipe(Atom.mapResult(({ events }) => events)),
);
