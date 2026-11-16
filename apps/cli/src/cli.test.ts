// The CLI against the real Worker app, in process: its own key handling and the real key
// schedule on both sides, with the owner's browser played by `@baymutt/keys` and the API.
import { type PairingRequest, PairingRequestSchema } from '@baymutt/api';
import {
  approvePairing,
  createAccountKey,
  createEnvironmentKey,
  createNamesKey,
  createVault,
  derivePasskeyEncKey,
  endorsedReader,
  generateEnvironmentKey,
  generateRecoveryKey,
  grantToTrustedReader,
  type NamesKey,
  nameIndex,
  type OwnedEnvironment,
  type OwnerKeys,
  openAccountKey,
  openName,
  openOwnedEnvironment,
  recoveryVaultKey,
  rewrapDek,
  rewrapNamesKey,
  sealName,
  sealValue,
  tokenHash,
  vaultProof,
  vouchedScopedReader,
  wrapEnvironmentKey,
} from '@baymutt/keys';
import { ORIGIN, send, type TestWorld, testWorld } from '@baymutt/worker-web/testing';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, layer } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as Stdio from 'effect/Stdio';
import * as Stream from 'effect/Stream';
import * as TestClock from 'effect/testing/TestClock';
import * as TestConsole from 'effect/testing/TestConsole';
import { durationMs } from './about.ts';
import { CliLayer, cli } from './app.ts';
import { loadValues } from './environments.ts';
import { Reported } from './errors.ts';
import { KeyStore, Platform } from './key-store.ts';
import { ServiceAccount } from './service-account.ts';
import { Settings } from './settings.ts';

/** Where the CLI runs: its own config home, so its own key and state, and what its environment sets. */
type Seat = { readonly configHome: string; readonly env?: Record<string, string> };

const withSeat = <A, E, R>(world: TestWorld, seat: Seat, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, world.fetch as typeof fetch)),
      ),
    ),
    // The file store, on any computer the tests run on: never the developer's keychain.
    Effect.provideService(Platform, 'linux'),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({
        XDG_CONFIG_HOME: seat.configHome,
        BAYMUTT_URL: ORIGIN,
        ...seat.env,
      }),
    ),
  );

const run = Effect.fnUntraced(function* (
  world: TestWorld,
  seat: Seat,
  args: ReadonlyArray<string>,
  stdin?: string,
) {
  return yield* withSeat(
    world,
    seat,
    Effect.gen(function* () {
      const exit = yield* Effect.exit(Command.runWith(cli, { version: 'test' })(args));
      const stdout = (yield* TestConsole.logLines).join('\n');
      const stderr = (yield* TestConsole.errorLines).join('\n');
      const exitCode = Exit.isSuccess(exit)
        ? 0
        : Exit.findErrorOption(exit).pipe(error =>
            error._tag === 'Some' && error.value instanceof Reported ? error.value.exitCode : 1,
          );
      const lastLine = stderr.split('\n').at(-1) ?? '';
      return {
        exitCode,
        stdout,
        stderr, // Help text, which the parser prints for bad usage, is not a result.
        json: /^[{[]/.test(stdout) ? JSON.parse(stdout) : undefined,
        /** The one JSON error line a failure ends with. */
        error: /^\{"error"/.test(lastLine) ? JSON.parse(lastLine).error : undefined,
      };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          CliLayer,
          // Fresh: a layer is memoized by identity, and every run reads only its own output.
          Layer.fresh(TestConsole.layer),
          Stdio.layerTest({
            stdin: Stream.make(new TextEncoder().encode(stdin ?? '')),
            stdinIsTerminal: Effect.succeed(stdin === undefined),
          }),
        ),
      ),
    ),
  );
});

/** What this key loads, through the same flow the varlock plugin uses. */
const load = (world: TestWorld, seat: Seat, environment: string) =>
  withSeat(
    world,
    seat,
    Effect.map(loadValues(environment), ({ values }) => values).pipe(
      Effect.provide(
        ServiceAccount.layer.pipe(
          Layer.provideMerge(KeyStore.layer),
          Layer.provideMerge(Settings.layer),
        ),
      ),
    ),
  );

const isRefused = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), Exit.isFailure);

const tempDirectory = Effect.flatMap(FileSystem.FileSystem, fs => fs.makeTempDirectoryScoped());

const seat = Effect.map(tempDirectory, (configHome): Seat => ({ configHome }));

/** The same computer as `login`, using a key `baymutt ask` left in a file. */
const withKeyFile = (login: Seat, keyFile: string): Seat => ({
  ...login,
  env: { ...login.env, BAYMUTT_KEY_FILE: keyFile },
});

const isUuid = (text: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text);

type RequestItem = {
  environmentId: string;
  orgId: string;
  environmentName: string;
  environmentSealedName: string | null;
  canRead: boolean;
  canWrite: boolean;
};
type StoredEnvironmentRequest = {
  id: string;
  orgId: string;
  orgSlug: string;
  name: string;
  sealedName: string;
  reason: string;
  status: string;
};
type StoredRequest = {
  id: string;
  status: string;
  command: string | null;
  lifetime: number | null;
  reason: string;
  publicKey: string;
  keyVoucher: string | null;
  maker: { id: string; publicKey: string; endorsement: string | null };
  items: RequestItem[];
};

/** The owner: a real vault and account key, and the dashboard's side of each ceremony. */
const makeOwner = async (world: TestWorld) => {
  const user = world.user();
  const locked = world.signIn(user.id);
  const passkey = { encKey: await derivePasskeyEncKey(crypto.getRandomValues(new Uint8Array(32))) };
  const { vault, wrappedDek } = await createVault(passkey);
  const accountKeys = await createAccountKey(vault);
  const accountId = crypto.randomUUID();
  const proof = await vaultProof(vault, accountId);
  // The dashboard with the vault open: the session, and the proof on every request.
  const session = { ...locked, 'x-baymutt-vault-proof': proof };
  const api = async <Body = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ) => {
    const response = await world.api(`/api/v1${path}`, send(method, body, session));
    const answer = (await response.json()) as Body;
    if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(answer)}`);
    return answer;
  };
  await api('POST', '/account', {
    id: accountId,
    name: 'Test owner',
    ...accountKeys,
    passkey: { credentialId: user.first.credentialId, wrappedDek },
    password: null,
    recoveryWrappedDek: await rewrapDek(
      passkey,
      await recoveryVaultKey(generateRecoveryKey()),
      wrappedDek,
    ),
    vaultProofHash: await tokenHash(proof),
  });
  const keys: OwnerKeys = {
    vault,
    accountId,
    accountKey: await openAccountKey(vault, accountKeys),
  };
  const accountReader = { id: accountId, publicKey: accountKeys.publicKey };

  /** Each org the owner made, by slug, with its names key while its names are sealed. */
  const orgs = new Map<string, { id: string; names: { key: NamesKey; ownWrap: string } | null }>();
  const orgBySlug = (slug: string) => {
    const org = orgs.get(slug);
    if (org === undefined) throw new Error(`no org ${slug}`);
    return org;
  };
  const sealedOrgs = () =>
    [...orgs.values()].flatMap(({ id, names }) => (names === null ? [] : [{ id, ...names }]));
  /** Each environment by its address, as the owner made it or approved it. */
  const environments = new Map<string, { id: string; orgId: string }>();
  const environmentAt = (address: string) => {
    const environment = environments.get(address);
    if (environment === undefined) throw new Error(`no environment ${address}`);
    return environment;
  };
  const namesKeyOf = (orgId: string) => sealedOrgs().find(org => org.id === orgId)?.key ?? null;

  const owned = async (id: string): Promise<OwnedEnvironment> => {
    const { memberWrap, memberProof, keyVersion, creator } = await api<{
      memberWrap: string;
      memberProof: string;
      keyVersion: number;
      creator: OwnedEnvironment['creator'];
    }>('GET', `/environments/${id}/member-wrap`);
    return { environmentId: id, keyVersion, memberWrap, memberProof, creator };
  };

  type Listed = {
    id: string;
    publicKey: string;
    parentId: string | null;
    endorsement: string | null;
  };

  /** A new org, sealed as the dashboard seals one right after making it: its names key wrapped to the owner and each CLI login. */
  const createOrg = async (slug: string, { isSealed = true } = {}) => {
    const { id } = await api<{ id: string }>('POST', '/orgs', { name: slug.toUpperCase(), slug });
    if (!isSealed) {
      orgs.set(slug, { id, names: null });
      return id;
    }
    const { credentials } = await api<{ credentials: Listed[] }>('GET', '/credentials');
    const logins = await Promise.all(
      credentials
        .filter(({ parentId }) => parentId === null)
        .map(login => endorsedReader(keys, login)),
    );
    const { namesKey, wraps } = await createNamesKey({
      accountKey: keys.accountKey,
      orgId: id,
      readers: [accountReader, ...logins],
    });
    const ownWrap = wraps.find(({ readerId }) => readerId === accountId)?.wrap ?? '';
    await api('POST', `/orgs/${id}/seal-names`, { wraps, environments: [], secrets: [] });
    orgs.set(slug, { id, names: { key: namesKey, ownWrap } });
    return id;
  };

  const namesKeyWrapsFor = (reader: { id: string; publicKey: string }, orgIds?: Set<string>) =>
    Promise.all(
      sealedOrgs()
        .filter(({ id }) => orgIds === undefined || orgIds.has(id))
        .map(async ({ id, ownWrap }) => ({
          orgId: id,
          wrap: await rewrapNamesKey({
            ownWrap,
            orgId: id,
            accountKey: keys.accountKey,
            accountId,
            reader,
          }),
        })),
    );

  await createOrg('acme');

  return {
    accountId,
    api,
    createOrg,
    environmentAt,
    /** Approves the link `baymutt auth login` printed, as the pairing page does: each sealed org's names key wrapped to it. */
    approve: async (url: string) => {
      const request: PairingRequest = Schema.decodeUnknownSync(
        Schema.fromJsonString(PairingRequestSchema),
      )(decodeURIComponent(new URL(url).hash.slice(1)));
      const { pairingSecret, ...login } = request;
      await api('POST', '/credentials/pair', {
        ...login,
        ...(await approvePairing(keys, { ...login, pairingSecret })),
        namesKeyWraps: await namesKeyWrapsFor({ id: login.id, publicKey: login.publicKey }),
      });
      return login.id;
    },
    /** An environment made in the dashboard: its key pair made here, its name sealed. */
    createEnvironment: async (address: string) => {
      const [slug = '', ...rest] = address.split('/');
      const org = orgBySlug(slug);
      if (org.names === null) throw new Error(`${slug} is not sealed`);
      const id = crypto.randomUUID();
      const {
        publicKey,
        grants: [member],
      } = await createEnvironmentKey({
        voucherKey: keys.accountKey,
        binding: { environmentId: id, keyVersion: 1 },
        readers: [accountReader],
      });
      await api('POST', '/environments', {
        id,
        orgId: org.id,
        ...(await sealName(org.names.key, { scopeId: org.id, name: rest.join('/') })),
        publicKey,
        memberWrap: member?.wrap,
        memberProof: member?.proof,
      });
      environments.set(address, { id, orgId: org.id });
      return id;
    },
    /** The owner writes a value from the dashboard, sealed in the browser. */
    set: async (address: string, name: string, value: string) => {
      const { id, orgId } = environmentAt(address);
      const environment = await owned(id);
      const { publicKey } = await openOwnedEnvironment(keys, environment);
      const namesKey = namesKeyOf(orgId);
      const stored = namesKey === null ? name : await nameIndex(namesKey, { scopeId: id, name });
      const { secrets } = await api<{ secrets: { name: string; latestVersion: number }[] }>(
        'GET',
        `/environments/${id}/secrets`,
      );
      const version = (secrets.find(secret => secret.name === stored)?.latestVersion ?? 0) + 1;
      await api('PUT', `/environments/${id}/secrets/${stored}`, {
        version,
        keyVersion: environment.keyVersion,
        ciphertext: await sealValue({
          environmentPublicKey: publicKey,
          slot: { environmentId: id, keyVersion: environment.keyVersion, name, version },
          value,
        }),
        ...(namesKey === null || version > 1
          ? {}
          : { sealedName: (await sealName(namesKey, { scopeId: id, name })).sealedName }),
      });
    },
    request: (id: string) => api<StoredRequest>('GET', `/requests/${id}`),
    /** What the request page does on approve: each environment named wrapped to the key its maker vouched for, and the names key of each org it reaches. */
    approveRequest: async (id: string) => {
      const request = await api<StoredRequest>('GET', `/requests/${id}`);
      const reader = await vouchedScopedReader(keys, {
        serviceAccount: { id, publicKey: request.publicKey, keyVoucher: request.keyVoucher },
        maker: request.maker,
      });
      const grants = await Promise.all(
        request.items.map(async item => {
          const environment = await owned(item.environmentId);
          return {
            environmentId: item.environmentId,
            keyVersion: environment.keyVersion,
            ...(await grantToTrustedReader(keys, environment, reader, item)),
          };
        }),
      );
      return api<StoredRequest & { expiresAt: number | null }>('POST', `/requests/${id}/approve`, {
        expiresAt: request.lifetime === null ? null : Date.now() + request.lifetime,
        grants,
        namesKeyWraps: await namesKeyWrapsFor(
          reader,
          new Set(request.items.map(({ orgId }) => orgId)),
        ),
      });
    },
    rejectRequest: (id: string) => api('POST', `/requests/${id}/reject`),
    environmentRequest: (id: string) =>
      api<StoredEnvironmentRequest>('GET', `/environment-requests/${id}`),
    /** What the environment request page does on Create environment: the key pair made here, the request answered in the same write. */
    approveEnvironmentRequest: async (id: string) => {
      const request = await api<StoredEnvironmentRequest>('GET', `/environment-requests/${id}`);
      const {
        publicKey,
        grants: [member],
      } = await createEnvironmentKey({
        voucherKey: keys.accountKey,
        binding: { environmentId: request.id, keyVersion: 1 },
        readers: [accountReader],
      });
      await api('POST', '/environments', {
        id: request.id,
        orgId: request.orgId,
        name: request.name,
        sealedName: request.sealedName,
        publicKey,
        memberWrap: member?.wrap,
        memberProof: member?.proof,
        answers: request.id,
      });
      const name = await openName(namesKeyOf(request.orgId), {
        scopeId: request.orgId,
        stored: { name: request.name, sealedName: request.sealedName },
      });
      environments.set(`${request.orgSlug}/${name}`, { id: request.id, orgId: request.orgId });
    },
    rejectEnvironmentRequest: (id: string) => api('POST', `/environment-requests/${id}/reject`),
    /**
     * An org as a store from before 0.8 left it: names as written, no names key. What the owner's
     * dashboard has not sealed yet.
     */
    unseal: async (slug: string) => {
      const org = orgBySlug(slug);
      if (org.names === null) return;
      const namesKey = org.names.key;
      const rows = <Row>(sql: string, ...params: string[]) =>
        world.sqlite.prepare(sql).all(...params) as Row[];
      type Stored = { id: string; name: string; sealed_name: string | null };
      const unsealed = rows<Stored>(
        'SELECT id, name, sealed_name FROM environment WHERE org_id = ?',
        org.id,
      );
      world.sqlite.exec('PRAGMA foreign_keys = OFF');
      for (const environment of unsealed) {
        const name = await openName(namesKey, {
          scopeId: org.id,
          stored: { name: environment.name, sealedName: environment.sealed_name },
        });
        world.sqlite
          .prepare('UPDATE environment SET name = ?, sealed_name = NULL WHERE id = ?')
          .run(name, environment.id);
        for (const secret of rows<{ name: string; sealed_name: string | null }>(
          'SELECT name, sealed_name FROM secret WHERE environment_id = ?',
          environment.id,
        )) {
          const plain = await openName(namesKey, {
            scopeId: environment.id,
            stored: { name: secret.name, sealedName: secret.sealed_name },
          });
          world.sqlite
            .prepare(
              'UPDATE secret SET name = ?, sealed_name = NULL WHERE environment_id = ? AND name = ?',
            )
            .run(plain, environment.id, secret.name);
          world.sqlite
            .prepare('UPDATE secret_version SET name = ? WHERE environment_id = ? AND name = ?')
            .run(plain, environment.id, secret.name);
        }
      }
      world.sqlite.prepare('DELETE FROM names_key_wrap WHERE org_id = ?').run(org.id);
      world.sqlite.exec('PRAGMA foreign_keys = ON');
      orgs.set(slug, { id: org.id, names: null });
    },
  };
};
type Owner = Awaited<ReturnType<typeof makeOwner>>;

/** A world with an owner, the org `acme`, and one CLI login paired. */
const paired = Effect.gen(function* () {
  const world = testWorld();
  const owner = yield* Effect.promise(() => makeOwner(world));
  const laptop = yield* seat;
  const pending = yield* run(world, laptop, ['auth', 'login', '--name', 'laptop', '--wait', '0']);
  const loginId = yield* Effect.promise(() => owner.approve(pending.json.url));
  const done = yield* run(world, laptop, ['auth', 'login', '--wait', '0']);
  return { world, owner, laptop, loginId, pending, done };
});

/** `baymutt ask` from `login`, returning at once: the request it sent, still waiting. */
const ask = Effect.fnUntraced(function* (
  world: TestWorld,
  login: Seat,
  args: ReadonlyArray<string>,
) {
  const asked = yield* run(world, login, ['ask', 'access', '--reason', 'run the tests', ...args]);
  if (asked.exitCode !== 0) throw new Error(`ask exited ${asked.exitCode}: ${asked.stderr}`);
  return asked.json.id as string;
});

/** Asks, has the owner approve, and picks up the key file: the whole loop an agent runs. */
const askApproved = Effect.fnUntraced(function* (
  world: TestWorld,
  owner: Owner,
  login: Seat,
  args: ReadonlyArray<string>,
) {
  const id = yield* ask(world, login, args);
  yield* Effect.promise(() => owner.approveRequest(id));
  const done = yield* run(world, login, ['ask', 'wait', id]);
  if (done.exitCode !== 0) throw new Error(`wait exited ${done.exitCode}: ${done.stderr}`);
  return { id, done, agent: withKeyFile(login, done.json.keyFile) };
});

/**
 * A store that answers with no names key and every sealed name `sealedName`: missing, as the 0.7
 * store did, or null, as one would that hides an org's sealing. `urls` holds every URL the client
 * asked for, as it sent it.
 */
const hidingSealing = (world: TestWorld, sealedName: null | undefined) => {
  const urls: string[] = [];
  const store: TestWorld = {
    ...world,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      urls.push(request.url);
      const response = await world.fetch(request);
      const body = JSON.parse(await response.text(), (key, value) => {
        if (key === 'namesKeys') return undefined;
        return key === 'sealedName' ? sealedName : value;
      });
      return new Response(JSON.stringify(body), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  return { store, urls };
};

const PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nline three\n-----END PRIVATE KEY-----';

layer(NodeServices.layer)(it => {
  describe('pairing', () => {
    it.effect(
      'prints a link and a code, waits for the owner, then pins the account the browser named',
      () =>
        Effect.gen(function* () {
          const { owner, loginId, pending, done, world, laptop } = yield* paired;

          expect(pending).toMatchObject({
            exitCode: 0,
            json: {
              status: 'pending',
              serviceAccountId: loginId,
              code: expect.stringMatching(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/),
            },
          });
          expect(pending.stderr).toContain(pending.json.code);
          expect(done).toMatchObject({
            exitCode: 0,
            json: {
              status: 'loggedIn',
              serviceAccountId: loginId,
              account: { id: owner.accountId, name: 'Test owner' },
            },
          });
          expect((yield* run(world, laptop, ['env', 'list'])).json).toEqual({
            environments: [],
          });
        }),
    );

    it.effect('refuses a welcome the owner’s browser did not seal for this pairing', () =>
      Effect.gen(function* () {
        const world = testWorld();
        const owner = yield* Effect.promise(() => makeOwner(world));
        const laptop = yield* seat;
        const pending = yield* run(world, laptop, ['auth', 'login', '--wait', '0']);
        yield* Effect.promise(() => owner.approve(pending.json.url));
        // The store answers with a welcome of its own making.
        world.sqlite.exec(
          "UPDATE credential SET welcome = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'",
        );

        const done = yield* run(world, laptop, ['auth', 'login', '--wait', '0']);

        expect(done.exitCode).toBe(8);
        expect(done.error).toMatchObject({ code: 'IntegrityError' });
        // Nothing pinned: it cannot vouch for a key it asks for.
        expect(
          (yield* run(world, laptop, ['ask', 'access', '--read', 'acme/app', '--reason', 'r']))
            .exitCode,
        ).toBe(3);
      }),
    );

    it.effect('says a computer with no key is not logged in, with exit code 3', () =>
      Effect.gen(function* () {
        const result = yield* run(testWorld(), yield* seat, ['auth', 'whoami']);

        expect(result.exitCode).toBe(3);
        expect(result.error).toMatchObject({ code: 'UsageError', exitCode: 3 });
        expect(result.stdout).toBe('');
      }),
    );
  });

  describe('a CLI login', () => {
    it.effect('lists names, which the store keeps sealed, and holds no environment', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(async () => {
          await owner.createEnvironment('acme/app/production');
          await owner.set('acme/app/production', 'API_KEY', 'the value');
          await owner.set('acme/app/production', 'API_KEY', 'the next value');
        });

        const listed = yield* run(world, laptop, ['env', 'list']);
        expect(listed.json.environments).toMatchObject([
          {
            address: 'acme/app/production',
            name: 'app/production',
            orgSlug: 'acme',
            canRead: false,
            canWrite: false,
          },
        ]);
        expect(
          (yield* run(world, laptop, ['secret', 'list', 'acme/app/production'])).json,
        ).toMatchObject({
          environment: 'acme/app/production',
          secrets: [{ name: 'API_KEY', currentVersion: 2 }],
        });
        expect(
          (yield* run(world, laptop, ['secret', 'history', 'acme/app/production', 'API_KEY'])).json
            .versions,
        ).toHaveLength(2);
        expect((yield* run(world, laptop, ['org', 'list'])).json.orgs).toMatchObject([
          { slug: 'acme', areNamesSealed: true },
        ]);
        const schema = `${yield* tempDirectory}/.env.schema`;
        yield* fs.writeFileString(schema, 'API_KEY=\nSTRIPE_KEY=\n');
        expect(
          (yield* run(world, laptop, [
            'secret',
            'check',
            'acme/app/production',
            '--schema',
            schema,
          ])).json,
        ).toMatchObject({ present: ['API_KEY'], missing: ['STRIPE_KEY'] });

        // The store holds neither name as written.
        const stored = JSON.stringify(
          world.sqlite
            .prepare('SELECT name, sealed_name FROM environment')
            .all()
            .concat(world.sqlite.prepare('SELECT name, sealed_name FROM secret').all()),
        );
        expect(stored).not.toContain('app/production');
        expect(stored).not.toContain('API_KEY');
      }),
    );

    it.effect('has only the `<thing> <action>` names: the old top-level ones fail', () =>
      Effect.gen(function* () {
        const { world, laptop } = yield* paired;
        for (const args of [
          ['login'],
          ['logout'],
          ['whoami'],
          ['orgs'],
          ['environments'],
          ['envs'],
          ['secrets', 'acme/app/production'],
          ['set', 'acme/app/production', 'API_KEY'],
          ['service-accounts', 'list'],
          // `list` is explicit, with no `ls` for it.
          ['env', 'ls'],
          ['bin', 'ls'],
          ['service-account', 'ls'],
        ]) {
          expect((yield* run(world, laptop, args)).exitCode, args.join(' ')).not.toBe(0);
        }
        // `environment` is the one alias, and the same list answers to it.
        expect((yield* run(world, laptop, ['environment', 'list'])).json).toEqual({
          environments: [],
        });
        // A bare group prints its help, as `ask` does.
        for (const group of [
          'auth',
          'org',
          'env',
          'secret',
          'bin',
          'service-account',
          'activity',
        ]) {
          const bare = yield* run(world, laptop, [group]);
          expect(bare.json, group).toBeUndefined();
          expect(bare.stdout + bare.stderr, group).toContain('SUBCOMMANDS');
          expect(bare.stdout + bare.stderr, group).toContain(`baymutt ${group} <subcommand>`);
        }
      }),
    );

    it.effect('is refused a load and a write, with the `baymutt ask` that gets one', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(async () => {
          await owner.createEnvironment('acme/app/production');
          await owner.set('acme/app/production', 'API_KEY', 'the value');
        });

        const loaded = yield* Effect.flip(load(world, laptop, 'acme/app/production'));
        expect(loaded.message).toContain('baymutt ask access --read acme/app/production');
        const written = yield* run(
          world,
          laptop,
          ['secret', 'set', 'acme/app/production', 'API_KEY'],
          'x',
        );
        expect(written.exitCode).toBe(4);
        expect(written.error.message).toContain('baymutt ask access --write acme/app/production');
        expect(
          (yield* run(world, laptop, ['secret', 'generate', 'acme/app/production', 'K'])).exitCode,
        ).toBe(4);
        // The commands that made access without the owner are gone, and what is asked of the owner is under `ask`.
        for (const args of [
          ['paste-link', 'acme/app/production', 'K', '--reason', 'r', '--where', 'w'],
          ['wait', 'some-id'],
          ['cancel', 'some-id'],
          ['env', 'create', 'acme/app/dev'],
          ['service-account', 'create', '--name', 'ci', '--', 'true'],
          ['service-account', 'access', 'some-id', '--read', 'acme/app/production'],
        ]) {
          expect((yield* run(world, laptop, args)).exitCode).not.toBe(0);
        }
      }),
    );
  });

  describe('ask', () => {
    it.effect('gives a key file that loads and writes what was asked for, and nothing more', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(async () => {
          for (const address of ['acme/app/production', 'acme/app/staging']) {
            await owner.createEnvironment(address);
            await owner.set(address, 'API_KEY', `for ${address}`);
          }
        });

        const asked = yield* run(world, laptop, [
          'ask',
          'access',
          '--read-write',
          'acme/app/production',
          '--reason',
          'deploy the app',
        ]);
        // It returns at once: where the owner approves it, and how to pick it up.
        expect(asked).toMatchObject({
          exitCode: 0,
          json: {
            status: 'pending',
            url: `${ORIGIN}/requests/${asked.json.id}`,
            next: expect.stringContaining(`baymutt ask wait ${asked.json.id}`),
          },
        });
        expect(isUuid(asked.json.id)).toBe(true);
        const keyFile = `${laptop.configHome}/baymutt/localhost-5183/keys/${asked.json.id}`;
        expect(yield* fs.readFileString(keyFile)).toMatch(/^baymutt_key_/);
        expect(((yield* fs.stat(keyFile)).mode & 0o777).toString(8)).toBe('600');
        const request = yield* Effect.promise(() => owner.request(asked.json.id));
        expect(request).toMatchObject({
          reason: 'deploy the app',
          command: null,
          lifetime: 3600 * 1000,
          items: [{ canRead: true, canWrite: true }],
        });
        // Asked for, not approved: the key holds nothing yet.
        expect(
          yield* isRefused(load(world, withKeyFile(laptop, keyFile), 'acme/app/production')),
        ).toBe(true);

        yield* Effect.promise(() => owner.approveRequest(asked.json.id));
        const approved = yield* run(world, laptop, ['ask', 'wait', asked.json.id]);

        expect(approved).toMatchObject({
          exitCode: 0,
          json: {
            id: asked.json.id,
            status: 'approved',
            keyFile,
            expiresAt: expect.any(Number),
            environments: [{ environment: 'acme/app/production', canRead: true, canWrite: true }],
          },
        });
        expect(approved.stdout + approved.stderr).not.toContain(
          (yield* fs.readFileString(keyFile)).trim(),
        );
        const agent = withKeyFile(laptop, keyFile);
        expect(yield* load(world, agent, 'acme/app/production')).toEqual({
          API_KEY: 'for acme/app/production',
        });
        expect(
          (yield* run(world, agent, ['secret', 'set', 'acme/app/production', 'NEW_KEY'], 'written'))
            .json,
        ).toMatchObject({ environment: 'acme/app/production', name: 'NEW_KEY', version: 1 });
        expect(yield* load(world, agent, 'acme/app/production')).toEqual({
          API_KEY: 'for acme/app/production',
          NEW_KEY: 'written',
        });
        // Nothing it did not ask for.
        expect(yield* isRefused(load(world, agent, 'acme/app/staging'))).toBe(true);
        expect(
          (yield* run(world, agent, ['secret', 'set', 'acme/app/staging', 'API_KEY'], 'x'))
            .exitCode,
        ).toBe(5);
        expect((yield* run(world, agent, ['env', 'list'])).json.environments).toMatchObject([
          { address: 'acme/app/production', canRead: true, canWrite: true },
        ]);
        // A service account asks for nothing more.
        expect(
          (yield* run(world, agent, [
            'ask',
            'access',
            '--read',
            'acme/app/staging',
            '--reason',
            'more',
          ])).exitCode,
        ).toBe(2);
      }),
    );

    it.effect('refuses an environment that does not exist, and says to ask for it first', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, laptop } = yield* paired;

        const missing = yield* run(world, laptop, [
          'ask',
          'access',
          '--write',
          'acme/app/new',
          '--reason',
          'r',
        ]);

        expect(missing.exitCode).toBe(5);
        expect(missing.error.message).toContain(
          'baymutt ask create-environment acme/app/new --reason',
        );
        // Refused before a key was made or anything was sent.
        expect(yield* fs.exists(`${laptop.configHome}/baymutt/localhost-5183/keys`)).toBe(false);
        expect((yield* run(world, laptop, ['ask', 'access', '--create'])).exitCode).not.toBe(0);
      }),
    );

    it.effect('withdraws a request with `ask cancel`, and removes its key', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
        const id = yield* ask(world, laptop, ['--read', 'acme/app/production']);
        const keyFile = `${laptop.configHome}/baymutt/localhost-5183/keys/${id}`;
        expect(yield* fs.exists(keyFile)).toBe(true);

        expect(yield* run(world, laptop, ['ask', 'cancel', id])).toMatchObject({
          exitCode: 0,
          json: { id, status: 'cancelled' },
        });

        expect((yield* Effect.promise(() => owner.request(id))).status).toBe('rejected');
        expect(yield* fs.exists(keyFile)).toBe(false);
        expect((yield* run(world, laptop, ['ask', 'wait', id])).exitCode).toBe(4);
      }),
    );

    it.effect(
      'refuses an id that is not one, and an answer about another id, touching no file',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { world, owner, laptop } = yield* paired;
          yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
          const waiting = yield* ask(world, laptop, ['--read', 'acme/app/production']);
          const approved = yield* ask(world, laptop, ['--read', 'acme/app/production']);
          yield* Effect.promise(() => owner.approveRequest(approved));
          const keys = `${laptop.configHome}/baymutt/localhost-5183/keys`;
          const outside = `${laptop.configHome}/outside`;
          yield* fs.writeFileString(outside, 'not baymutt’s\n');

          for (const command of ['wait', 'cancel']) {
            const refused = yield* run(world, laptop, ['ask', command, '../../../outside']);
            expect(refused.exitCode).toBe(2);
          }
          expect(yield* fs.exists(outside)).toBe(true);

          // A store that answers about the approved request whenever asked about the waiting one.
          const swapping: TestWorld = {
            ...world,
            fetch: (input, init) => {
              const request = new Request(input, init);
              return world.fetch(
                new Request(
                  request.url.replace(`/requests/${waiting}`, `/requests/${approved}`),
                  request,
                ),
              );
            },
          };
          const waited = yield* run(swapping, laptop, ['ask', 'wait', waiting]);
          expect(waited).toMatchObject({ exitCode: 8, stdout: '' });
          const cancelled = yield* run(swapping, laptop, ['ask', 'cancel', waiting]);
          expect(cancelled.exitCode).toBe(8);

          expect((yield* Effect.promise(() => owner.request(approved))).status).toBe('approved');
          expect((yield* Effect.promise(() => owner.request(waiting))).status).toBe('pending');
          expect(yield* fs.exists(`${keys}/${waiting}`)).toBe(true);
          expect(yield* fs.exists(`${keys}/${approved}`)).toBe(true);
        }),
    );

    it.effect('removes the key of a request that never reached the store, and says so', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
        const keys = `${laptop.configHome}/baymutt/localhost-5183/keys`;
        // The request is lost on its way: the key was kept, nothing was made.
        const losing: TestWorld = {
          ...world,
          fetch: (input, init) => {
            const request = new Request(input, init);
            return request.method === 'POST' && new URL(request.url).pathname.endsWith('/requests')
              ? Promise.reject(new TypeError('fetch failed'))
              : world.fetch(request);
          },
        };
        const lost = yield* Effect.forEach(['wait', 'cancel'], () =>
          run(losing, laptop, ['ask', 'access', '--read', 'acme/app/production', '--reason', 'r']),
        );
        const ids = lost.map(({ error }) => {
          expect(error.exitCode).toBe(7);
          return /Request ([0-9a-f-]{36})/.exec(error.message)?.[1] ?? '';
        });

        for (const [command, id] of [
          ['wait', ids[0] ?? ''],
          ['cancel', ids[1] ?? ''],
        ] as const) {
          expect(yield* fs.exists(`${keys}/${id}`)).toBe(true);
          const answered = yield* run(world, laptop, ['ask', command, id]);
          expect(answered.exitCode).toBe(5);
          expect(answered.error.message).toContain('never reached the store');
          expect(yield* fs.exists(`${keys}/${id}`)).toBe(false);
        }
        const unknown = yield* run(world, laptop, ['ask', 'wait', crypto.randomUUID()]);
        expect(unknown.exitCode).toBe(5);
        expect(unknown.error.message).toContain('Nothing this key asked has the id');
      }),
    );

    it.effect('removes the key and exits 4 when the owner rejects it', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
        const id = yield* ask(world, laptop, ['--read', 'acme/app/production']);
        const keyFile = `${laptop.configHome}/baymutt/localhost-5183/keys/${id}`;
        expect(yield* fs.exists(keyFile)).toBe(true);

        yield* Effect.promise(() => owner.rejectRequest(id));
        const rejected = yield* run(world, laptop, ['ask', 'wait', id]);

        expect(rejected).toMatchObject({ exitCode: 4, stdout: '' });
        expect(rejected.error).toMatchObject({
          exitCode: 4,
          message: expect.stringContaining('rejected'),
        });
        expect(yield* fs.exists(keyFile)).toBe(false);
      }),
    );

    it.effect('removes the key of a request nobody answered within the hour', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
        const id = yield* ask(world, laptop, ['--read', 'acme/app/production']);
        const keyFile = `${laptop.configHome}/baymutt/localhost-5183/keys/${id}`;
        // Still waiting: `wait` gives up at its timeout and keeps the key.
        expect(yield* run(world, laptop, ['ask', 'wait', id, '--timeout', '0'])).toMatchObject({
          exitCode: 9,
          json: { status: 'pending' },
        });
        expect(yield* fs.exists(keyFile)).toBe(true);

        world.sqlite
          .prepare('UPDATE access_request SET created_at = created_at - ? WHERE credential_id = ?')
          .run(3600 * 1000, id);
        const expired = yield* run(world, laptop, ['ask', 'wait', id]);

        expect(expired).toMatchObject({ exitCode: 4, stdout: '' });
        expect(expired.error).toMatchObject({
          exitCode: 4,
          message: expect.stringContaining('expired'),
        });
        expect(yield* fs.exists(keyFile)).toBe(false);
      }),
    );

    it.effect('`ask cancel` removes the key of a request that already expired', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
        const id = yield* ask(world, laptop, ['--read', 'acme/app/production']);
        const keyFile = `${laptop.configHome}/baymutt/localhost-5183/keys/${id}`;
        world.sqlite
          .prepare('UPDATE access_request SET created_at = created_at - ? WHERE credential_id = ?')
          .run(3600 * 1000, id);

        // Nothing is left to withdraw, so it fails, and the dead key goes all the same.
        expect((yield* run(world, laptop, ['ask', 'cancel', id])).exitCode).not.toBe(0);
        expect(yield* fs.exists(keyFile)).toBe(false);
      }),
    );

    it.effect('pipes the key into a command only once the owner approves', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(async () => {
          await owner.createEnvironment('acme/app/production');
          await owner.set('acme/app/production', 'API_KEY', 'for ci');
        });
        const received = `${yield* tempDirectory}/received key`;

        const id = yield* ask(world, laptop, [
          '--read',
          'acme/app/production',
          '--',
          'sh',
          '-c',
          `cat > "$0"`,
          received,
        ]);
        expect(yield* fs.exists(received)).toBe(false);
        const request = yield* Effect.promise(() => owner.request(id));
        // The owner sees the command as one line, and a key for a command has no end unless asked.
        expect(request).toMatchObject({
          command: `sh -c 'cat > "$0"' '${received}'`,
          lifetime: null,
        });

        yield* Effect.promise(() => owner.approveRequest(id));
        const piped = yield* run(world, laptop, ['ask', 'wait', id]);

        expect(piped).toMatchObject({
          exitCode: 0,
          json: {
            id,
            status: 'approved',
            piped: true,
            exitCode: 0,
            expiresAt: null,
            environments: [{ environment: 'acme/app/production', canRead: true, canWrite: false }],
          },
        });
        const key = yield* fs.readFileString(received);
        expect(key).toMatch(/^baymutt_key_/);
        expect(piped.stdout + piped.stderr).not.toContain(key);
        // Kept nowhere here once piped.
        expect(yield* fs.exists(`${laptop.configHome}/baymutt/localhost-5183/keys/${id}`)).toBe(
          false,
        );
        // In CI the key comes from BAYMUTT_KEY, and there is no state on disk.
        const ci: Seat = { configHome: yield* tempDirectory, env: { BAYMUTT_KEY: key } };
        expect(yield* load(world, ci, 'acme/app/production')).toEqual({ API_KEY: 'for ci' });
      }),
    );

    it.effect('revokes the key when the command that takes it fails', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
        const id = yield* ask(world, laptop, [
          '--write',
          'acme/app/production',
          '--',
          'sh',
          '-c',
          'exit 3',
        ]);
        yield* Effect.promise(() => owner.approveRequest(id));

        const failed = yield* run(world, laptop, ['ask', 'wait', id]);

        expect(failed.exitCode).toBe(2);
        expect(failed.error.message).toContain('revoked');
        expect(
          (yield* run(world, laptop, ['service-account', 'list'])).json.credentials,
        ).toHaveLength(1);
      }),
    );

    it.effect('takes --expires in minutes, hours or days', () =>
      Effect.gen(function* () {
        expect(yield* durationMs('15m')).toBe(15 * 60 * 1000);
        expect(yield* durationMs('12h')).toBe(12 * 3600 * 1000);
        expect(yield* durationMs('90d')).toBe(90 * 24 * 3600 * 1000);
        for (const wrong of ['soon', '0m', '15', '1w', '1.5h']) {
          expect((yield* Effect.flip(durationMs(wrong))).message).toContain('15m, 12h or 90d');
        }

        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
        const id = yield* ask(world, laptop, ['--read', 'acme/app/production', '--expires', '15m']);
        expect((yield* Effect.promise(() => owner.request(id))).lifetime).toBe(15 * 60 * 1000);
        for (const expires of ['99999d', 'soon']) {
          expect(
            (yield* run(world, laptop, [
              'ask',
              'access',
              '--read',
              'acme/app/production',
              '--reason',
              'r',
              '--expires',
              expires,
            ])).exitCode,
          ).toBe(2);
        }
        expect(
          (yield* run(world, laptop, ['ask', 'access', '--reason', 'nothing named'])).exitCode,
        ).toBe(2);
      }),
    );

    it.effect('removes key files the store no longer lists, and keeps a waiting one', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
        const keys = `${laptop.configHome}/baymutt/localhost-5183/keys`;
        const waiting = yield* ask(world, laptop, ['--read', 'acme/app/production']);
        const revoked = yield* ask(world, laptop, ['--read', 'acme/app/production']);
        yield* run(world, laptop, ['service-account', 'revoke', revoked]);
        const stray = crypto.randomUUID();
        yield* fs.writeFileString(`${keys}/${stray}`, 'baymutt_key_stray\n');
        // A file this young may be an ask in another terminal that has not sent its request yet.
        yield* ask(world, laptop, ['--read', 'acme/app/production']);
        expect(yield* fs.exists(`${keys}/${stray}`)).toBe(true);

        yield* TestClock.setTime(Date.now() + 3600 * 1000);
        yield* ask(world, laptop, ['--read', 'acme/app/production']);

        expect(yield* fs.exists(`${keys}/${waiting}`)).toBe(true);
        expect(yield* fs.exists(`${keys}/${revoked}`)).toBe(false);
        expect(yield* fs.exists(`${keys}/${stray}`)).toBe(false);
      }),
    );

    it.effect('keeps the key of a request approved while it looks for dead ones', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
        const keys = `${laptop.configHome}/baymutt/localhost-5183/keys`;
        const id = yield* ask(world, laptop, ['--read', 'acme/app/production', '--expires', '1d']);
        yield* TestClock.setTime(Date.now() + 3600 * 1000);

        // The owner approves it right after the store answers the first of the two lists, and
        // the second is answered only after that.
        let approved: Promise<unknown> | undefined;
        const approvingMidway: TestWorld = {
          ...world,
          fetch: async (input, init) => {
            const request = new Request(input, init);
            const path = new URL(request.url).pathname;
            if (
              request.method !== 'GET' ||
              !['/api/v1/requests', '/api/v1/credentials'].includes(path)
            ) {
              return world.fetch(request);
            }
            if (approved !== undefined) {
              await approved;
              return world.fetch(request);
            }
            const response = await world.fetch(request);
            approved = owner.approveRequest(id);
            await approved;
            return response;
          },
        };
        yield* ask(approvingMidway, laptop, ['--read', 'acme/app/production']);

        expect(yield* fs.exists(`${keys}/${id}`)).toBe(true);
        expect((yield* run(world, laptop, ['ask', 'wait', id])).json).toMatchObject({
          status: 'approved',
          keyFile: `${keys}/${id}`,
        });
      }),
    );

    it.effect('pipes each key into its own command when several ask at once', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
        const received = yield* tempDirectory;
        const agents = ['one', 'two', 'three', 'four'];

        const ids = yield* Effect.all(
          agents.map(agent =>
            ask(world, laptop, [
              '--read',
              'acme/app/production',
              '--',
              'sh',
              '-c',
              `cat > "$0"`,
              `${received}/${agent}`,
            ]),
          ),
          { concurrency: 'unbounded' },
        );
        yield* Effect.promise(() => Promise.all(ids.map(id => owner.approveRequest(id))));
        const piped = yield* Effect.forEach(ids, id => run(world, laptop, ['ask', 'wait', id]));

        expect(piped.map(({ json }) => json?.piped)).toEqual(agents.map(() => true));
        for (const agent of agents) {
          expect(yield* fs.readFileString(`${received}/${agent}`)).toMatch(/^baymutt_key_/);
        }
        // Nothing of any of them is left here.
        expect(yield* fs.readDirectory(`${laptop.configHome}/baymutt/localhost-5183/keys`)).toEqual(
          [],
        );
      }),
    );

    it.effect(
      'keeps the key when the store’s answer is lost, and removes it when the store refuses',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { world, owner, laptop } = yield* paired;
          yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
          const keys = `${laptop.configHome}/baymutt/localhost-5183/keys`;
          const creating = (answer: (made: Response) => Response): TestWorld => ({
            ...world,
            fetch: async (input, init) => {
              const request = new Request(input, init);
              const isCreate =
                request.method === 'POST' && new URL(request.url).pathname === '/api/v1/requests';
              return isCreate ? answer(await world.fetch(request)) : world.fetch(request);
            },
          });

          // The store made the request, and its answer never arrived.
          const lost = yield* run(
            creating(() => {
              throw new TypeError('fetch failed');
            }),
            laptop,
            ['ask', 'access', '--read', 'acme/app/production', '--reason', 'r'],
          );
          const [id = ''] = yield* fs.readDirectory(keys);
          expect(isUuid(id)).toBe(true);
          expect(lost.exitCode).toBe(7);
          expect(lost.error.message).toContain('may have been made');
          expect(lost.error.message).toContain(`baymutt ask wait ${id}`);
          yield* Effect.promise(() => owner.approveRequest(id));
          expect((yield* run(world, laptop, ['ask', 'wait', id])).json).toMatchObject({
            status: 'approved',
            keyFile: `${keys}/${id}`,
          });

          // The store said no in its own words: there is no request, so no key is kept for one.
          const refused = yield* run(
            creating(
              () =>
                new Response(
                  JSON.stringify({
                    code: 'LimitReachedError',
                    message: 'This account holds as many service accounts as the beta allows.',
                    limit: 200,
                  }),
                  { status: 403, headers: { 'content-type': 'application/json' } },
                ),
            ),
            laptop,
            ['ask', 'access', '--read', 'acme/app/production', '--reason', 'r'],
          );
          expect(refused.exitCode).toBe(6);
          expect(yield* fs.readDirectory(keys)).toEqual([id]);
        }),
    );

    it.effect(
      'pipes or hands out nothing the store calls approved that the owner did not approve',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { world, owner, laptop } = yield* paired;
          yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
          const keys = `${laptop.configHome}/baymutt/localhost-5183/keys`;
          const real = yield* askApproved(world, owner, laptop, ['--read', 'acme/app/production']);
          const received = `${yield* tempDirectory}/received key`;
          const toCommand = yield* ask(world, laptop, [
            '--read',
            'acme/app/production',
            '--',
            'sh',
            '-c',
            `cat > "$0"`,
            received,
          ]);
          const toFile = yield* ask(world, laptop, ['--read', 'acme/app/production']);
          // The store marks both approved without the owner: one holds nothing, the other holds a
          // copy of the real key's access, whose proof was made for another key.
          const markApproved = world.sqlite.prepare(
            `UPDATE access_request SET status = 'approved', resolved_at = 1 WHERE credential_id = ?`,
          );
          markApproved.run(toCommand);
          markApproved.run(toFile);
          world.sqlite
            .prepare(
              `INSERT INTO environment_grant
               (environment_id, credential_id, can_write, read_wrap, key_proof, key_version, created_at)
             SELECT environment_id, ?, can_write, read_wrap, key_proof, key_version, created_at
             FROM environment_grant WHERE credential_id = ?`,
            )
            .run(toFile, real.id);

          for (const id of [toCommand, toFile]) {
            const refused = yield* run(world, laptop, ['ask', 'wait', id]);
            expect(refused).toMatchObject({ exitCode: 8, stdout: '' });
            expect(refused.error.message).toContain('holds no access the owner gave it');
            expect(yield* fs.exists(`${keys}/${id}`)).toBe(true);
          }
          expect(yield* fs.exists(received)).toBe(false);
        }),
    );

    it.effect('is not stopped by a key file another ask removes while it looks for dead ones', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
        const keys = `${laptop.configHome}/baymutt/localhost-5183/keys`;
        const rejected = yield* ask(world, laptop, ['--read', 'acme/app/production']);
        yield* Effect.promise(() => owner.rejectRequest(rejected));
        yield* TestClock.setTime(Date.now() + 3600 * 1000);

        // Another ask removes the dead key's file once this one has read which keys are live.
        const removingMidway: TestWorld = {
          ...world,
          fetch: async (input, init) => {
            const request = new Request(input, init);
            const response = await world.fetch(request);
            if (
              request.method === 'GET' &&
              new URL(request.url).pathname === '/api/v1/credentials'
            ) {
              await fs.remove(`${keys}/${rejected}`).pipe(Effect.runPromise);
            }
            return response;
          },
        };
        const id = yield* ask(removingMidway, laptop, ['--read', 'acme/app/production']);

        expect(yield* fs.readDirectory(keys)).toEqual([id]);
      }),
    );
  });

  describe('ask create-environment', () => {
    it.effect('asks the owner for a new environment, which gives nobody access', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;

        const asked = yield* run(world, laptop, [
          'ask',
          'create-environment',
          'acme/app/staging',
          '--reason',
          'a staging app for the tests',
        ]);

        // It returns at once: where the owner approves it, and how to follow it.
        const { id } = asked.json;
        expect(asked).toMatchObject({
          exitCode: 0,
          json: {
            status: 'pending',
            environment: 'acme/app/staging',
            url: `${ORIGIN}/environment-requests/${id}`,
            next: expect.stringContaining(`baymutt ask wait ${id}`),
          },
        });
        expect(isUuid(id)).toBe(true);
        const request = yield* Effect.promise(() => owner.environmentRequest(id));
        expect(request).toMatchObject({ status: 'pending', reason: 'a staging app for the tests' });
        // The store holds the name sealed, never as typed.
        expect(JSON.stringify(request)).not.toContain('app/staging');
        expect((yield* run(world, laptop, ['env', 'list'])).json.environments).toEqual([]);
        expect(yield* run(world, laptop, ['ask', 'wait', id, '--timeout', '0'])).toMatchObject({
          exitCode: 9,
          json: { id, status: 'pending', url: `${ORIGIN}/environment-requests/${id}` },
        });

        yield* Effect.promise(() => owner.approveEnvironmentRequest(id));

        expect(yield* run(world, laptop, ['ask', 'wait', id])).toMatchObject({
          exitCode: 0,
          json: { id, status: 'approved', environment: 'acme/app/staging' },
        });
        expect((yield* run(world, laptop, ['env', 'list'])).json.environments).toMatchObject([
          { id, address: 'acme/app/staging' },
        ]);
        // Created, not held: access to it is a request of its own.
        expect(
          (yield* run(world, laptop, ['secret', 'set', 'acme/app/staging', 'API_KEY'], 'x'))
            .exitCode,
        ).toBe(4);
        const { agent } = yield* askApproved(world, owner, laptop, ['--write', 'acme/app/staging']);
        expect(
          (yield* run(world, agent, ['secret', 'set', 'acme/app/staging', 'API_KEY'], 'written'))
            .exitCode,
        ).toBe(0);
      }),
    );

    it.effect(
      'refuses a bad address, an org not the person’s, a name taken, and a service account',
      () =>
        Effect.gen(function* () {
          const { world, owner, laptop } = yield* paired;
          yield* Effect.promise(async () => {
            await owner.createEnvironment('acme/app/production');
            await owner.createOrg('legacy', { isSealed: false });
          });
          const createEnvironment = (seat: Seat, address: string) =>
            run(world, seat, ['ask', 'create-environment', address, '--reason', 'r']);

          expect((yield* createEnvironment(laptop, 'acme/App')).exitCode).toBe(2);
          expect((yield* createEnvironment(laptop, 'acme')).exitCode).toBe(2);
          expect((yield* createEnvironment(laptop, 'initech/app')).exitCode).toBe(5);
          const taken = yield* createEnvironment(laptop, 'acme/app/production');
          expect(taken.exitCode).toBe(6);
          expect(taken.error.message).toContain('baymutt ask access --read acme/app/production');
          // No new name in an org the owner's dashboard has not sealed yet.
          const unsealed = yield* createEnvironment(laptop, 'legacy/app');
          expect(unsealed.exitCode).toBe(6);
          expect(unsealed.error.message).toContain('not sealed yet');
          const { agent } = yield* askApproved(world, owner, laptop, [
            '--read',
            'acme/app/production',
          ]);
          expect((yield* createEnvironment(agent, 'acme/app/new')).exitCode).toBe(2);
          // `env create` never ships: asking is the only way.
          expect((yield* run(world, laptop, ['env', 'create', 'acme/app/new'])).exitCode).not.toBe(
            0,
          );
        }),
    );

    it.effect(
      'exits 4 when the owner rejects it, nobody answers within the hour, or it is withdrawn',
      () =>
        Effect.gen(function* () {
          const { world, owner, laptop } = yield* paired;
          const createEnvironment = Effect.map(
            run(world, laptop, ['ask', 'create-environment', 'acme/app/new', '--reason', 'r']),
            ({ json }) => json.id as string,
          );

          const rejected = yield* createEnvironment;
          yield* Effect.promise(() => owner.rejectEnvironmentRequest(rejected));
          const afterReject = yield* run(world, laptop, ['ask', 'wait', rejected]);
          expect(afterReject).toMatchObject({ exitCode: 4, stdout: '' });
          expect(afterReject.error.message).toContain('rejected');

          const late = yield* createEnvironment;
          world.sqlite
            .prepare('UPDATE environment_request SET created_at = created_at - ? WHERE id = ?')
            .run(3600 * 1000, late);
          const afterExpiry = yield* run(world, laptop, ['ask', 'wait', late]);
          expect(afterExpiry).toMatchObject({ exitCode: 4, stdout: '' });
          expect(afterExpiry.error.message).toContain('expired');

          const withdrawn = yield* createEnvironment;
          expect(yield* run(world, laptop, ['ask', 'cancel', withdrawn])).toMatchObject({
            exitCode: 0,
            json: { id: withdrawn, status: 'cancelled' },
          });
          expect((yield* Effect.promise(() => owner.environmentRequest(withdrawn))).status).toBe(
            'rejected',
          );
          expect((yield* run(world, laptop, ['ask', 'wait', withdrawn])).exitCode).toBe(4);
          expect((yield* run(world, laptop, ['env', 'list'])).json.environments).toEqual([]);
        }),
    );
  });

  describe('names', () => {
    it.effect('are opened in every listing', () =>
      Effect.gen(function* () {
        const { world, owner, laptop, loginId } = yield* paired;
        yield* Effect.promise(async () => {
          await owner.createEnvironment('acme/app/production');
          await owner.set('acme/app/production', 'API_KEY', 'first');
        });
        const { id, agent } = yield* askApproved(world, owner, laptop, [
          '--read',
          'acme/app/production',
          '--write',
          'acme/app/production',
        ]);
        yield* run(world, agent, ['secret', 'set', 'acme/app/production', 'API_KEY'], 'second');
        yield* run(world, agent, ['secret', 'set', 'acme/app/production', 'OLD_KEY'], 'old');

        expect(
          (yield* run(world, agent, ['secret', 'delete', 'acme/app/production', 'OLD_KEY'])).json,
        ).toMatchObject({ name: 'OLD_KEY', currentVersion: null });
        expect((yield* run(world, laptop, ['bin', 'list'])).json).toMatchObject({
          environments: [],
          secrets: [{ environmentName: 'app/production', name: 'OLD_KEY', latestVersion: 1 }],
        });
        expect(
          (yield* run(world, agent, [
            'secret',
            'rollback',
            'acme/app/production',
            'API_KEY',
            '--to',
            '1',
          ])).json,
        ).toMatchObject({ name: 'API_KEY', currentVersion: 1 });
        expect(
          (yield* run(world, agent, ['secret', 'history', 'acme/app/production', 'API_KEY'])).json,
        ).toMatchObject({
          environment: 'acme/app/production',
          name: 'API_KEY',
          versions: [
            { version: 2, isCurrent: false },
            { version: 1, isCurrent: true },
          ],
        });
        const activity = (yield* run(world, agent, ['activity', 'list'])).json.events as {
          environmentName: string | null;
          secretName: string | null;
        }[];
        expect(activity.map(({ secretName }) => secretName)).toEqual(
          expect.arrayContaining(['API_KEY', 'OLD_KEY']),
        );
        expect(new Set(activity.flatMap(({ environmentName }) => environmentName ?? []))).toEqual(
          new Set(['app/production']),
        );
        const { credentials } = (yield* run(world, laptop, ['service-account', 'list'])).json;
        expect(credentials).toMatchObject(
          expect.arrayContaining([
            expect.objectContaining({ id: loginId, grants: [] }),
            expect.objectContaining({
              id,
              parentId: loginId,
              grants: [
                expect.objectContaining({
                  environmentName: 'app/production',
                  canRead: true,
                  canWrite: true,
                }),
              ],
            }),
          ]),
        );
        expect((yield* run(world, agent, ['auth', 'whoami'])).json.credential).toMatchObject({
          id,
          grants: [{ environmentName: 'app/production' }],
        });
        // A deleted secret comes back from the bin by its name.
        expect(
          (yield* run(world, agent, ['bin', 'restore', 'acme/app/production', 'OLD_KEY'])).json,
        ).toMatchObject({ name: 'OLD_KEY', currentVersion: 1 });
        expect(yield* load(world, agent, 'acme/app/production')).toEqual({
          API_KEY: 'first',
          OLD_KEY: 'old',
        });
      }),
    );

    it.effect('in another org open with that org’s names key', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(async () => {
          await owner.createOrg('globex');
          await owner.createEnvironment('globex/app/production');
          await owner.createEnvironment('acme/app/production');
        });
        expect(
          (yield* run(world, laptop, ['env', 'list'])).json.environments.map(
            ({ address }: { address: string }) => address,
          ),
        ).toEqual(expect.arrayContaining(['acme/app/production', 'globex/app/production']));
        const { agent } = yield* askApproved(world, owner, laptop, [
          '--read',
          'globex/app/production',
          '--write',
          'globex/app/production',
        ]);
        yield* run(
          world,
          agent,
          ['secret', 'set', 'globex/app/production', 'API_KEY'],
          'globex value',
        );
        expect(yield* load(world, agent, 'globex/app/production')).toEqual({
          API_KEY: 'globex value',
        });
        // A name with no org says what was wrong.
        const unqualified = yield* run(world, laptop, ['secret', 'list', 'app/production']);
        expect(unqualified.exitCode).toBe(5);
        expect(unqualified.error.message).toContain('<org>/<name>');
      }),
    );

    it.effect('refuse a name the store filed under another name’s index', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(async () => {
          await owner.createEnvironment('acme/app/production');
          await owner.set('acme/app/production', 'PUBLIC_URL', 'https://example.com');
          await owner.set('acme/app/production', 'API_KEY', 'the secret');
        });
        // The store shows one sealed name under the other's index.
        world.sqlite.exec(
          'UPDATE secret SET sealed_name = (SELECT sealed_name FROM secret ORDER BY rowid LIMIT 1)',
        );

        expect(
          (yield* run(world, laptop, ['secret', 'list', 'acme/app/production'])).exitCode,
        ).toBe(8);
      }),
    );

    it.effect('as written still load: in an org not sealed yet, and from a 0.7 store', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(async () => {
          await owner.createEnvironment('acme/app/production');
          await owner.set('acme/app/production', 'API_KEY', 'for the deploy');
        });
        const { agent } = yield* askApproved(world, owner, laptop, [
          '--read',
          'acme/app/production',
          '--write',
          'acme/app/production',
        ]);
        yield* Effect.promise(() => owner.unseal('acme'));

        expect(yield* load(world, agent, 'acme/app/production')).toEqual({
          API_KEY: 'for the deploy',
        });
        expect(
          (yield* run(world, laptop, ['secret', 'list', 'acme/app/production'])).json.secrets,
        ).toMatchObject([{ name: 'API_KEY' }]);
        // An existing name takes a new version; a new name waits for the owner to seal the org.
        expect(
          (yield* run(world, agent, ['secret', 'set', 'acme/app/production', 'API_KEY'], 'next'))
            .exitCode,
        ).toBe(0);
        const newName = yield* run(
          world,
          agent,
          ['secret', 'set', 'acme/app/production', 'NEW_KEY'],
          'x',
        );
        expect(newName.exitCode).toBe(6);
        expect(newName.error.message).toContain('not sealed yet');
        expect(
          (yield* run(world, laptop, [
            'ask',
            'paste-link',
            'acme/app/production',
            'NEW_KEY',
            '--reason',
            'r',
            '--where',
            'w',
          ])).exitCode,
        ).toBe(6);

        // The deploy loads with the new plugin from the store it replaces: no sealed name, no names
        // key, and only the routes that store has.
        const lastRelease = hidingSealing(world, undefined);
        expect(yield* load(lastRelease.store, agent, 'acme/app/production')).toEqual({
          API_KEY: 'next',
        });
        const paths = lastRelease.urls.map(url =>
          new URL(url).pathname.replace('/api/v1', '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, ':id'),
        );
        expect(
          new Set(paths).isSubsetOf(new Set(['/environments', '/environments/:id/bundle', '/me'])),
        ).toBe(true);
      }),
    );

    it.effect('typed here never reach a store that hides the sealing, unless it listed them', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        const environmentId = yield* Effect.promise(async () => {
          const id = await owner.createEnvironment('acme/app/production');
          await owner.set('acme/app/production', 'SECRET_VENDOR_TOKEN', 'the secret');
          return id;
        });
        const { agent } = yield* askApproved(world, owner, laptop, [
          '--read',
          'acme/app/production',
          '--write',
          'acme/app/production',
        ]);
        // The org is sealed; the store strips every sealed name and names key, so it looks unsealed.
        const { store, urls } = hidingSealing(world, null);

        for (const args of [
          ['secret', 'history', environmentId, 'SECRET_VENDOR_TOKEN'],
          ['secret', 'delete', environmentId, 'SECRET_VENDOR_TOKEN'],
          ['secret', 'rollback', environmentId, 'SECRET_VENDOR_TOKEN', '--to', '1'],
        ]) {
          const refused = yield* run(store, agent, args);
          expect(refused.exitCode).toBe(5);
          expect(refused.error.message).toContain('no secret SECRET_VENDOR_TOKEN');
        }
        const written = yield* run(
          store,
          agent,
          ['secret', 'set', environmentId, 'SECRET_VENDOR_TOKEN'],
          'x',
        );
        expect(written.exitCode).toBe(6);
        expect(written.error.message).toContain('not sealed yet');

        expect(urls.length).toBeGreaterThan(0);
        expect(urls.filter(url => url.includes('SECRET_VENDOR_TOKEN'))).toEqual([]);
      }),
    );
  });

  describe('values', () => {
    it.effect('are sealed here, stored as ciphertext, and opened by the key that asked', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
        const { agent } = yield* askApproved(world, owner, laptop, [
          '--read',
          'acme/app/production',
          '--write',
          'acme/app/production',
        ]);

        const set = yield* run(
          world,
          agent,
          ['secret', 'set', 'acme/app/production', 'SIGNING_KEY'],
          `${PRIVATE_KEY}\n`,
        );
        const generated = yield* run(world, agent, [
          'secret',
          'generate',
          'acme/app/production',
          'SESSION_SECRET',
        ]);
        yield* run(
          world,
          agent,
          ['secret', 'set', 'acme/app/production', 'KEPT', '--keep-newline'],
          'v\n',
        );

        expect(set).toMatchObject({
          exitCode: 0,
          json: {
            environment: 'acme/app/production',
            name: 'SIGNING_KEY',
            version: 1,
            length: PRIVATE_KEY.length,
          },
        });
        expect(generated.json).toMatchObject({ name: 'SESSION_SECRET', version: 1, length: 43 });
        const loaded = yield* load(world, agent, 'acme/app/production');
        expect(loaded.SIGNING_KEY).toBe(PRIVATE_KEY);
        expect(loaded.SESSION_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(loaded.KEPT).toBe('v\n');

        // No command printed a value, and the store holds none.
        for (const output of [set.stdout, set.stderr, generated.stdout, generated.stderr]) {
          expect(output).not.toContain('MIIEvQIBADANBg');
          expect(output).not.toContain(loaded.SESSION_SECRET);
        }
        const stored = JSON.stringify(
          world.sqlite
            .prepare('SELECT * FROM secret_version')
            .all()
            .concat(world.sqlite.prepare('SELECT * FROM activity_event').all()),
        );
        expect(stored).not.toContain('MIIEvQIBADANBg');
        expect(stored).not.toContain(loaded.SESSION_SECRET);
        // From stdin only.
        expect(
          (yield* run(world, agent, ['secret', 'set', 'acme/app/production', 'K'])).exitCode,
        ).toBe(2);
        expect(
          (yield* run(world, agent, ['secret', 'set', 'acme/app/production', 'K'], '')).exitCode,
        ).toBe(2);
      }),
    );

    it.effect('are refused when the store swaps the environment’s key or a value’s slot', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(async () => {
          await owner.createEnvironment('acme/app/production');
          await owner.set('acme/app/production', 'PUBLIC_URL', 'https://example.com');
          await owner.set('acme/app/production', 'API_KEY', 'the secret');
        });
        const { agent } = yield* askApproved(world, owner, laptop, [
          '--read',
          'acme/app/production',
          '--write',
          'acme/app/production',
        ]);
        const versions = () =>
          world.sqlite.prepare('SELECT COUNT(*) AS versions FROM secret_version').get();
        const before = versions();

        // The store answers one name with the other's ciphertext.
        world.sqlite.exec(
          'UPDATE secret_version SET ciphertext = (SELECT ciphertext FROM secret_version ORDER BY rowid LIMIT 1)',
        );
        expect(yield* isRefused(load(world, agent, 'acme/app/production'))).toBe(true);

        // A store that wants to read the next value shows a public key of its own, then a whole
        // environment of its own: key and wrap.
        const environmentId = owner.environmentAt('acme/app/production').id;
        const forged = yield* Effect.promise(() => generateEnvironmentKey());
        world.sqlite.prepare('UPDATE environment SET public_key = ?').run(forged.publicKey);
        expect(
          (yield* run(
            world,
            agent,
            ['secret', 'set', 'acme/app/production', 'API_KEY'],
            'for the store',
          )).exitCode,
        ).toBe(8);
        const credentialRow = world.sqlite
          .prepare('SELECT id, public_key FROM credential WHERE parent_id IS NOT NULL')
          .get() as { id: string; public_key: string };
        const wrap = yield* Effect.promise(() =>
          wrapEnvironmentKey({
            environmentPrivateKey: forged.privateKey,
            readerPublicKey: credentialRow.public_key,
            readerId: credentialRow.id,
            binding: { environmentId, keyVersion: 1 },
          }),
        );
        world.sqlite.prepare('UPDATE environment_grant SET read_wrap = ?').run(wrap);
        expect(yield* isRefused(load(world, agent, 'acme/app/production'))).toBe(true);
        expect(versions()).toEqual(before);
      }),
    );
  });

  describe('paste links', () => {
    it.effect('a CLI login makes one, for the signed-in owner to answer', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));

        const asked = yield* run(world, laptop, [
          'ask',
          'paste-link',
          'acme/app/production',
          'STRIPE_SECRET_KEY',
          '--reason',
          'to take payments',
          '--where',
          'Stripe dashboard, Developers, API keys',
        ]);

        expect(asked).toMatchObject({
          exitCode: 0,
          json: {
            status: 'pending',
            environment: 'acme/app/production',
            name: 'STRIPE_SECRET_KEY',
            url: `${ORIGIN}/paste/${asked.json.id}`,
          },
        });
        // Nobody has pasted yet: `wait` gives up at its timeout and says the link is open.
        expect(
          yield* run(world, laptop, ['ask', 'wait', asked.json.id, '--timeout', '0']),
        ).toMatchObject({
          exitCode: 9,
          json: { status: 'pending' },
        });

        // The paste page, signed in with the vault open: fetch the target, seal, post.
        const target = yield* Effect.promise(() =>
          owner.api<{ environmentPublicKey: string; keyVersion: number; nextVersion: number }>(
            'GET',
            `/paste/${asked.json.id}`,
          ),
        );
        const ciphertext = yield* Effect.promise(() =>
          sealValue({
            environmentPublicKey: target.environmentPublicKey,
            slot: {
              environmentId: owner.environmentAt('acme/app/production').id,
              keyVersion: target.keyVersion,
              name: 'STRIPE_SECRET_KEY',
              version: target.nextVersion,
            },
            value: 'sk_live_pasted',
          }),
        );
        yield* Effect.promise(() =>
          owner.api('POST', `/paste/${asked.json.id}`, {
            version: target.nextVersion,
            keyVersion: target.keyVersion,
            ciphertext,
          }),
        );

        expect(yield* run(world, laptop, ['ask', 'wait', asked.json.id])).toMatchObject({
          exitCode: 0,
          json: { id: asked.json.id, status: 'fulfilled' },
        });
        expect(
          (yield* run(world, laptop, ['secret', 'list', 'acme/app/production'])).json.secrets,
        ).toMatchObject([{ name: 'STRIPE_SECRET_KEY', currentVersion: 1 }]);

        // One made by mistake is withdrawn: nothing waits for it.
        const mistaken = yield* run(world, laptop, [
          'ask',
          'paste-link',
          'acme/app/production',
          'NOT_NEEDED',
          '--reason',
          'asked by mistake',
          '--where',
          'nowhere',
        ]);
        expect(yield* run(world, laptop, ['ask', 'cancel', mistaken.json.id])).toMatchObject({
          exitCode: 0,
          json: { id: mistaken.json.id, status: 'cancelled' },
        });
        expect((yield* run(world, laptop, ['ask', 'wait', mistaken.json.id])).exitCode).toBe(4);

        // One nobody answers within the hour expires: `wait` says so, and the owner cannot use it.
        const late = yield* run(world, laptop, [
          'ask',
          'paste-link',
          'acme/app/production',
          'ASKED_AT_NIGHT',
          '--reason',
          'the owner was asleep',
          '--where',
          'the vendor',
        ]);
        world.sqlite
          .prepare('UPDATE paste_link SET created_at = created_at - ? WHERE id = ?')
          .run(3600 * 1000, late.json.id);
        const expired = yield* run(world, laptop, ['ask', 'wait', late.json.id]);
        expect(expired.error).toMatchObject({
          exitCode: 4,
          message: expect.stringContaining('expired'),
        });
        expect(
          yield* Effect.promise(() =>
            owner.api('GET', `/paste/${late.json.id}`).then(
              () => 'opened',
              (error: unknown) => String(error),
            ),
          ),
        ).toContain('LinkSpentError');
      }),
    );
  });

  describe('logging in and out', () => {
    it.effect(
      'carries a description and an expiry in the link, and names a login after this computer',
      () =>
        Effect.gen(function* () {
          // `--expires` counts from the Clock, which a test starts at 0.
          yield* TestClock.setTime(Date.now());
          const world = testWorld();
          const owner = yield* Effect.promise(() => makeOwner(world));
          const laptop = yield* seat;
          const pending = yield* run(world, laptop, [
            'auth',
            'login',
            '--description',
            'Agents on the work laptop',
            '--expires',
            '90d',
            '--wait',
            '0',
          ]);
          const fragment = JSON.parse(decodeURIComponent(new URL(pending.json.url).hash.slice(1)));
          expect(fragment).toMatchObject({
            name: expect.stringMatching(/^CLI on \S/),
            description: 'Agents on the work laptop',
            expiresAt: expect.any(Number),
          });
          yield* Effect.promise(() => owner.approve(pending.json.url));

          const { credentials } = yield* Effect.promise(() =>
            owner.api<{ credentials: { description: string; expiresAt: number }[] }>(
              'GET',
              '/credentials',
            ),
          );
          expect(credentials).toMatchObject([{ description: 'Agents on the work laptop' }]);
          const days = ((credentials[0]?.expiresAt ?? 0) - Date.now()) / (24 * 3600 * 1000);
          expect(Math.round(days)).toBe(90);
          expect(
            (yield* run(world, yield* seat, ['auth', 'login', '--expires', 'soon', '--wait', '0']))
              .exitCode,
          ).toBe(2);
        }),
    );

    it.effect('reads a link from a CLI before 0.3.0, which carries no description or expiry', () =>
      Effect.sync(() => {
        const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(PairingRequestSchema))(
          JSON.stringify({
            id: crypto.randomUUID(),
            name: 'service account 1a2b3c4d',
            publicKey: 'hSDwCYkwp1R0i33ctD73Wg2_Og0mOBr066SpjqqbTmo',
            bearerHash: 'hSDwCYkwp1R0i33ctD73Wg2_Og0mOBr066SpjqqbTmo',
            pairingSecret: 'hSDwCYkwp1R0i33ctD73Wg2_Og0mOBr066SpjqqbTmo',
          }),
        );
        expect(decoded).not.toHaveProperty('description');
        expect(decoded).not.toHaveProperty('expiresAt');
      }),
    );

    it.effect(
      'logout revokes this login and the keys its requests made, and forgets their keys',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { world, owner, laptop, loginId } = yield* paired;
          yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
          const { agent } = yield* askApproved(world, owner, laptop, [
            '--write',
            'acme/app/production',
          ]);
          const ci: Seat = { configHome: laptop.configHome, env: { BAYMUTT_KEY: 'unused' } };
          const keys = `${laptop.configHome}/baymutt/localhost-5183/keys`;

          // A service account's key file, or one that is not there, logs nothing out.
          const asAgent = yield* run(world, agent, ['auth', 'logout']);
          expect(asAgent.exitCode).toBe(2);
          expect(asAgent.error.message).toContain('baymutt service-account revoke');
          const missing = withKeyFile(laptop, `${laptop.configHome}/no such key`);
          expect((yield* run(world, missing, ['auth', 'logout'])).exitCode).toBe(3);
          expect(yield* fs.exists(keys)).toBe(true);
          expect((yield* run(world, laptop, ['auth', 'whoami'])).exitCode).toBe(0);
          expect((yield* run(world, agent, ['auth', 'whoami'])).exitCode).toBe(0);

          const refused = yield* run(world, ci, ['auth', 'logout']);
          expect(refused.exitCode).toBe(2);
          expect(refused.error.message).toContain('BAYMUTT_KEY');

          // Another computer's CLI login, brought here in BAYMUTT_KEY_FILE, logs nothing out here.
          const desktop = yield* seat;
          const pairing = yield* run(world, desktop, [
            'auth',
            'login',
            '--name',
            'desktop',
            '--wait',
            '0',
          ]);
          yield* Effect.promise(() => owner.approve(pairing.json.url));
          yield* run(world, desktop, ['auth', 'login', '--wait', '0']);
          const visiting = yield* run(
            world,
            withKeyFile(laptop, `${desktop.configHome}/baymutt/localhost-5183/key`),
            ['auth', 'logout'],
          );
          expect(visiting.exitCode).toBe(2);
          expect(visiting.error.message).toContain('not the one this computer logged in with');
          expect(yield* fs.exists(keys)).toBe(true);
          expect((yield* run(world, laptop, ['auth', 'whoami'])).exitCode).toBe(0);
          expect((yield* run(world, desktop, ['auth', 'whoami'])).exitCode).toBe(0);
          expect((yield* run(world, desktop, ['auth', 'logout'])).exitCode).toBe(0);

          // The CLI login itself, named by BAYMUTT_KEY_FILE, as a container keeps it.
          const out = yield* run(
            world,
            withKeyFile(laptop, `${laptop.configHome}/baymutt/localhost-5183/key`),
            ['auth', 'logout'],
          );
          expect(out).toMatchObject({ exitCode: 0, json: { status: 'loggedOut' } });
          expect(out.json.revoked).toHaveLength(2);
          expect((yield* run(world, laptop, ['auth', 'whoami'])).exitCode).toBe(3);
          expect((yield* run(world, agent, ['auth', 'whoami'])).exitCode).toBe(3);
          // Its requests' keys are gone from here too.
          expect(yield* fs.exists(`${laptop.configHome}/baymutt/localhost-5183/keys`)).toBe(false);
          const { credentials } = yield* Effect.promise(() =>
            owner.api<{ credentials: unknown[] }>('GET', '/credentials'),
          );
          expect(credentials).toEqual([]);

          // Logging in again starts over, with a new key.
          const again = yield* run(world, laptop, ['auth', 'login', '--wait', '0']);
          expect(again.json).toMatchObject({ status: 'pending' });
          expect(again.json.serviceAccountId).not.toBe(loginId);
        }),
    );

    it.effect('a key from a request stops when it expires, with its own error', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
        const { id, agent } = yield* askApproved(world, owner, laptop, [
          '--read',
          'acme/app/production',
        ]);
        expect((yield* run(world, agent, ['auth', 'whoami'])).exitCode).toBe(0);

        world.sqlite
          .prepare('UPDATE credential SET expires_at = ? WHERE id = ?')
          .run(Date.now() - 1, id);

        const expired = yield* run(world, agent, ['auth', 'whoami']);
        expect(expired.exitCode).toBe(3);
        expect(expired.error.message).toContain('expired');
      }),
    );
  });
});
