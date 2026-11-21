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
  type Org,
  type OrgNamesKeyWrap,
  type PairingRequest,
  type Plan,
  type PlanStep,
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
  openHint,
  openName,
  openNamesKey,
  openOwnedEnvironment,
  openProposedValue,
  openValue,
  randomToken,
  rewrapNamesKey,
  sealName,
  sealNote,
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
const namesKeysAtom = Atom.family((owner: Owner) =>
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

/** A CLI login: made by `baymutt auth login` and approved here, so it has no parent. It holds no environment. */
export const isLogin = (serviceAccount: Pick<ServiceAccount, 'parentId'>): boolean =>
  serviceAccount.parentId === null;

export type KeyKind = 'login' | 'service-account' | 'agent';

/**
 * What a key is for, by how it was asked: a CLI login, a service account (made for another
 * system: the ask gave a command to pipe the key into) or an agent key (an agent's own, kept in a
 * file). The Worker writes `intent` for every key a plan or a request made; one without it, which
 * the store does not return, is told by its end.
 */
export const kindOf = (
  serviceAccount: Pick<ServiceAccount, 'parentId' | 'intent' | 'expiresAt'>,
): KeyKind => {
  if (isLogin(serviceAccount)) return 'login';
  return serviceAccount.intent ?? (serviceAccount.expiresAt === null ? 'service-account' : 'agent');
};

/** A key whose end has passed. It stays listed until the nightly sweep revokes it, and a later end revives it. */
export const hasEnded = (serviceAccount: Pick<ServiceAccount, 'expiresAt'>, now: number): boolean =>
  serviceAccount.expiresAt !== null && serviceAccount.expiresAt <= now;

/** Who gets an org's names key when it is sealed, and who could not be given it. */
type NamesReaders = {
  readonly readers: ReadonlyArray<{ readonly id: string; readonly publicKey: string }>;
  /** A CLI login or service account whose key the vault cannot verify: it is left out. */
  readonly leftOut: ReadonlyArray<string>;
};

/**
 * Everyone who may list an org's names, each by a key the vault trusts: the owner's account,
 * every CLI login the vault approved, and every key of the org, by the key its CLI login vouched
 * for. Every key of the org, not only those the store lists holding something there: one whose
 * environment is in the bin lists it again once it is restored. One whose key cannot be verified
 * is left out, never trusted on the store's word, and named.
 */
const namesReaders = Effect.fnUntraced(function* (owner: Owner, orgId: string) {
  // A plan's key still waiting for its step is not listed: it gets the names key when approved.
  const { credentials } = yield* ApiClient.use(client => client.credentials.list());
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
    credentials.filter(
      serviceAccount => isLogin(serviceAccount) || serviceAccount.org?.id === orgId,
    ),
    serviceAccount =>
      readerOf(serviceAccount).pipe(
        Effect.orElseSucceed(() => null),
        Effect.map(reader => ({ reader, name: serviceAccount.name })),
      ),
  );
  return {
    readers: [
      { id: owner.accountId, publicKey: accountPublicKey(owner) },
      ...verified.flatMap(({ reader }) => (reader === null ? [] : [reader])),
    ],
    leftOut: verified.flatMap(({ reader, name }) => (reader === null ? [name] : [])),
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
    reactivityKeys: ['orgs', 'environments', 'secrets', 'bin', 'serviceAccounts', 'audit'],
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
    // Deleting an org also removes its keys and the plans waiting in it.
    {
      reactivityKeys: ['orgs', 'serviceAccounts', 'audit'],
    },
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

const NOT_SEALED_YET = (what: string) =>
  new OwnerError({
    message: `This org’s names are being sealed, so ${what} cannot be made yet. Try again in a moment.`,
  });

/** A new environment's key pair, made here, and the owner's member copy of it: held by the owner alone. */
const environmentKeyPair = Effect.fnUntraced(function* (owner: Owner, environmentId: string) {
  const key = yield* keys(() =>
    createEnvironmentKey({
      voucherKey: owner.accountKey,
      binding: { environmentId, keyVersion: 1 },
      readers: [{ id: owner.accountId, publicKey: accountPublicKey(owner) }],
    }),
  );
  const [own] = key.grants;
  if (own === undefined) return yield* Effect.die('an environment key came with no grant');
  return { publicKey: key.publicKey, memberWrap: own.wrap, memberProof: own.proof };
});

/** Makes an environment under a name already sealed: its key pair made here, held by the owner alone. */
const makeEnvironment = Effect.fnUntraced(function* (
  owner: Owner,
  environment: {
    readonly id: string;
    readonly orgId: string;
    readonly name: string;
    readonly sealedName: string;
  },
) {
  const keyPair = yield* environmentKeyPair(owner, environment.id);
  return yield* ApiClient.use(client =>
    client.environments.create({ payload: { ...environment, ...keyPair } }),
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
    reactivityKeys: ['environments', 'serviceAccounts', 'grants', 'bin', 'orgs', 'audit'],
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
    {
      reactivityKeys: ['environments', 'serviceAccounts', 'grants', 'bin', 'orgs', 'audit'],
    },
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

const credentialListAtom = ApiClient.query('credentials', 'list', {
  reactivityKeys: ['serviceAccounts', 'grants'],
});

/** Every CLI login and key. A plan's key is not listed until its step is approved. */
export const serviceAccountsAtom = Atom.family((owner: Owner) =>
  opening(
    owner,
    get => get.result(credentialListAtom),
    ({ credentials }, namesKeys): Promise<ReadonlyArray<OpenedServiceAccount>> =>
      Promise.all(
        credentials.map(async serviceAccount => ({
          ...serviceAccount,
          grants: (
            await Promise.all(serviceAccount.grants.map(grant => openGrant(grant, namesKeys)))
          ).toSorted(byName(({ openedEnvironmentName }) => openedEnvironmentName)),
        })),
      ),
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
  {
    reactivityKeys: ['serviceAccounts', 'grants', 'audit'],
  },
);

/** Whether a key is to read one environment: `canRead` false takes it away. */
export type AccessChange = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly canRead: boolean;
};

/** Whether the login that asked for it vouched for its key, so a read can be wrapped to it. */
export const isVouched = (serviceAccount: Pick<ServiceAccount, 'keyVoucher'>): boolean =>
  serviceAccount.keyVoucher !== null;

/**
 * Changes what a key reads, keeping its key. A read it gains is wrapped and vouched for to the key
 * its maker vouched for to the account, which the vault trusts through its endorsement of that
 * login: never to the key the store lists. It comes with its org's names key, so the key can list
 * the names there. A key only reads: there is no write to give.
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
      const holds = (environmentId: string) =>
        serviceAccount.grants.some(grant => grant.environmentId === environmentId);
      const gained = changes.filter(change => change.canRead && !holds(change.environmentId));
      const removed = changes.filter(change => !change.canRead && holds(change.environmentId));
      const reader =
        gained.length === 0
          ? null
          : yield* keys(
              () => vouchedScopedReader(owner, { serviceAccount, maker }),
              'Nothing vouches for this key, so it cannot be given a read. Nothing was changed.',
            );
      // Every wrap and proof is made before the first request, so a vault failure changes nothing.
      // The names key is put again each time, not only in an org it seems new to: what it reads
      // there may be in the bin, and the store lists only what is not.
      const gainedOrgs = new Set(gained.map(({ orgId }) => orgId));
      const namesKeyWraps =
        reader === null
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
      const sealed =
        reader === null
          ? []
          : yield* Effect.forEach(gained, change =>
              Effect.gen(function* () {
                const { owned } = yield* ownedEnvironment(owner, change.environmentId);
                const { readWrap, keyProof } = yield* keys(() =>
                  grantToTrustedReader(owner, owned, reader, { canRead: true }),
                );
                if (readWrap === null) {
                  return yield* Effect.die('a read was wrapped to no one');
                }
                return { environmentId: change.environmentId, readWrap, keyProof };
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
      for (const { environmentId, readWrap, keyProof } of sealed) {
        yield* ApiClient.use(client =>
          client.credentials.setAccess({
            params: { id: serviceAccount.id, environmentId },
            payload: { readWrap, keyProof },
          }),
        );
      }
      for (const { environmentId } of removed) {
        yield* ApiClient.use(client =>
          client.credentials.removeAccess({ params: { id: serviceAccount.id, environmentId } }),
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

// --- names a page showed -----------------------------------------------------------------------

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

const isEnvironmentName = Schema.is(EnvironmentNameSchema);

// --- plans -------------------------------------------------------------------------------------

type StepOf<T extends PlanStep['type']> = Extract<PlanStep, { readonly type: T }>;
type WithEnvironmentName<A> = A & { readonly openedEnvironmentName: string | null };

export type OpenedSecretItem = WithEnvironmentName<StepOf<'secrets'>['items'][number]> & {
  readonly openedName: string | null;
  /**
   * A `set` item's value while its step waits, as the vault opened it: null when it did not open
   * as one the login that asked sealed for this slot. Null for every other item.
   */
  readonly proposed: string | null;
  /**
   * A `paste` item's hint while its step waits, as the vault opened it: null when there is none, or
   * when it did not open as one the login that asked sealed for this slot (`sealedHint` is not null
   * then). Null for every other item.
   */
  readonly openedHint: string | null;
};

export type OpenedPlanStep =
  | (Omit<StepOf<'environments'>, 'items'> & {
      readonly items: ReadonlyArray<WithEnvironmentName<StepOf<'environments'>['items'][number]>>;
    })
  | (Omit<StepOf<'access'>, 'read'> & {
      readonly read: ReadonlyArray<WithEnvironmentName<StepOf<'access'>['read'][number]>>;
    })
  | (Omit<StepOf<'change'>, 'holds' | 'read' | 'giveBack'> & {
      readonly holds: ReadonlyArray<OpenedGrant>;
      readonly read: ReadonlyArray<WithEnvironmentName<StepOf<'change'>['read'][number]>>;
      readonly giveBack: ReadonlyArray<WithEnvironmentName<StepOf<'change'>['giveBack'][number]>>;
    })
  | (Omit<StepOf<'secrets'>, 'items'> & { readonly items: ReadonlyArray<OpenedSecretItem> });

export type OpenedPlan = Omit<Plan, 'steps'> & { readonly steps: ReadonlyArray<OpenedPlanStep> };

type PlanEnvironment = {
  readonly environmentName: string | null;
  readonly environmentSealedName: string | null;
};

/**
 * Every name a plan shows, opened here, and every value it proposes, opened with the key the
 * vault endorsed for the login that asked: never one the store lists beside the plan.
 */
const openPlan = async (owner: Owner, plan: Plan, namesKeys: NamesKeys): Promise<OpenedPlan> => {
  const orgId = plan.org.id;
  const maker = await endorsedReader(owner, plan.maker).catch(() => null);
  const named = async <A extends PlanEnvironment>(item: A): Promise<WithEnvironmentName<A>> => ({
    ...item,
    openedEnvironmentName:
      item.environmentName === null
        ? null
        : await openStored(namesKeys, {
            orgId,
            scopeId: orgId,
            name: item.environmentName,
            sealedName: item.environmentSealedName,
          }),
  });
  const openSecretItem = async (
    step: StepOf<'secrets'>,
    item: StepOf<'secrets'>['items'][number],
  ): Promise<OpenedSecretItem> => {
    const openedName = await openStored(namesKeys, {
      orgId,
      scopeId: item.environmentId,
      name: item.name,
      sealedName: item.sealedName,
    });
    const opening =
      maker === null || openedName === null
        ? null
        : {
            accountKey: owner.accountKey,
            loginPublicKey: maker.publicKey,
            slot: {
              planId: plan.id,
              stepIndex: step.index,
              environmentId: item.environmentId,
              name: openedName,
            },
          };
    const proposed =
      item.op !== 'set' || item.value === null || opening === null
        ? null
        : await openProposedValue({ ...opening, ciphertext: item.value }).catch(() => null);
    const openedHint =
      item.op !== 'paste' || item.sealedHint === null || opening === null
        ? null
        : await openHint({ ...opening, ciphertext: item.sealedHint }).catch(() => null);
    return { ...(await named(item)), openedName, proposed, openedHint };
  };
  const steps = await Promise.all(
    plan.steps.map(async (step): Promise<OpenedPlanStep> => {
      if (step.type === 'environments') {
        return { ...step, items: await Promise.all(step.items.map(named)) };
      }
      if (step.type === 'access') return { ...step, read: await Promise.all(step.read.map(named)) };
      if (step.type === 'change') {
        return {
          ...step,
          holds: await Promise.all(step.holds.map(grant => openGrant(grant, namesKeys))),
          read: await Promise.all(step.read.map(named)),
          giveBack: await Promise.all(step.giveBack.map(named)),
        };
      }
      return {
        ...step,
        items: await Promise.all(step.items.map(item => openSecretItem(step, item))),
      };
    }),
  );
  return { ...plan, steps };
};

/** Plans with a step that waits for the owner, newest first: what Plans lists and counts. */
export const pendingPlansAtom = ApiClient.query('plans', 'list', {
  query: {},
  reactivityKeys: ['plans'],
}).pipe(Atom.mapResult(({ plans }) => plans.toSorted((a, b) => b.createdAt - a.createdAt)));

const planQuery = Atom.family((id: string) =>
  ApiClient.query('plans', 'get', { params: { id }, reactivityKeys: ['plans'] }),
);

export const planAtom = Atom.family((owner: Owner) =>
  Atom.family((id: string) =>
    opening(
      owner,
      get => get.result(planQuery(id)),
      (plan, namesKeys) => openPlan(owner, plan, namesKeys),
    ),
  ),
);

/** The answer's note, sealed to the login that asked and bound to this step and this decision. */
const sealedNote = Effect.fnUntraced(function* (
  owner: Owner,
  plan: OpenedPlan,
  {
    index,
    decision,
    note,
  }: { readonly index: number; readonly decision: 'approved' | 'rejected'; readonly note: string },
) {
  if (note === '') return {};
  const maker = yield* keys(
    () => endorsedReader(owner, plan.maker),
    'Could not verify the CLI login to seal your note. Nothing was sent.',
  );
  return {
    note: yield* keys(() =>
      sealNote({
        accountKey: owner.accountKey,
        loginPublicKey: maker.publicKey,
        step: { planId: plan.id, stepIndex: index, decision },
        note,
      }),
    ),
  };
});

const NOTHING_SENT = (message: string) => new OwnerError({ message });

/** Each environment the page showed for a step, opened again: refused unless it opens to the same name. */
const reopenEnvironments = Effect.fnUntraced(function* (
  namesKeys: NamesKeys,
  orgId: string,
  items: ReadonlyArray<WithEnvironmentName<PlanEnvironment>>,
) {
  for (const item of items) {
    yield* reopenShown(namesKeys, {
      orgId,
      scopeId: orgId,
      name: item.environmentName ?? '',
      sealedName: item.environmentSealedName,
      shown: item.openedEnvironmentName,
      what: 'This step',
    });
  }
});

/**
 * Read for a key its maker vouched for, learned from that voucher and never from the store's
 * word: each environment's key wrapped to it with the owner's proof, and the plan's org's names
 * key. Nothing for a step that reads nothing.
 */
const readAnswer = Effect.fnUntraced(function* (
  owner: Owner,
  plan: OpenedPlan,
  {
    key,
    read,
    others,
  }: {
    readonly key: {
      readonly id: string;
      readonly publicKey: string;
      readonly keyVoucher: string | null;
    };
    readonly read: ReadonlyArray<WithEnvironmentName<StepOf<'access'>['read'][number]>>;
    /** What else the step names, opened again as the read is. */
    readonly others: ReadonlyArray<WithEnvironmentName<PlanEnvironment>>;
  },
) {
  const { wraps, namesKeys } = yield* currentNamesKeys(owner);
  if (read.length > 0 && (yield* namesKeyFor(namesKeys, plan.org.id)) === null) {
    return yield* NOT_SEALED_YET('this step');
  }
  yield* reopenEnvironments(namesKeys, plan.org.id, [...read, ...others]);
  if (read.length === 0) return { grants: [], namesKeyWraps: [] };
  const reader = yield* keys(
    () => vouchedScopedReader(owner, { serviceAccount: key, maker: plan.maker }),
    'Could not verify the key. Nothing was sent.',
  );
  const grants = yield* Effect.forEach(read, ({ environmentId }) =>
    Effect.gen(function* () {
      const { owned, keyVersion } = yield* ownedEnvironment(owner, environmentId);
      const { keyProof, readWrap } = yield* keys(() =>
        grantToTrustedReader(owner, owned, reader, { canRead: true }),
      );
      if (readWrap === null) return yield* Effect.die('a read came with no wrap');
      return { environmentId, readWrap, keyProof, keyVersion };
    }),
  );
  const namesKeyWraps = yield* keys(() =>
    rewrapAll(
      owner,
      wraps.filter(({ orgId }) => orgId === plan.org.id),
      reader,
    ),
  );
  return { grants, namesKeyWraps };
});

/**
 * Each value a secrets step writes, sealed here to the key the vault proves for its environment,
 * for the slot the page read: the proposed value as the vault opened it, the one the owner
 * pasted (by the item's place in the step), or a new random one nobody sees.
 */
const secretValues = Effect.fnUntraced(function* (
  owner: Owner,
  plan: OpenedPlan,
  step: Extract<OpenedPlanStep, { readonly type: 'secrets' }>,
  pasted: ReadonlyMap<number, string>,
) {
  const { namesKeys } = yield* currentNamesKeys(owner);
  const values = yield* Effect.forEach(step.items, (item, position) =>
    Effect.gen(function* () {
      if (item.op !== 'set' && item.op !== 'paste' && item.op !== 'generate') return [];
      const { nextVersion, keyVersion, environmentId } = item;
      if (nextVersion === null || keyVersion === null) {
        return yield* NOTHING_SENT(
          'The environment does not exist yet. Approve the step that creates it first. Nothing was sent.',
        );
      }
      yield* reopenEnvironments(namesKeys, plan.org.id, [item]);
      const name = yield* reopenShown(namesKeys, {
        orgId: plan.org.id,
        scopeId: environmentId,
        name: item.name,
        sealedName: item.sealedName,
        shown: item.openedName,
        what: 'This step',
      });
      const value = yield* (() => {
        if (item.op === 'generate') return Effect.succeed(randomToken());
        if (item.op === 'paste') {
          const typed = pasted.get(position) ?? '';
          return typed === ''
            ? Effect.fail(new OwnerError({ message: `Paste a value for ${name}.` }))
            : Effect.succeed(typed);
        }
        return item.proposed === null
          ? Effect.fail(
              NOTHING_SENT(`Could not verify the proposed value for ${name}. Nothing was sent.`),
            )
          : Effect.succeed(item.proposed);
      })();
      const proven = yield* ownedEnvironment(owner, environmentId);
      if (proven.keyVersion !== keyVersion) {
        return yield* NOTHING_SENT(
          'The environment key changed. Nothing was sent. Refresh the plan and try again.',
        );
      }
      const ciphertext = yield* keys(() =>
        sealValue({
          environmentPublicKey: proven.publicKey,
          slot: { environmentId, keyVersion, name, version: nextVersion },
          value,
        }),
      );
      return [{ item: position, version: nextVersion, keyVersion, ciphertext }];
    }),
  );
  return values.flat();
});

/**
 * Approves `step` with what this browser makes for it from what the page showed and what the owner
 * chose, and `sealed`, the note if any. Each type is sent on its own: the client takes one payload
 * shape per call.
 */
const sendApproval = Effect.fnUntraced(function* (
  owner: Owner,
  plan: OpenedPlan,
  step: OpenedPlanStep,
  {
    pasted,
    expiresAt,
    sealed,
  }: {
    readonly pasted: ReadonlyMap<number, string>;
    /** The owner's end for a key: null for none; undefined keeps a changed key's own. */
    readonly expiresAt: number | null | undefined;
    readonly sealed: { readonly note?: string };
  },
) {
  const params = { id: plan.id, index: step.index };
  if (step.type === 'environments') {
    const { namesKeys } = yield* currentNamesKeys(owner);
    yield* reopenEnvironments(namesKeys, plan.org.id, step.items);
    const creates = step.items.filter(({ op }) => op === 'create');
    if (creates.some(({ openedEnvironmentName }) => !isEnvironmentName(openedEnvironmentName))) {
      return yield* NOTHING_SENT('An environment name is invalid. Nothing was sent.');
    }
    const made = yield* Effect.forEach(creates, ({ environmentId }) =>
      Effect.map(environmentKeyPair(owner, environmentId), keyPair => ({
        environmentId,
        ...keyPair,
      })),
    );
    return yield* ApiClient.use(client =>
      client.plans.approveStep({ params, payload: { type: step.type, creates: made, ...sealed } }),
    );
  }
  if (step.type === 'access') {
    const read = yield* readAnswer(owner, plan, { key: step.key, read: step.read, others: [] });
    return yield* ApiClient.use(client =>
      client.plans.approveStep({
        params,
        payload: { type: step.type, expiresAt: expiresAt ?? null, ...read, ...sealed },
      }),
    );
  }
  if (step.type === 'change') {
    const read = yield* readAnswer(owner, plan, {
      key: step.key,
      read: step.read,
      others: step.giveBack,
    });
    return yield* ApiClient.use(client =>
      client.plans.approveStep({
        params,
        payload: {
          type: step.type,
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...read,
          ...sealed,
        },
      }),
    );
  }
  const values = yield* secretValues(owner, plan, step, pasted);
  return yield* ApiClient.use(client =>
    client.plans.approveStep({ params, payload: { type: step.type, values, ...sealed } }),
  );
});

const PLAN_KEYS = [
  'plans',
  'environments',
  'serviceAccounts',
  'grants',
  'secrets',
  'bin',
  'orgs',
  'audit',
] as const;

/**
 * Approves one step, making in this browser what it names. One write, so the store has all of it
 * or none. One per step (`<plan id>/<index>`), so an answer in flight or failed on one step is not
 * another's.
 */
export const approveStepAtom = Atom.family((_step: string) =>
  ApiClient.runtime.fn(
    ({
      owner,
      plan,
      index,
      note,
      pasted,
      expiresAt,
    }: {
      readonly owner: Owner;
      readonly plan: OpenedPlan;
      readonly index: number;
      readonly note: string;
      readonly pasted: ReadonlyMap<number, string>;
      readonly expiresAt: number | null | undefined;
    }) =>
      Effect.gen(function* () {
        const step = plan.steps[index];
        if (step === undefined) return yield* Effect.die(`plan ${plan.id} has no step ${index}`);
        const sealed = yield* sealedNote(owner, plan, { index, decision: 'approved', note });
        return yield* sendApproval(owner, plan, step, { pasted, expiresAt, sealed });
      }).pipe(
        faultsAsDefects,
        // Refusals the page answers by reading the plan again: the step then shows why, and what
        // the owner typed stays. The store's words count steps from 0, the page's from 1.
        Effect.catchTags({
          StepNotApprovableError: () =>
            Effect.fail(
              new OwnerError({
                message: 'This step can no longer be approved. The plan has been refreshed.',
              }),
            ),
          VersionConflictError: () =>
            Effect.fail(
              new OwnerError({
                message:
                  'Something changed since this plan was made. The plan has been refreshed; review the step and try again.',
              }),
            ),
        }),
        Effect.onError(() => Reactivity.invalidate(['plans'])),
      ),
    { reactivityKeys: PLAN_KEYS },
  ),
);

/** Rejects one step, with the owner's note when there is one. One per step, as approving is. */
export const rejectStepAtom = Atom.family((_step: string) =>
  ApiClient.runtime.fn(
    ({
      owner,
      plan,
      index,
      note,
    }: {
      readonly owner: Owner;
      readonly plan: OpenedPlan;
      readonly index: number;
      readonly note: string;
    }) =>
      Effect.gen(function* () {
        const sealed = yield* sealedNote(owner, plan, { index, decision: 'rejected', note });
        return yield* ApiClient.use(client =>
          client.plans.rejectStep({ params: { id: plan.id, index }, payload: sealed }),
        );
      }).pipe(
        faultsAsDefects,
        Effect.onError(() => Reactivity.invalidate(['plans'])),
      ),
    { reactivityKeys: PLAN_KEYS },
  ),
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
