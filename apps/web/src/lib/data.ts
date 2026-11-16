// Server state as atoms derived from the API definition, and the writes that change it. A write
// that needs the vault takes the owner in its argument: the open vault is never module state an
// atom reads behind a component's back. A list that shows names is a family keyed by the owner,
// since only the open vault opens them.
import {
  type ActivityEvent,
  type BinEnvironment,
  type BinSecret,
  type Environment,
  EnvironmentNameSchema,
  type EnvironmentRequest,
  type Org,
  type OrgNamesKeyWrap,
  type PairingRequest,
  type PasteLink,
  type Request,
  type RequestItem,
  type Secret,
  type ServiceAccount,
} from '@baymutt/api';
import {
  approvePairing,
  createEnvironmentKey,
  createNamesKey,
  endorsedReader,
  grantToTrustedReader,
  type NamesKey,
  openName,
  openNamesKey,
  openOwnedEnvironment,
  openValue,
  rewrapNamesKey,
  sealName,
  sealValue,
  vouchedScopedReader,
} from '@baymutt/keys';
import * as Effect from 'effect/Effect';
import * as Atom from 'effect/reactivity/Atom';
import * as Reactivity from 'effect/reactivity/Reactivity';
import * as Schema from 'effect/Schema';
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

// --- names -------------------------------------------------------------------------------------

/**
 * Each sealed org's names key, by org id. An org missing from `opened` has not sealed its names
 * yet, unless this browser has seen it sealed: then the store withheld its key.
 */
type NamesKeys = {
  readonly opened: ReadonlyMap<string, NamesKey>;
  /** Every org whose names key this browser has opened for the account. */
  readonly seenSealed: ReadonlySet<string>;
};

const accountPublicKey = (owner: Owner) =>
  owner.accountKey.publicKey.toBase64({ alphabet: 'base64url', omitPadding: true });

const SEALED_ORGS = (accountId: string) => `baymutt.sealedOrgs.${accountId}`;

/**
 * The orgs this browser has seen sealed for the account. Only the store says an org is not sealed,
 * so once one was seen sealed, an answer without its names key is the store withholding it: never
 * a reason to take its names as written.
 */
const seenSealedOrgs = (owner: Owner): ReadonlySet<string> => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(SEALED_ORGS(owner.accountId)) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
};

const rememberSealed = (owner: Owner, orgIds: Iterable<string>): ReadonlySet<string> => {
  const seen = seenSealedOrgs(owner).union(new Set(orgIds));
  localStorage.setItem(SEALED_ORGS(owner.accountId), JSON.stringify([...seen]));
  return seen;
};

const NAMES_WITHHELD = () =>
  new OwnerError({
    message: 'The store did not hand over this org’s names. Nothing was changed.',
  });

/**
 * An org's names key for a write: null only for an org not sealed yet, and refused for one this
 * browser has seen sealed whose key the store did not hand over.
 */
const namesKeyFor = (namesKeys: NamesKeys, orgId: string) => {
  const namesKey = namesKeys.opened.get(orgId);
  if (namesKey !== undefined) return Effect.succeed(namesKey);
  return namesKeys.seenSealed.has(orgId) ? Effect.fail(NAMES_WITHHELD()) : Effect.succeed(null);
};

/**
 * The owner's own copies, opened with the account key itself: never a key the store vouches for.
 * Every org whose key opens is remembered as sealed in this browser.
 */
const openNamesKeys = (owner: Owner, wraps: ReadonlyArray<OrgNamesKeyWrap>) =>
  keys(async (): Promise<NamesKeys> => {
    const opened = new Map(
      await Promise.all(
        wraps.map(
          async ({ orgId, wrap }) =>
            [
              orgId,
              await openNamesKey({
                wrap,
                orgId,
                readerKey: owner.accountKey,
                readerId: owner.accountId,
                accountPublicKey: accountPublicKey(owner),
              }),
            ] as const,
        ),
      ),
    );
    return { opened, seenSealed: rememberSealed(owner, opened.keys()) };
  }, 'An org’s names do not open with your vault, so they cannot be shown. Nothing was changed.');

/** The names keys as they are now, with the owner's own wraps: for a write, never a cached copy. */
const currentNamesKeys = Effect.fnUntraced(function* (owner: Owner) {
  const { namesKeys = [] } = yield* ApiClient.use(client => client.environments.list());
  return { wraps: namesKeys, namesKeys: yield* openNamesKeys(owner, namesKeys) };
});

/** A name as the store keeps it: its index and the sealed name, or the name itself in an org not sealed yet. */
type Stored = {
  readonly orgId: string;
  readonly scopeId: string;
  readonly name: string;
  readonly sealedName?: string | null | undefined;
};

/**
 * The name a stored one stands for, or null when it does not open, or its org's names key was
 * withheld: the page shows that rather than whatever the store sent.
 */
const openStored = (
  namesKeys: NamesKeys,
  { orgId, scopeId, name, sealedName }: Stored,
): Promise<string | null> => {
  const namesKey = namesKeys.opened.get(orgId) ?? null;
  if (namesKey === null && namesKeys.seenSealed.has(orgId)) return Promise.resolve(null);
  return openName(namesKey, {
    scopeId,
    stored: { name, sealedName: sealedName ?? null },
  }).catch(() => null);
};

/** Shown in place of a name that does not open. It holds a space, so no real name looks like it. */
export const NAME_NOT_OPENED = 'name does not open';

/** An environment as it is named everywhere a name is shown: `<org slug>/<name>`. */
export const addressOf = ({
  orgSlug,
  name,
}: {
  readonly orgSlug: string;
  readonly name: string | null;
}): string => `${orgSlug}/${name ?? NAME_NOT_OPENED}`;

/** By opened name; one that does not open goes last. */
const byName =
  <A>(nameOf: (item: A) => string | null) =>
  (a: A, b: A): number =>
    (nameOf(a) ?? '￿').localeCompare(nameOf(b) ?? '￿');

const environmentListAtom = ApiClient.query('environments', 'list', {
  reactivityKeys: ['environments'],
});

/** The open vault's names keys, from the same list the environments come in. */
export const namesKeysAtom = Atom.family((owner: Owner) =>
  ApiClient.runtime.atom(get =>
    Effect.gen(function* () {
      const { namesKeys = [] } = yield* get.result(environmentListAtom);
      return yield* openNamesKeys(owner, namesKeys);
    }),
  ),
);

/** Opens every item of a list the store sent, with the names keys the vault holds. */
const opening = <Raw, A, E>(
  owner: Owner,
  read: (get: Atom.AtomContext) => Effect.Effect<Raw, E>,
  open: (raw: Raw, namesKeys: NamesKeys) => Promise<A>,
) =>
  ApiClient.runtime.atom(get =>
    Effect.gen(function* () {
      const raw = yield* read(get);
      const namesKeys = yield* get.result(namesKeysAtom(owner));
      return yield* Effect.promise(() => open(raw, namesKeys));
    }),
  );

// --- orgs --------------------------------------------------------------------------------------

export const orgsAtom = ApiClient.query('orgs', 'list', { reactivityKeys: ['orgs'] }).pipe(
  Atom.mapResult(({ orgs }) => orgs),
);

const PICKED_ORG = 'baymutt.org';

/** The org the picker shows, by id, as this browser last picked it. */
export const pickedOrgIdAtom = Atom.make<string | null>(localStorage.getItem(PICKED_ORG)).pipe(
  Atom.keepAlive,
);

export const rememberPickedOrg = (id: string) => localStorage.setItem(PICKED_ORG, id);

/** The picked org, or the first when the one picked is gone or none was. */
export const pickedOrg = (orgs: ReadonlyArray<Org>, pickedId: string | null): Org | null =>
  orgs.find(org => org.id === pickedId) ?? orgs[0] ?? null;

/** A CLI login: made by `baymutt auth login` and approved here, so it has no parent. It holds no environment. */
export const isLogin = (serviceAccount: Pick<ServiceAccount, 'parentId'>): boolean =>
  serviceAccount.parentId === null;

/** Who gets an org's names key when it is sealed, and who could not be given it. */
type NamesReaders = {
  readonly readers: ReadonlyArray<{ readonly id: string; readonly publicKey: string }>;
  /** A CLI login or service account whose key the vault cannot verify: it is left out. */
  readonly leftOut: ReadonlyArray<string>;
};

/**
 * Everyone who may list an org's names, each by a key the vault trusts: the owner's account,
 * every CLI login the vault approved, and every service account, by the key its CLI login vouched
 * for. Every service account, not only those the store lists in the org: one whose environment
 * there is in the bin lists it again once it is restored. A request's key still waiting gets the
 * names key when it is approved. One whose key cannot be verified is left out, never trusted on
 * the store's word; it is named only if it reaches the org.
 */
const namesReaders = Effect.fnUntraced(function* (owner: Owner, orgId: string) {
  const [{ credentials }, { requests }] = yield* ApiClient.use(client =>
    Effect.all([client.credentials.list(), client.requests.list()]),
  );
  const waiting = new Set(requests.map(({ id }) => id));
  const readerOf = (
    serviceAccount: ServiceAccount,
  ): Effect.Effect<NamesReaders['readers'][number] | null, OwnerError> => {
    if (isLogin(serviceAccount)) return keys(() => endorsedReader(owner, serviceAccount));
    const maker = credentials.find(({ id }) => id === serviceAccount.parentId);
    return maker === undefined
      ? Effect.succeed(null)
      : keys(() => vouchedScopedReader(owner, { serviceAccount, maker }));
  };
  const verified = yield* Effect.forEach(
    credentials.filter(({ id }) => !waiting.has(id)),
    serviceAccount =>
      readerOf(serviceAccount).pipe(
        Effect.orElseSucceed(() => null),
        Effect.map(reader => ({
          reader,
          name: serviceAccount.name,
          isNamed:
            isLogin(serviceAccount) || serviceAccount.grants.some(grant => grant.orgId === orgId),
        })),
      ),
  );
  return {
    readers: [
      { id: owner.accountId, publicKey: accountPublicKey(owner) },
      ...verified.flatMap(({ reader }) => (reader === null ? [] : [reader])),
    ],
    leftOut: verified.flatMap(({ reader, name, isNamed }) =>
      reader === null && isNamed ? [name] : [],
    ),
  } satisfies NamesReaders;
});

/**
 * Seals an org's names, once: a new names key wrapped to everyone who may list them, and every
 * name the org stores as written, sealed and indexed. One write, so the store has them sealed
 * together or not at all; when another tab or a second run got there first, the store refuses
 * this one and the names are already sealed.
 */
const sealOrg = Effect.fnUntraced(function* (owner: Owner, org: Pick<Org, 'id' | 'name'>) {
  const unsealed = yield* ApiClient.use(client =>
    client.orgs.unsealedNames({ params: { id: org.id } }),
  );
  const { readers, leftOut } = yield* namesReaders(owner, org.id);
  const sealed = yield* keys(async () => {
    const { namesKey, wraps } = await createNamesKey({
      accountKey: owner.accountKey,
      orgId: org.id,
      readers,
    });
    return {
      wraps,
      environments: await Promise.all(
        unsealed.environments.map(async ({ id, name }) => ({
          id,
          ...(await sealName(namesKey, { scopeId: org.id, name })),
        })),
      ),
      secrets: await Promise.all(
        unsealed.secrets.map(async ({ environmentId, name }) => ({
          environmentId,
          unsealedName: name,
          ...(await sealName(namesKey, { scopeId: environmentId, name })),
        })),
      ),
    };
  });
  const isSealed = yield* ApiClient.use(client =>
    client.orgs.sealNames({ params: { id: org.id }, payload: sealed }),
  ).pipe(
    Effect.as(true),
    Effect.catchTag('AlreadyExistsError', () => Effect.succeed(false)),
  );
  // Sealed by this write or by one that landed first: either way, sealed from now on.
  rememberSealed(owner, [org.id]);
  return { org: org.name, leftOut: isSealed ? leftOut : [] };
});

/**
 * Seals every org of the owner's that has not sealed its names yet. Safe to run twice and from two
 * tabs. Answers who was left out in each org it sealed. An org this browser has seen sealed is
 * never sealed again on the store's word: that would seal whatever names the store now shows.
 */
export const sealOrgsAtom = ApiClient.runtime.fn(
  (owner: Owner) =>
    Effect.gen(function* () {
      const { orgs } = yield* ApiClient.use(client => client.orgs.list());
      const seenSealed = seenSealedOrgs(owner);
      const sealed = yield* Effect.forEach(
        orgs.filter(org => !org.areNamesSealed && !seenSealed.has(org.id)),
        org => sealOrg(owner, org),
      );
      return sealed.filter(({ leftOut }) => leftOut.length > 0);
    }).pipe(faultsAsDefects),
  {
    reactivityKeys: [
      'orgs',
      'environments',
      'secrets',
      'bin',
      'pasteLinks',
      'requests',
      'serviceAccounts',
      'audit',
    ],
  },
);

/** A new org, sealed at once while it holds no name. */
export const createOrgAtom = ApiClient.runtime.fn(
  ({ owner, ...org }: { readonly owner: Owner; readonly name: string; readonly slug: string }) =>
    Effect.gen(function* () {
      const created = yield* ApiClient.use(client => client.orgs.create({ payload: org }));
      yield* sealOrg(owner, created);
      return created;
    }).pipe(faultsAsDefects),
  { reactivityKeys: ['orgs', 'environments', 'audit'] },
);

export const deleteOrgAtom = Atom.family((_id: string) =>
  ApiClient.runtime.fn(
    (id: string) =>
      ApiClient.use(client => client.orgs.remove({ params: { id } })).pipe(faultsAsDefects),
    // Deleting an org also removes the environment requests waiting in it.
    { reactivityKeys: ['orgs', 'environmentRequests', 'audit'] },
  ),
);

// --- environments and secrets ----------------------------------------------------------------------

/** A thing the store names, with its name opened here: null when it does not open. */
type Opened<A> = A & { readonly openedName: string | null };

export type OpenedEnvironment = Opened<Environment>;

const openEnvironment = async (
  environment: Environment,
  namesKeys: NamesKeys,
): Promise<OpenedEnvironment> => ({
  ...environment,
  openedName: await openStored(namesKeys, { ...environment, scopeId: environment.orgId }),
});

/** Every environment of the owner's orgs, sorted by name. */
export const environmentsAtom = Atom.family((owner: Owner) =>
  opening(
    owner,
    get => get.result(environmentListAtom),
    async ({ environments }, namesKeys) =>
      (
        await Promise.all(environments.map(environment => openEnvironment(environment, namesKeys)))
      ).toSorted(byName(({ openedName }) => openedName)),
  ),
);

const environmentQuery = Atom.family((id: string) =>
  ApiClient.query('environments', 'get', { params: { id }, reactivityKeys: ['environments'] }),
);

export const environmentAtom = Atom.family((owner: Owner) =>
  Atom.family((id: string) =>
    opening(owner, get => get.result(environmentQuery(id)), openEnvironment),
  ),
);

export type OpenedSecret = Opened<Secret>;

const secretsQuery = Atom.family((environmentId: string) =>
  ApiClient.query('secrets', 'list', { params: { environmentId }, reactivityKeys: ['secrets'] }),
);

/** An environment's secrets, the bin's among them, sorted by name. */
export const secretsAtom = Atom.family((owner: Owner) =>
  Atom.family((environmentId: string) =>
    opening(
      owner,
      get =>
        Effect.all([
          get.result(environmentQuery(environmentId)),
          get.result(secretsQuery(environmentId)),
        ]),
      async ([{ orgId }, { secrets }], namesKeys): Promise<ReadonlyArray<OpenedSecret>> =>
        (
          await Promise.all(
            secrets.map(async secret => ({
              ...secret,
              openedName: await openStored(namesKeys, {
                ...secret,
                orgId,
                scopeId: environmentId,
              }),
            })),
          )
        ).toSorted(byName(({ openedName }) => openedName)),
    ),
  ),
);

/** A secret as a route names it: by the name the store keeps. */
type SecretKey = { readonly environmentId: string; readonly name: string };

export const versionsAtom = Atom.family(({ environmentId, name }: SecretKey) =>
  ApiClient.query('secrets', 'versions', {
    params: { environmentId, name },
    reactivityKeys: ['secrets'],
  }).pipe(Atom.mapResult(({ versions }) => versions)),
);

export const grantsAtom = Atom.family((id: string) =>
  ApiClient.query('environments', 'grants', { params: { id }, reactivityKeys: ['grants'] }).pipe(
    Atom.mapResult(({ grants }) => grants),
  ),
);

const NOT_SEALED_YET = (what: string) =>
  new OwnerError({
    message: `This org’s names are being sealed, so ${what} cannot be made yet. Try again in a moment.`,
  });

/**
 * Makes an environment under a name already sealed: its key pair made here, held by the owner
 * alone. With `answers`, it approves that environment request in the same write.
 */
const makeEnvironment = Effect.fnUntraced(function* (
  owner: Owner,
  environment: {
    readonly id: string;
    readonly orgId: string;
    readonly name: string;
    readonly sealedName: string;
    readonly answers?: string;
  },
) {
  const key = yield* keys(() =>
    createEnvironmentKey({
      voucherKey: owner.accountKey,
      binding: { environmentId: environment.id, keyVersion: 1 },
      readers: [{ id: owner.accountId, publicKey: accountPublicKey(owner) }],
    }),
  );
  const [own] = key.grants;
  if (own === undefined) return yield* Effect.die('an environment key came with no grant');
  return yield* ApiClient.use(client =>
    client.environments.create({
      payload: {
        ...environment,
        publicKey: key.publicKey,
        memberWrap: own.wrap,
        memberProof: own.proof,
      },
    }),
  );
});

/** A new environment in an org: its name sealed here. */
export const createEnvironmentAtom = ApiClient.runtime.fn(
  ({
    owner,
    orgId,
    name,
  }: {
    readonly owner: Owner;
    readonly orgId: string;
    readonly name: string;
  }) =>
    Effect.gen(function* () {
      const namesKey = yield* namesKeyFor((yield* currentNamesKeys(owner)).namesKeys, orgId);
      if (namesKey === null) return yield* NOT_SEALED_YET('an environment');
      const stored = yield* keys(() => sealName(namesKey, { scopeId: orgId, name }));
      return yield* makeEnvironment(owner, { id: crypto.randomUUID(), orgId, ...stored });
    }).pipe(faultsAsDefects),
  { reactivityKeys: ['environments', 'orgs', 'audit'] },
);

export const deleteEnvironmentAtom = ApiClient.runtime.fn(
  (id: string) =>
    ApiClient.use(client => client.environments.remove({ params: { id } })).pipe(faultsAsDefects),
  {
    reactivityKeys: [
      'environments',
      'pasteLinks',
      'serviceAccounts',
      'grants',
      'bin',
      'orgs',
      'audit',
    ],
  },
);

// --- the bin -----------------------------------------------------------------------------------

export type OpenedBinEnvironment = Opened<BinEnvironment>;
export type OpenedBinSecret = Opened<BinSecret> & { readonly openedEnvironmentName: string | null };

const binQuery = ApiClient.query('bin', 'list', { reactivityKeys: ['bin'] });

export const binAtom = Atom.family((owner: Owner) =>
  opening(
    owner,
    get => get.result(binQuery),
    async ({ environments, secrets }, namesKeys) => ({
      environments: await Promise.all(
        environments.map(
          async (environment): Promise<OpenedBinEnvironment> => ({
            ...environment,
            openedName: await openStored(namesKeys, { ...environment, scopeId: environment.orgId }),
          }),
        ),
      ),
      secrets: await Promise.all(
        secrets.map(
          async (secret): Promise<OpenedBinSecret> => ({
            ...secret,
            openedName: await openStored(namesKeys, { ...secret, scopeId: secret.environmentId }),
            openedEnvironmentName: await openStored(namesKeys, {
              orgId: secret.orgId,
              scopeId: secret.orgId,
              name: secret.environmentName,
              sealedName: secret.environmentSealedName,
            }),
          }),
        ),
      ),
    }),
  ),
);

export const restoreEnvironmentAtom = Atom.family((_id: string) =>
  ApiClient.runtime.fn(
    (id: string) =>
      ApiClient.use(client => client.environments.restore({ params: { id } })).pipe(
        faultsAsDefects,
      ),
    { reactivityKeys: ['environments', 'serviceAccounts', 'grants', 'bin', 'orgs', 'audit'] },
  ),
);

/** Removes a deleted environment for good, with its secrets, versions and grants. */
export const purgeEnvironmentAtom = Atom.family((_id: string) =>
  ApiClient.runtime.fn(
    (id: string) =>
      ApiClient.use(client => client.environments.purge({ params: { id } })).pipe(faultsAsDefects),
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
    { reactivityKeys: ['secrets', 'environments', 'bin', 'audit'] },
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

// --- values ------------------------------------------------------------------------------------

/**
 * The environment as the owner's vault proves it: the public key its creator vouched for (the owner,
 * or a CLI login the vault endorsed) and the private key the owner's member copy opens to. Nothing
 * the store lists beside the environment is used past this point.
 */
const ownedEnvironment = Effect.fnUntraced(function* (owner: Owner, environmentId: string) {
  const { memberWrap, memberProof, keyVersion, creator } = yield* ApiClient.use(client =>
    client.environments.memberWrap({ params: { id: environmentId } }),
  );
  const owned = { environmentId, keyVersion, memberWrap, memberProof, creator };
  const { publicKey, key } = yield* keys(() => openOwnedEnvironment(owner, owned));
  return { owned, publicKey, key, keyVersion };
});

/**
 * Seals `value` here, to a public key the vault has just proved, and writes it as the next
 * version. `name` is the name as typed: a new one is sealed for the store, and an existing one is
 * found by the index it already has.
 */
export const writeSecretAtom = ApiClient.runtime.fn(
  ({
    owner,
    environment,
    name,
    value,
  }: {
    readonly owner: Owner;
    readonly environment: Pick<Environment, 'id' | 'orgId'>;
    readonly name: string;
    readonly value: string;
  }) =>
    Effect.gen(function* () {
      const namesKey = yield* namesKeyFor(
        (yield* currentNamesKeys(owner)).namesKeys,
        environment.orgId,
      );
      const { keyVersion, publicKey } = yield* ownedEnvironment(owner, environment.id);
      const { secrets } = yield* ApiClient.use(client =>
        client.secrets.list({ params: { environmentId: environment.id } }),
      );
      // With no names key the name would go out as typed. Nothing trusted says the org is really
      // unsealed (a store could hide its names keys), so a name goes out only if the store already
      // listed it as written: a store that hides the sealing learns no name it did not hold.
      const isListedAsWritten = secrets.some(
        secret => secret.sealedName === null && secret.name === name,
      );
      if (namesKey === null && !isListedAsWritten) return yield* NOT_SEALED_YET('a new secret');
      const stored =
        namesKey === null
          ? { name, sealedName: null }
          : yield* keys(() => sealName(namesKey, { scopeId: environment.id, name }));
      const version = (secrets.find(secret => secret.name === stored.name)?.latestVersion ?? 0) + 1;
      const ciphertext = yield* keys(() =>
        sealValue({
          environmentPublicKey: publicKey,
          slot: { environmentId: environment.id, keyVersion, name, version },
          value,
        }),
      );
      return yield* ApiClient.use(client =>
        client.secrets.write({
          params: { environmentId: environment.id, name: stored.name },
          payload: {
            version,
            keyVersion,
            ciphertext,
            ...(stored.sealedName === null ? {} : { sealedName: stored.sealedName }),
          },
        }),
      );
    }).pipe(faultsAsDefects),
  { reactivityKeys: ['secrets', 'environments', 'audit'] },
);

/**
 * One version's value, opened here with the environment key the vault just proved. The store logs the
 * request and never sees the value. One per secret, and nothing keeps it: a row resets it on hide
 * and when it unmounts, and locking the vault unmounts every row.
 */
export const revealSecretAtom = Atom.family((_slot: string) =>
  ApiClient.runtime.fn(
    ({
      owner,
      environmentId,
      name,
      openedName,
      version,
    }: SecretKey & {
      readonly owner: Owner;
      /** The name the value was sealed under, as the names key opened it. */
      readonly openedName: string;
      readonly version: number;
    }) =>
      Effect.gen(function* () {
        const { key } = yield* ownedEnvironment(owner, environmentId);
        const sealed = yield* ApiClient.use(client =>
          client.secrets.reveal({ params: { environmentId, name }, payload: { version } }),
        );
        return yield* keys(
          () =>
            openValue({
              environmentKey: key,
              slot: {
                environmentId,
                keyVersion: sealed.keyVersion,
                name: openedName,
                // The version asked for, not the one the store says it answered: another
                // version's ciphertext must not open under this one's label.
                version,
              },
              ciphertext: sealed.ciphertext,
            }),
          'The store answered a value that does not open with this environment’s key.',
        );
      }).pipe(faultsAsDefects),
    { reactivityKeys: ['audit'] },
  ),
);

export const removeSecretAtom = ApiClient.runtime.fn(
  (params: SecretKey) =>
    ApiClient.use(client => client.secrets.remove({ params })).pipe(faultsAsDefects),
  { reactivityKeys: ['secrets', 'environments', 'bin', 'audit'] },
);

export const rollbackSecretAtom = ApiClient.runtime.fn(
  ({ version, ...params }: SecretKey & { readonly version: number }) =>
    ApiClient.use(client => client.secrets.rollback({ params, payload: { version } })).pipe(
      faultsAsDefects,
    ),
  { reactivityKeys: ['secrets', 'environments', 'bin', 'audit'] },
);

// --- CLI logins and service accounts -----------------------------------------------------------

type CredentialGrant = ServiceAccount['grants'][number];

export type OpenedGrant = CredentialGrant & { readonly openedEnvironmentName: string | null };
export type OpenedServiceAccount = Omit<ServiceAccount, 'grants'> & {
  readonly grants: ReadonlyArray<OpenedGrant>;
};

const openGrant = async (grant: CredentialGrant, namesKeys: NamesKeys): Promise<OpenedGrant> => ({
  ...grant,
  openedEnvironmentName: await openStored(namesKeys, {
    orgId: grant.orgId,
    scopeId: grant.orgId,
    name: grant.environmentName,
    sealedName: grant.environmentSealedName,
  }),
});

const requestListAtom = ApiClient.query('requests', 'list', { reactivityKeys: ['requests'] });

/** Requests waiting for the owner, as the nav counts them. */
export const pendingRequestsAtom = requestListAtom.pipe(
  Atom.mapResult(({ requests }) => requests.filter(({ status }) => status === 'pending')),
);

const credentialListAtom = ApiClient.query('credentials', 'list', {
  reactivityKeys: ['serviceAccounts', 'grants'],
});

/**
 * Every CLI login and service account. A request's key is listed under Requests until it is
 * approved, not here.
 */
export const serviceAccountsAtom = Atom.family((owner: Owner) =>
  opening(
    owner,
    get => Effect.all([get.result(credentialListAtom), get.result(requestListAtom)]),
    async (
      [{ credentials }, { requests }],
      namesKeys,
    ): Promise<ReadonlyArray<OpenedServiceAccount>> => {
      const waiting = new Set(requests.map(({ id }) => id));
      return Promise.all(
        credentials
          .filter(({ id }) => !waiting.has(id))
          .map(async serviceAccount => ({
            ...serviceAccount,
            grants: (
              await Promise.all(serviceAccount.grants.map(grant => openGrant(grant, namesKeys)))
            ).toSorted(byName(({ openedEnvironmentName }) => openedEnvironmentName)),
          })),
      );
    },
  ),
);

/**
 * Approves a pairing link: the vault vouches for the login's key, tells it which account key to
 * trust, and hands it the names key of every sealed org, so it can list names. It holds no
 * environment. One request, so the store has it approved with all of them or not at all. Its key
 * is trusted because the owner just compared its code. One per link, so a second link opened in
 * the same tab starts unanswered.
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
        const { wraps } = yield* currentNamesKeys(owner);
        const namesKeyWraps = yield* keys(() => rewrapAll(owner, wraps, reader));
        const sealed = yield* keys(() =>
          approvePairing(owner, { ...serviceAccount, pairingSecret }),
        );
        return yield* ApiClient.use(client =>
          client.credentials.pair({
            payload: {
              ...serviceAccount,
              ...sealed,
              ...(expiresAt === null ? {} : { expiresAt }),
              namesKeyWraps,
            },
          }),
        );
      }).pipe(faultsAsDefects),
    { reactivityKeys: ['serviceAccounts', 'audit'] },
  ),
);

/** The owner's own copy of each org's names key, wrapped again to one reader the owner trusts. */
const rewrapAll = (
  owner: Owner,
  wraps: ReadonlyArray<OrgNamesKeyWrap>,
  reader: { readonly id: string; readonly publicKey: string },
): Promise<ReadonlyArray<OrgNamesKeyWrap>> =>
  Promise.all(
    wraps.map(async ({ orgId, wrap }) => ({
      orgId,
      wrap: await rewrapNamesKey({
        ownWrap: wrap,
        orgId,
        accountKey: owner.accountKey,
        accountId: owner.accountId,
        reader,
      }),
    })),
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
  { reactivityKeys: ['serviceAccounts', 'grants', 'pasteLinks', 'requests', 'audit'] },
);

/** What a service account is to hold on one environment; neither read nor write takes it away. */
export type AccessChange = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly canRead: boolean;
  readonly canWrite: boolean;
};

/** Whether the login that asked for it vouched for its key, so a read or an environment it gains can be wrapped to it. */
export const isVouched = (serviceAccount: Pick<ServiceAccount, 'keyVoucher'>): boolean =>
  serviceAccount.keyVoucher !== null;

/**
 * Changes a service account's access, keeping its key. A read or an environment it gains is
 * wrapped and vouched for to the key its maker vouched for to the account, which the vault trusts
 * through its endorsement of that login: never to the key the store lists. An environment it
 * gains comes with its org's names key, so it can list the names there.
 */
export const changeAccessAtom = ApiClient.runtime.fn(
  ({
    owner,
    serviceAccount,
    maker,
    changes,
  }: {
    readonly owner: Owner;
    readonly serviceAccount: ServiceAccount | OpenedServiceAccount;
    readonly maker: ServiceAccount | OpenedServiceAccount;
    readonly changes: ReadonlyArray<AccessChange>;
  }) =>
    Effect.gen(function* () {
      const gains = (change: AccessChange) => {
        const held = serviceAccount.grants.find(
          grant => grant.environmentId === change.environmentId,
        );
        const removes = !change.canRead && !change.canWrite;
        return {
          environment: !removes && held === undefined,
          read: change.canRead && !held?.canRead,
        };
      };
      const needsKey = changes.some(change => gains(change).environment || gains(change).read);
      const reader = needsKey
        ? yield* keys(
            () => vouchedScopedReader(owner, { serviceAccount, maker }),
            'Nothing vouches for this service account’s key, so it cannot be given a read or an environment. Nothing was changed.',
          )
        : null;
      // Put again each time, not only in an org it seems new to: what it holds there may be in the
      // bin, and the store lists only what is not.
      const gainedOrgs = new Set(
        changes.filter(change => gains(change).environment).map(({ orgId }) => orgId),
      );
      // Every wrap and proof is made before the first request, so a vault failure changes nothing.
      const namesKeyWraps =
        reader === null || gainedOrgs.size === 0
          ? []
          : yield* Effect.gen(function* () {
              const { wraps } = yield* currentNamesKeys(owner);
              return yield* keys(() =>
                rewrapAll(
                  owner,
                  wraps.filter(({ orgId }) => gainedOrgs.has(orgId)),
                  reader,
                ),
              );
            });
      const prepared = yield* Effect.forEach(changes, change =>
        Effect.gen(function* () {
          const gained = gains(change);
          if (reader === null || !(gained.environment || gained.read)) {
            return { change, sealed: null };
          }
          const { owned } = yield* ownedEnvironment(owner, change.environmentId);
          const sealed = yield* keys(() =>
            grantToTrustedReader(owner, owned, reader, { canRead: gained.read }),
          );
          return { change, sealed };
        }),
      );
      for (const { orgId, wrap } of namesKeyWraps) {
        yield* ApiClient.use(client =>
          client.orgs.putNamesKeyWrap({
            params: { id: orgId, readerId: serviceAccount.id },
            payload: { wrap },
          }),
        );
      }
      for (const { change, sealed } of prepared) {
        const { environmentId, canRead, canWrite } = change;
        const params = { id: serviceAccount.id, environmentId };
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
              ...(sealed !== null && gains(change).environment
                ? { keyProof: sealed.keyProof }
                : {}),
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
    ApiClient.use(client => client.environments.removeGrant({ params })).pipe(faultsAsDefects),
  { reactivityKeys: ['grants', 'serviceAccounts', 'audit'] },
);

// --- requests ----------------------------------------------------------------------------------

export type OpenedRequestItem = RequestItem & { readonly openedEnvironmentName: string | null };
export type OpenedRequest = Omit<Request, 'items'> & {
  readonly items: ReadonlyArray<OpenedRequestItem>;
};

const openRequest = async (request: Request, namesKeys: NamesKeys): Promise<OpenedRequest> => ({
  ...request,
  items: await Promise.all(
    request.items.map(async item => ({
      ...item,
      openedEnvironmentName: await openStored(namesKeys, {
        orgId: item.orgId,
        scopeId: item.orgId,
        name: item.environmentName,
        sealedName: item.environmentSealedName,
      }),
    })),
  ),
});

/** Requests waiting for the owner, newest first. */
export const requestsAtom = Atom.family((owner: Owner) =>
  opening(
    owner,
    get => get.result(pendingRequestsAtom),
    (requests, namesKeys) =>
      Promise.all(
        requests
          .toSorted((a, b) => b.createdAt - a.createdAt)
          .map(request => openRequest(request, namesKeys)),
      ),
  ),
);

const requestQuery = Atom.family((id: string) =>
  ApiClient.query('requests', 'get', { params: { id }, reactivityKeys: ['requests'] }),
);

export const requestAtom = Atom.family((owner: Owner) =>
  Atom.family((id: string) => opening(owner, get => get.result(requestQuery(id)), openRequest)),
);

/** A name the page showed was opened from what the store sent then; refused unless it still opens to it. */
const SHOWN_NAME_CHANGED = (what: string) =>
  new OwnerError({
    message: `${what} names something other than what this page shows. Nothing was changed; reload the page.`,
  });

/**
 * Opens a stored name again with the names key as it is now, and refuses unless it opens to what
 * the page showed. A name the page could not open is refused too: nothing is answered for it.
 */
const reopenShown = Effect.fnUntraced(function* (
  namesKeys: NamesKeys,
  { shown, what, ...stored }: Stored & { readonly shown: string | null; readonly what: string },
) {
  if (shown === null) return yield* SHOWN_NAME_CHANGED(what);
  const namesKey = yield* namesKeyFor(namesKeys, stored.orgId);
  const name = yield* keys(
    () =>
      openName(namesKey, {
        scopeId: stored.scopeId,
        stored: { name: stored.name, sealedName: stored.sealedName ?? null },
      }),
    `${what} names something that does not open with your vault. Nothing was changed.`,
  );
  if (name !== shown) return yield* SHOWN_NAME_CHANGED(what);
  return name;
});

/**
 * Approves a request: its key is learned from what its CLI login vouched for (never the store's
 * word), each environment it names is handed to it as asked, and it gets the names key of each
 * org it reaches. Only the environments the page showed: each name is opened again first. One
 * write, so the store has it approved with all of them or not at all. One per request, so an
 * answer in flight or failed on one request's page is not another's.
 */
export const approveRequestAtom = Atom.family((_id: string) =>
  ApiClient.runtime.fn(
    ({
      owner,
      request,
      expiresAt,
    }: {
      readonly owner: Owner;
      readonly request: OpenedRequest;
      /** The owner's choice; null for no end. */
      readonly expiresAt: number | null;
    }) =>
      Effect.gen(function* () {
        const orgIds = new Set(request.items.map(({ orgId }) => orgId));
        const { wraps, namesKeys } = yield* currentNamesKeys(owner);
        for (const orgId of orgIds) {
          if ((yield* namesKeyFor(namesKeys, orgId)) === null) {
            return yield* NOT_SEALED_YET('this request');
          }
        }
        for (const item of request.items) {
          yield* reopenShown(namesKeys, {
            orgId: item.orgId,
            scopeId: item.orgId,
            name: item.environmentName,
            sealedName: item.environmentSealedName,
            shown: item.openedEnvironmentName,
            what: 'This request',
          });
        }
        const reader = yield* keys(
          () =>
            vouchedScopedReader(owner, {
              serviceAccount: request,
              maker: request.maker,
            }),
          'Nothing your vault approved vouches for this request’s key, so it cannot be approved. Nothing was changed.',
        );
        const grants = yield* Effect.forEach(request.items, item =>
          Effect.gen(function* () {
            const { owned, keyVersion } = yield* ownedEnvironment(owner, item.environmentId);
            const { keyProof, readWrap } = yield* keys(() =>
              grantToTrustedReader(owner, owned, reader, { canRead: item.canRead }),
            );
            return { environmentId: item.environmentId, readWrap, keyProof, keyVersion };
          }),
        );
        const namesKeyWraps = yield* keys(() =>
          rewrapAll(
            owner,
            wraps.filter(({ orgId }) => orgIds.has(orgId)),
            reader,
          ),
        );
        return yield* ApiClient.use(client =>
          client.requests.approve({
            params: { id: request.id },
            payload: { expiresAt, grants, namesKeyWraps },
          }),
        );
      }).pipe(faultsAsDefects),
    { reactivityKeys: ['requests', 'serviceAccounts', 'grants', 'audit'] },
  ),
);

/** One per request, as approving is. */
export const rejectRequestAtom = Atom.family((_id: string) =>
  ApiClient.runtime.fn(
    (id: string) =>
      ApiClient.use(client => client.requests.reject({ params: { id } })).pipe(faultsAsDefects),
    { reactivityKeys: ['requests', 'serviceAccounts', 'audit'] },
  ),
);

// --- environment requests ----------------------------------------------------------------------

export type OpenedEnvironmentRequest = Opened<EnvironmentRequest>;

const openEnvironmentRequest = async (
  request: EnvironmentRequest,
  namesKeys: NamesKeys,
): Promise<OpenedEnvironmentRequest> => ({
  ...request,
  openedName: await openStored(namesKeys, { ...request, scopeId: request.orgId }),
});

/** Environment requests waiting for the owner, as the nav counts them. */
export const pendingEnvironmentRequestsAtom = ApiClient.query('environmentRequests', 'list', {
  reactivityKeys: ['environmentRequests'],
}).pipe(Atom.mapResult(({ requests }) => requests));

/** Environment requests waiting for the owner, newest first. */
export const environmentRequestsAtom = Atom.family((owner: Owner) =>
  opening(
    owner,
    get => get.result(pendingEnvironmentRequestsAtom),
    (requests, namesKeys) =>
      Promise.all(
        requests
          .toSorted((a, b) => b.createdAt - a.createdAt)
          .map(request => openEnvironmentRequest(request, namesKeys)),
      ),
  ),
);

const environmentRequestQuery = Atom.family((id: string) =>
  ApiClient.query('environmentRequests', 'get', {
    params: { id },
    reactivityKeys: ['environmentRequests'],
  }),
);

export const environmentRequestAtom = Atom.family((owner: Owner) =>
  Atom.family((id: string) =>
    opening(owner, get => get.result(environmentRequestQuery(id)), openEnvironmentRequest),
  ),
);

const isEnvironmentName = Schema.is(EnvironmentNameSchema);

/**
 * Approves an environment request by creating the environment it names, as creating one here
 * does, under the id and the sealed name it asked for. Only the name the page showed: it is opened
 * again with the names key as it is now, and nothing is made if it does not open to that name.
 */
export const approveEnvironmentRequestAtom = Atom.family((_id: string) =>
  ApiClient.runtime.fn(
    ({ owner, request }: { readonly owner: Owner; readonly request: OpenedEnvironmentRequest }) =>
      Effect.gen(function* () {
        const name = yield* reopenShown((yield* currentNamesKeys(owner)).namesKeys, {
          ...request,
          scopeId: request.orgId,
          shown: request.openedName,
          what: 'This request',
        });
        if (!isEnvironmentName(name)) {
          return yield* new OwnerError({
            message: 'An environment cannot have this name. Nothing was created.',
          });
        }
        return yield* makeEnvironment(owner, {
          id: request.id,
          orgId: request.orgId,
          name: request.name,
          sealedName: request.sealedName,
          answers: request.id,
        });
      }).pipe(faultsAsDefects),
    { reactivityKeys: ['environmentRequests', 'environments', 'orgs', 'audit'] },
  ),
);

/** One per environment request, as approving is. */
export const rejectEnvironmentRequestAtom = Atom.family((_id: string) =>
  ApiClient.runtime.fn(
    (id: string) =>
      ApiClient.use(client => client.environmentRequests.reject({ params: { id } })).pipe(
        faultsAsDefects,
      ),
    { reactivityKeys: ['environmentRequests', 'audit'] },
  ),
);

// --- paste links -------------------------------------------------------------------------------

export type OpenedPasteLink = Opened<PasteLink> & {
  readonly openedEnvironmentName: string | null;
};

const openPasteLink = async (link: PasteLink, namesKeys: NamesKeys): Promise<OpenedPasteLink> => ({
  ...link,
  openedName: await openStored(namesKeys, { ...link, scopeId: link.environmentId }),
  openedEnvironmentName: await openStored(namesKeys, {
    orgId: link.orgId,
    scopeId: link.orgId,
    name: link.environmentName,
    sealedName: link.environmentSealedName,
  }),
});

/** Paste links waiting for the owner, as the nav counts them. */
export const pendingPasteLinksAtom = ApiClient.query('pasteLinks', 'list', {
  reactivityKeys: ['pasteLinks'],
}).pipe(Atom.mapResult(({ links }) => links));

export const pasteLinksAtom = Atom.family((owner: Owner) =>
  opening(
    owner,
    get => get.result(pendingPasteLinksAtom),
    (links, namesKeys) => Promise.all(links.map(link => openPasteLink(link, namesKeys))),
  ),
);

export const cancelPasteLinkAtom = Atom.family((id: string) =>
  ApiClient.runtime.fn(
    () =>
      ApiClient.use(client => client.pasteLinks.cancel({ params: { id } })).pipe(faultsAsDefects),
    { reactivityKeys: ['pasteLinks', 'audit'] },
  ),
);

// --- the paste page ----------------------------------------------------------------------------

const pasteTargetQuery = Atom.family((id: string) =>
  ApiClient.query('paste', 'target', { params: { id }, reactivityKeys: ['paste'] }),
);

export const pasteTargetAtom = Atom.family((owner: Owner) =>
  Atom.family((id: string) =>
    opening(
      owner,
      get => get.result(pasteTargetQuery(id)),
      async (target, namesKeys) => ({
        ...target,
        link: await openPasteLink(target.link, namesKeys),
      }),
    ),
  ),
);

/** What the paste page showed the owner: the environment and the name, each as stored and as opened. */
export type ShownPasteTarget = {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly environmentSealedName: string | null;
  readonly openedEnvironmentName: string | null;
  readonly name: string;
  readonly sealedName: string | null;
  readonly openedName: string | null;
};

/**
 * Seals the pasted value to the key the owner's vault proves for the link's environment, never to
 * the one the store sent beside the link, under the name the names key opens. Only for the target
 * the page showed: the link is read again to seal, and refused if it now names another.
 */
export const fulfilPasteAtom = ApiClient.runtime.fn(
  ({
    id,
    owner,
    shown,
    value,
  }: {
    readonly id: string;
    readonly owner: Owner;
    readonly shown: ShownPasteTarget;
    readonly value: string;
  }) =>
    Effect.gen(function* () {
      const target = yield* ApiClient.use(client => client.paste.target({ params: { id } }));
      const { link } = target;
      const changed = new OwnerError({
        message:
          'This link names something other than what this page shows. Nothing was sent; reload the page to see what it asks for now.',
      });
      if (
        shown.openedName === null ||
        shown.openedEnvironmentName === null ||
        link.environmentId !== shown.environmentId ||
        link.environmentName !== shown.environmentName ||
        link.environmentSealedName !== shown.environmentSealedName ||
        link.name !== shown.name ||
        link.sealedName !== shown.sealedName
      ) {
        return yield* changed;
      }
      const proven = yield* ownedEnvironment(owner, link.environmentId);
      if (
        proven.keyVersion !== target.keyVersion ||
        proven.publicKey !== target.environmentPublicKey
      ) {
        return yield* new OwnerError({
          message:
            'The store shows a different environment key than the one your vault holds. Nothing was sent.',
        });
      }
      const { namesKeys } = yield* currentNamesKeys(owner);
      yield* reopenShown(namesKeys, {
        orgId: link.orgId,
        scopeId: link.orgId,
        name: link.environmentName,
        sealedName: link.environmentSealedName,
        shown: shown.openedEnvironmentName,
        what: 'This link',
      });
      const name = yield* reopenShown(namesKeys, {
        orgId: link.orgId,
        scopeId: link.environmentId,
        name: link.name,
        sealedName: link.sealedName,
        shown: shown.openedName,
        what: 'This link',
      });
      const ciphertext = yield* keys(() =>
        sealValue({
          environmentPublicKey: proven.publicKey,
          slot: {
            environmentId: link.environmentId,
            keyVersion: target.keyVersion,
            name,
            version: target.nextVersion,
          },
          value,
        }),
      );
      return yield* ApiClient.use(client =>
        client.paste.fulfil({
          params: { id },
          payload: { version: target.nextVersion, keyVersion: target.keyVersion, ciphertext },
        }),
      );
    }).pipe(faultsAsDefects),
  { reactivityKeys: ['paste', 'pasteLinks', 'secrets', 'audit'] },
);

// --- activity ----------------------------------------------------------------------------------

export type OpenedActivityEvent = ActivityEvent & {
  readonly openedEnvironmentName: string | null;
  readonly openedSecretName: string | null;
};

const activityQuery = Atom.family((orgId: string) =>
  ApiClient.query('activity', 'list', { query: { limit: 100, orgId }, reactivityKeys: ['audit'] }),
);

/** One org's activity, beside the account's own. */
export const activityAtom = Atom.family((owner: Owner) =>
  Atom.family((orgId: string) =>
    opening(
      owner,
      get => get.result(activityQuery(orgId)),
      ({ events }, namesKeys): Promise<ReadonlyArray<OpenedActivityEvent>> =>
        Promise.all(
          events.map(async event => ({
            ...event,
            openedEnvironmentName:
              event.environmentName === null || event.orgId === null
                ? null
                : await openStored(namesKeys, {
                    orgId: event.orgId,
                    scopeId: event.orgId,
                    name: event.environmentName,
                    sealedName: event.environmentSealedName,
                  }),
            openedSecretName:
              event.secretName === null || event.orgId === null || event.environmentId === null
                ? null
                : await openStored(namesKeys, {
                    orgId: event.orgId,
                    scopeId: event.environmentId,
                    name: event.secretName,
                    sealedName: event.secretSealedName,
                  }),
          })),
        ),
    ),
  ),
);
