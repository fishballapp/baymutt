// Server state as atoms derived from the API definition, and the writes that change it. A write
// that needs the vault takes the owner in its argument: the open vault is never module state an
// atom reads behind a component's back.
import type { LoginGrant, PairingRequest, Project, ServiceAccount } from '@baymutt/api';
import {
  approvePairing,
  createProjectKey,
  endorsedReader,
  grantToTrustedReader,
  openOwnedProject,
  openValue,
  publicKeyFingerprint,
  sealValue,
  vouchedScopedReader,
} from '@baymutt/keys';
import * as Effect from 'effect/Effect';
import * as Atom from 'effect/reactivity/Atom';
import * as Reactivity from 'effect/reactivity/Reactivity';
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

type SecretKey = { readonly projectId: string; readonly name: string };

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

/** A login: made by `baymutt login` and approved here, so it has no parent. It holds every project. */
export const isLogin = (serviceAccount: Pick<ServiceAccount, 'parentId'>): boolean =>
  serviceAccount.parentId === null;

const listLogins = ApiClient.use(client => client.credentials.list()).pipe(
  Effect.map(({ credentials }) => credentials.filter(isLogin)),
);

/** A new project, its key made here and wrapped to the account and, in the same request, to every login. */
export const createProjectAtom = ApiClient.runtime.fn(
  ({ owner, name }: { readonly owner: Owner; readonly name: string }) =>
    Effect.gen(function* () {
      const id = crypto.randomUUID();
      const accountPublicKey = owner.accountKey.publicKey.toBase64({
        alphabet: 'base64url',
        omitPadding: true,
      });
      // Only a key the vault endorsed: the store cannot add a login of its own here.
      const listed = yield* listLogins;
      const logins = yield* keys(() =>
        Promise.all(listed.map(login => endorsedReader(owner, login))),
      );
      const { publicKey, grants } = yield* keys(() =>
        createProjectKey({
          voucherKey: owner.accountKey,
          binding: { accountId: owner.accountId, projectId: id, keyVersion: 1 },
          readers: [{ id: owner.accountId, publicKey: accountPublicKey }, ...logins],
        }),
      );
      const [own, ...forLogins] = grants;
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
            loginGrants: logins.flatMap((login, index) => {
              const grant = forLogins[index];
              return grant === undefined
                ? []
                : [{ credentialId: login.id, readWrap: grant.wrap, keyProof: grant.proof }];
            }),
          },
        }),
      );
    }).pipe(faultsAsDefects),
  { reactivityKeys: ['projects', 'serviceAccounts', 'grants'] },
);

export const deleteProjectAtom = ApiClient.runtime.fn(
  (id: string) =>
    ApiClient.use(client => client.projects.remove({ params: { id } })).pipe(faultsAsDefects),
  { reactivityKeys: ['projects', 'requests', 'serviceAccounts', 'grants', 'bin', 'audit'] },
);

// --- the bin -----------------------------------------------------------------------------------

export const binAtom = ApiClient.query('bin', 'list', { reactivityKeys: ['bin'] });

export const restoreProjectAtom = Atom.family((_id: string) =>
  ApiClient.runtime.fn(
    (id: string) =>
      ApiClient.use(client => client.projects.restore({ params: { id } })).pipe(faultsAsDefects),
    { reactivityKeys: ['projects', 'serviceAccounts', 'grants', 'bin', 'audit'] },
  ),
);

/** Removes a deleted project for good, with its secrets, versions and grants. */
export const purgeProjectAtom = Atom.family((_id: string) =>
  ApiClient.runtime.fn(
    (id: string) =>
      ApiClient.use(client => client.projects.purge({ params: { id } })).pipe(faultsAsDefects),
    { reactivityKeys: ['serviceAccounts', 'grants', 'bin', 'audit'] },
  ),
);

/** A deleted secret comes back as its newest version, with every version kept. */
export const restoreSecretAtom = Atom.family((_slot: string) =>
  ApiClient.runtime.fn(
    ({ version, ...params }: SecretKey & { readonly version: number }) =>
      ApiClient.use(client =>
        client.secrets.rollback({ params, payload: { version, fromBin: true } }),
      ).pipe(faultsAsDefects),
    { reactivityKeys: ['secrets', 'projects', 'bin', 'audit'] },
  ),
);

/** Removes a deleted secret for good, every version. */
export const purgeSecretAtom = Atom.family((_slot: string) =>
  ApiClient.runtime.fn(
    (params: SecretKey) =>
      ApiClient.use(client => client.secrets.purge({ params })).pipe(faultsAsDefects),
    { reactivityKeys: ['bin', 'audit'] },
  ),
);

/**
 * The project as the owner's vault proves it: the public key its creator vouched for (the owner,
 * or a service account the vault endorsed) and the private key the owner's wrap opens to. Nothing the
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
  const { publicKey, key } = yield* keys(() => openOwnedProject(owner, owned));
  return { owned, publicKey, key, keyVersion };
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

/**
 * One version's value, opened here with the project key the vault just proved. The store logs the
 * request and never sees the value. One per secret, and nothing keeps it: a row resets it on hide
 * and when it unmounts, and locking the vault unmounts every row.
 */
export const revealSecretAtom = Atom.family((_slot: string) =>
  ApiClient.runtime.fn(
    ({
      owner,
      projectId,
      name,
      version,
    }: SecretKey & { readonly owner: Owner; readonly version: number }) =>
      Effect.gen(function* () {
        const { key } = yield* ownedProject(owner, projectId);
        const sealed = yield* ApiClient.use(client =>
          client.secrets.reveal({ params: { projectId, name }, payload: { version } }),
        );
        return yield* keys(
          () =>
            openValue({
              projectKey: key,
              slot: {
                accountId: owner.accountId,
                projectId,
                keyVersion: sealed.keyVersion,
                name,
                // The version asked for, not the one the store says it answered: another
                // version's ciphertext must not open under this one's label.
                version,
              },
              ciphertext: sealed.ciphertext,
            }),
          'The store answered a value that does not open with this project’s key.',
        );
      }).pipe(faultsAsDefects),
    { reactivityKeys: ['audit'] },
  ),
);

export const removeSecretAtom = ApiClient.runtime.fn(
  (params: SecretKey) =>
    ApiClient.use(client => client.secrets.remove({ params })).pipe(faultsAsDefects),
  { reactivityKeys: ['secrets', 'projects', 'bin', 'audit'] },
);

export const rollbackSecretAtom = ApiClient.runtime.fn(
  ({ version, ...params }: SecretKey & { readonly version: number }) =>
    ApiClient.use(client => client.secrets.rollback({ params, payload: { version } })).pipe(
      faultsAsDefects,
    ),
  { reactivityKeys: ['secrets', 'projects', 'bin', 'audit'] },
);

// --- service accounts and access -----------------------------------------------------------------------

export const serviceAccountsAtom = ApiClient.query('credentials', 'list', {
  reactivityKeys: ['serviceAccounts', 'grants'],
}).pipe(Atom.mapResult(({ credentials }) => credentials));

/**
 * Approves a pairing link: the vault vouches for the login's key, tells it which account key to
 * trust, and wraps every project to it. One request, so the store has it approved with all of
 * them or not at all. Its key is trusted because the owner just compared its code. One per
 * link, so a second link opened in the same tab starts unanswered.
 */
export const pairAtom = Atom.family((_credentialId: string) =>
  ApiClient.runtime.fn(
    ({
      owner,
      request,
      expiresAt,
    }: {
      readonly owner: Owner;
      readonly request: PairingRequest;
      /** The owner's choice, which may differ from what the terminal asked for. */
      readonly expiresAt: number | null;
    }) =>
      Effect.gen(function* () {
        const { pairingSecret, expiresAt: _asked, ...serviceAccount } = request;
        const reader = { id: serviceAccount.id, publicKey: serviceAccount.publicKey };
        const { projects } = yield* ApiClient.use(client => client.projects.list());
        const grants = yield* Effect.forEach(
          projects,
          project => loginGrant(owner, project.id, reader),
          { concurrency: 6 },
        );
        const sealed = yield* keys(() =>
          approvePairing(owner, { ...serviceAccount, pairingSecret }),
        );
        return yield* ApiClient.use(client =>
          client.credentials.pair({
            payload: {
              ...serviceAccount,
              ...sealed,
              ...(expiresAt === null ? {} : { expiresAt }),
              grants,
            },
          }),
        );
      }).pipe(faultsAsDefects),
    { reactivityKeys: ['serviceAccounts', 'grants', 'audit'] },
  ),
);

/** Read and write on one project for a login whose key the owner trusts. */
const loginGrant = Effect.fnUntraced(function* (
  owner: Owner,
  projectId: string,
  reader: { readonly id: string; readonly publicKey: string },
) {
  const { owned, keyVersion } = yield* ownedProject(owner, projectId);
  const { keyProof, readWrap } = yield* keys(() =>
    grantToTrustedReader(owner, owned, reader, { canRead: true }),
  );
  if (readWrap === null) return yield* Effect.die('a read grant came without its wrap');
  return { projectId, keyVersion, keyProof, readWrap } satisfies LoginGrant;
});

/**
 * Grants each login every project it lacks: the ones a service account made since, which only
 * the owner's vault can wrap to another login. Runs whenever the vault is open; what fails is
 * tried again next time.
 */
export const topUpLoginsAtom = ApiClient.runtime.fn(
  (owner: Owner) =>
    Effect.gen(function* () {
      const [{ credentials }, { projects }] = yield* Effect.all(
        [
          ApiClient.use(client => client.credentials.list()),
          ApiClient.use(client => client.projects.list()),
        ],
        { concurrency: 2 },
      );
      const missing = credentials.filter(isLogin).flatMap(login =>
        projects
          .filter(project => {
            const held = login.grants.find(grant => grant.projectId === project.id);
            return !(held?.canRead && held.canWrite);
          })
          .map(project => ({ login, project })),
      );
      yield* Effect.forEach(
        missing,
        ({ login, project }) =>
          Effect.gen(function* () {
            const reader = yield* keys(() => endorsedReader(owner, login));
            const { projectId, ...grant } = yield* loginGrant(owner, project.id, reader);
            yield* ApiClient.use(client =>
              client.projects.setGrant({
                params: { id: projectId, credentialId: login.id },
                payload: { canWrite: true, ...grant },
              }),
            );
          }),
        { concurrency: 4 },
      );
      return missing.length;
    }).pipe(faultsAsDefects),
  { reactivityKeys: ['serviceAccounts', 'grants', 'requests', 'audit'] },
);

export const setExpiryAtom = ApiClient.runtime.fn(
  ({ id, expiresAt }: { readonly id: string; readonly expiresAt: number | null }) =>
    ApiClient.use(client =>
      client.credentials.setExpiry({ params: { id }, payload: { expiresAt } }),
    ).pipe(faultsAsDefects),
  { reactivityKeys: ['serviceAccounts', 'audit'] },
);

export const revokeServiceAccountAtom = ApiClient.runtime.fn(
  (id: string) =>
    ApiClient.use(client => client.credentials.revoke({ params: { id } })).pipe(faultsAsDefects),
  { reactivityKeys: ['serviceAccounts', 'grants', 'requests', 'audit'] },
);

/** What a scoped service account is to hold on one project; neither read nor write takes it away. */
export type AccessChange = {
  readonly projectId: string;
  readonly canRead: boolean;
  readonly canWrite: boolean;
};

/** Whether the login that made it vouched for its key, so a read or a project it gains can be wrapped to it. */
export const isVouched = (serviceAccount: Pick<ServiceAccount, 'keyVoucher'>): boolean =>
  serviceAccount.keyVoucher !== null;

/**
 * Changes a scoped service account's access, keeping its key. A read or a project it gains is
 * wrapped and vouched for to the key its maker vouched for to the account, which the vault trusts
 * through its endorsement of that login: never to the key the store lists.
 */
export const changeAccessAtom = ApiClient.runtime.fn(
  ({
    owner,
    serviceAccount,
    maker,
    changes,
  }: {
    readonly owner: Owner;
    readonly serviceAccount: ServiceAccount;
    readonly maker: ServiceAccount;
    readonly changes: ReadonlyArray<AccessChange>;
  }) =>
    Effect.gen(function* () {
      const gains = (change: AccessChange) => {
        const held = serviceAccount.grants.find(grant => grant.projectId === change.projectId);
        const removes = !change.canRead && !change.canWrite;
        return {
          project: !removes && held === undefined,
          read: change.canRead && !held?.canRead,
        };
      };
      const needsKey = changes.some(change => gains(change).project || gains(change).read);
      const reader = needsKey
        ? yield* keys(
            () => vouchedScopedReader(owner, { serviceAccount, maker }),
            'Nothing vouches for this service account’s key, so it cannot be given a read or a project. Nothing was changed.',
          )
        : null;
      // Every wrap and proof is made before the first request, so a vault failure changes nothing.
      const prepared = yield* Effect.forEach(changes, change =>
        Effect.gen(function* () {
          const gained = gains(change);
          if (reader === null || !(gained.project || gained.read)) return { change, sealed: null };
          const { owned } = yield* ownedProject(owner, change.projectId);
          const sealed = yield* keys(() =>
            grantToTrustedReader(owner, owned, reader, { canRead: gained.read }),
          );
          return { change, sealed };
        }),
      );
      for (const { change, sealed } of prepared) {
        const { projectId, canRead, canWrite } = change;
        const params = { id: serviceAccount.id, projectId };
        if (!canRead && !canWrite) {
          yield* ApiClient.use(client => client.credentials.removeAccess({ params }));
          continue;
        }
        yield* ApiClient.use(client =>
          client.credentials.setAccess({
            params,
            payload: {
              canRead,
              canWrite,
              ...(sealed !== null && gains(change).project ? { keyProof: sealed.keyProof } : {}),
              ...(sealed?.readWrap ? { readWrap: sealed.readWrap } : {}),
            },
          }),
        );
      }
    }).pipe(
      // Changes are sent one by one, so a failure part-way leaves the earlier ones made: show them.
      Effect.onError(() => Reactivity.invalidate(['serviceAccounts', 'grants', 'audit'])),
      faultsAsDefects,
    ),
  { reactivityKeys: ['serviceAccounts', 'grants', 'audit'] },
);

export const removeGrantAtom = ApiClient.runtime.fn(
  (params: { readonly id: string; readonly credentialId: string }) =>
    ApiClient.use(client => client.projects.removeGrant({ params })).pipe(faultsAsDefects),
  { reactivityKeys: ['grants', 'serviceAccounts', 'audit'] },
);

// --- requests ----------------------------------------------------------------------------------

export const pasteRequestsAtom = ApiClient.query('pasteRequests', 'list', {
  reactivityKeys: ['requests'],
}).pipe(Atom.mapResult(({ requests }) => requests));

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
