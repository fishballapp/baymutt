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
  openHint,
  openName,
  openOwnedEnvironment,
  openProposedValue,
  recoveryVaultKey,
  rewrapDek,
  rewrapNamesKey,
  sealName,
  sealNote,
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
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import * as Stdio from 'effect/Stdio';
import * as Stream from 'effect/Stream';
import * as TestClock from 'effect/testing/TestClock';
import * as TestConsole from 'effect/testing/TestConsole';
import { CliLayer, cli } from './app.ts';
import { EXAMPLE_PLAN } from './commands/ask.ts';
import { loadValues } from './environments.ts';
import { Reported } from './errors.ts';
import { KeyStore, Platform } from './key-store.ts';
import { decodePlanDocument } from './plan-document.ts';
import { PLAN_JSON_SCHEMA } from './plan-schema.ts';
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

/** Whether `stdout` is one compact JSON object per line (`ask wait` of several), not one pretty-printed object. */
const isLines = (stdout: string) => stdout.split('\n').every(line => /^\{.*\}$/.test(line));

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
        json: /^[{[]/.test(stdout) && !isLines(stdout) ? JSON.parse(stdout) : undefined,
        /** What a command that prints one JSON object per line printed, in the order printed. */
        lines: isLines(stdout) ? stdout.split('\n').map(line => JSON.parse(line)) : [],
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

type PlanEnvironment = {
  environmentId: string;
  environmentName: string | null;
  environmentSealedName: string | null;
};
type StoredPlan = {
  id: string;
  org: { id: string; slug: string };
  maker: { id: string; publicKey: string; endorsement: string | null };
  steps: Array<{
    type: 'environments' | 'access' | 'change' | 'secrets';
    index: number;
    status: string;
    note: string | null;
    end?: number | 'never' | 'keep';
    command?: string | null;
    key?: { id: string; publicKey: string; keyVoucher: string | null; expiresAt: number | null };
    read?: PlanEnvironment[];
    giveBack?: PlanEnvironment[];
    items?: Array<
      PlanEnvironment & {
        op: string;
        name?: string;
        sealedName?: string | null;
        nextVersion?: number | null;
        keyVersion?: number | null;
        value?: string | null;
        sealedHint?: string | null;
      }
    >;
  }>;
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
  const opened = new Map<string, string>();
  const hints = new Map<string, string>();

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
    /** The owner deletes an environment from the dashboard: it goes to the bin. */
    deleteEnvironment: (address: string) =>
      api('DELETE', `/environments/${environmentAt(address).id}`),
    /** The owner deletes a secret from the dashboard: it goes to the bin. */
    deleteSecret: async (address: string, name: string) => {
      const { id, orgId } = environmentAt(address);
      const namesKey = namesKeyOf(orgId);
      const stored = namesKey === null ? name : await nameIndex(namesKey, { scopeId: id, name });
      await api('DELETE', `/environments/${id}/secrets/${stored}`);
    },
    plan: (id: string) => api<StoredPlan>('GET', `/plans/${id}`),
    /** Each value the plan page opened, by `<step>/<name>`: what the owner saw before approving. */
    opened,
    /** Each paste item's hint the plan page opened, by `<step>/<name>`. */
    hints,
    /**
     * What the plan page does on Approve: the owner's browser makes what the step names, as the
     * dashboard will. `pasted` is what the owner pastes for each `paste` item, by name; `note` goes
     * back sealed to the login that asked; `expiresAt` is the end the owner picks for a key (absent:
     * as asked, or for a change, its end kept).
     */
    approveStep: async (
      id: string,
      index: number,
      {
        note,
        pasted = {},
        expiresAt,
      }: {
        readonly note?: string;
        readonly pasted?: Record<string, string>;
        readonly expiresAt?: number | null;
      } = {},
    ) => {
      const plan = await api<StoredPlan>('GET', `/plans/${id}`);
      const step = plan.steps[index];
      if (step === undefined) throw new Error(`plan ${id} has no step ${index}`);
      const maker = await endorsedReader(keys, plan.maker);
      const sealedNote =
        note === undefined
          ? {}
          : {
              note: await sealNote({
                accountKey: keys.accountKey,
                loginPublicKey: maker.publicKey,
                step: { planId: id, stepIndex: index, decision: 'approved' },
                note,
              }),
            };
      const namesKey = namesKeyOf(plan.org.id);
      const readGrants = async (
        reader: { id: string; publicKey: string },
        read: ReadonlyArray<{ environmentId: string }>,
      ) => ({
        grants: await Promise.all(
          read.map(async ({ environmentId }) => {
            const environment = await owned(environmentId);
            return {
              environmentId,
              keyVersion: environment.keyVersion,
              ...(await grantToTrustedReader(keys, environment, reader, { canRead: true })),
            };
          }),
        ),
        namesKeyWraps:
          read.length === 0 ? [] : await namesKeyWrapsFor(reader, new Set([plan.org.id])),
      });
      const answer = await (async () => {
        if (step.type === 'environments') {
          const creates = (step.items ?? []).filter(({ op }) => op === 'create');
          return {
            type: step.type,
            creates: await Promise.all(
              creates.map(async ({ environmentId, environmentName, environmentSealedName }) => {
                const {
                  publicKey,
                  grants: [member],
                } = await createEnvironmentKey({
                  voucherKey: keys.accountKey,
                  binding: { environmentId, keyVersion: 1 },
                  readers: [accountReader],
                });
                const name = await openName(namesKey, {
                  scopeId: plan.org.id,
                  stored: { name: environmentName ?? '', sealedName: environmentSealedName },
                });
                environments.set(`${plan.org.slug}/${name}`, {
                  id: environmentId,
                  orgId: plan.org.id,
                });
                return {
                  environmentId,
                  publicKey,
                  memberWrap: member?.wrap,
                  memberProof: member?.proof,
                };
              }),
            ),
          };
        }
        if (step.type === 'access' || step.type === 'change') {
          const key = step.key;
          if (key === undefined) throw new Error('a key step with no key');
          const reader = await vouchedScopedReader(keys, {
            serviceAccount: key,
            maker: plan.maker,
          });
          const asked = step.end === 'never' || step.end === 'keep' ? null : step.end;
          const end = (() => {
            if (expiresAt !== undefined) return { expiresAt };
            if (step.type === 'change' && step.end === 'keep') return {};
            return { expiresAt: asked === null ? null : Date.now() + (asked ?? 0) };
          })();
          return { type: step.type, ...end, ...(await readGrants(reader, step.read ?? [])) };
        }
        const items = step.items ?? [];
        return {
          type: step.type,
          values: await Promise.all(
            items.flatMap((item, position) => {
              const { nextVersion, keyVersion } = item;
              if (typeof nextVersion !== 'number' || typeof keyVersion !== 'number') return [];
              return [
                (async () => {
                  const { environmentId } = item;
                  const name = await openName(namesKeyOf(plan.org.id), {
                    scopeId: environmentId,
                    stored: { name: item.name ?? '', sealedName: item.sealedName ?? null },
                  });
                  const slot = { planId: id, stepIndex: index, environmentId, name };
                  if (typeof item.sealedHint === 'string') {
                    const hint = await openHint({
                      accountKey: keys.accountKey,
                      loginPublicKey: maker.publicKey,
                      slot,
                      ciphertext: item.sealedHint,
                    });
                    hints.set(`${index}/${name}`, hint);
                  }
                  const value = await (async () => {
                    if (item.op === 'paste') return pasted[name] ?? 'pasted';
                    if (item.op === 'generate') return `generated-${crypto.randomUUID()}`;
                    return openProposedValue({
                      accountKey: keys.accountKey,
                      loginPublicKey: maker.publicKey,
                      slot,
                      ciphertext: item.value ?? '',
                    });
                  })();
                  opened.set(`${index}/${name}`, value);
                  const environment = await owned(environmentId);
                  const { publicKey } = await openOwnedEnvironment(keys, environment);
                  return {
                    item: position,
                    version: nextVersion,
                    keyVersion,
                    ciphertext: await sealValue({
                      environmentPublicKey: publicKey,
                      slot: { environmentId, keyVersion, name, version: nextVersion },
                      value,
                    }),
                  };
                })(),
              ];
            }),
          ),
        };
      })();
      return api<StoredPlan>('POST', `/plans/${id}/steps/${index}/approve`, {
        ...answer,
        ...sealedNote,
      });
    },
    /** What the plan page does on Reject, with a note for the agent if one is given. */
    rejectStep: async (id: string, index: number, { note }: { readonly note?: string } = {}) => {
      const plan = await api<StoredPlan>('GET', `/plans/${id}`);
      const maker = await endorsedReader(keys, plan.maker);
      return api<StoredPlan>(
        'POST',
        `/plans/${id}/steps/${index}/reject`,
        note === undefined
          ? {}
          : {
              note: await sealNote({
                accountKey: keys.accountKey,
                loginPublicKey: maker.publicKey,
                step: { planId: id, stepIndex: index, decision: 'rejected' },
                note,
              }),
            },
      );
    },
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

type Plan = { readonly reason?: string; readonly steps: ReadonlyArray<unknown> };

/** `baymutt ask` from `login`, the plan on stdin, returning at once. */
const ask = (world: TestWorld, login: Seat, { reason = 'run the tests', steps }: Plan) =>
  run(world, login, ['ask'], JSON.stringify({ reason, steps }));

/** `baymutt ask` that must succeed: the plan's id. */
const asked = Effect.fnUntraced(function* (world: TestWorld, login: Seat, plan: Plan) {
  const answer = yield* ask(world, login, plan);
  if (answer.exitCode !== 0) throw new Error(`ask exited ${answer.exitCode}: ${answer.stderr}`);
  return answer.json.id as string;
});

/** `baymutt ask wait`, with no wait of its own: the owner has answered, or the test says it has not. */
const wait = (world: TestWorld, login: Seat, id: string, ...flags: ReadonlyArray<string>) =>
  run(world, login, ['ask', 'wait', id, ...flags]);

/** An `access` step reading `read`, the whole plan an agent sends for a key. */
const reading = (...read: ReadonlyArray<string>) => ({ steps: [{ type: 'access', read }] });

/** Asks for a key that reads `read`, has the owner approve, and picks up its file: the loop an agent runs. */
const askApproved = Effect.fnUntraced(function* (
  world: TestWorld,
  owner: Owner,
  login: Seat,
  ...read: ReadonlyArray<string>
) {
  const id = yield* asked(world, login, reading(...read));
  yield* Effect.promise(() => owner.approveStep(id, 0));
  const done = yield* wait(world, login, id);
  if (done.exitCode !== 0) throw new Error(`wait exited ${done.exitCode}: ${done.stderr}`);
  const [line] = done.lines;
  return { id: line.key as string, plan: id, done, agent: withKeyFile(login, line.keyFile) };
});

const keysOf = (seat: Seat) => `${seat.configHome}/baymutt/localhost-5183/keys`;

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
        yield* Effect.promise(() => owner.createEnvironment('acme/app'));
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
        // Nothing pinned: it cannot vouch for a key it asks for, nor seal a value to the owner.
        expect((yield* ask(world, laptop, reading('acme/app'))).exitCode).toBe(3);
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
          },
        ]);
        expect(listed.json.environments[0]).not.toHaveProperty('canWrite');
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
        const checked = yield* run(world, laptop, [
          'secret',
          'check',
          'acme/app/production',
          '--schema',
          schema,
        ]);
        expect(checked.json).toMatchObject({ present: ['API_KEY'], missing: ['STRIPE_KEY'] });
        expect(checked.error.message).toContain('baymutt ask');

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

    it.effect('has only the `<thing> <action>` names, and one way to ask', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
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
          ['service-account', 'list'],
          ['service-account', 'revoke', 'some-id'],
          ['env', 'ls'],
          ['bin', 'ls'],
          ['key', 'ls'],
          // Asking is one plan, and nothing writes but the owner.
          ['ask', 'access', '--read', 'acme/app/production', '--reason', 'r'],
          ['ask', 'change', crypto.randomUUID(), '--read', 'acme/app/production'],
          ['ask', 'create-environment', 'acme/app/dev', '--reason', 'r'],
          ['ask', 'paste-link', 'acme/app/production', 'K', '--reason', 'r', '--where', 'w'],
          ['secret', 'set', 'acme/app/production', 'K'],
          ['secret', 'generate', 'acme/app/production', 'K'],
          ['secret', 'delete', 'acme/app/production', 'K'],
          ['secret', 'rollback', 'acme/app/production', 'K', '--to', '1'],
          ['bin', 'restore', 'acme/app/production', 'K'],
        ]) {
          expect((yield* run(world, laptop, args, 'x')).exitCode, args.join(' ')).not.toBe(0);
        }
        expect(world.sqlite.prepare('SELECT COUNT(*) AS n FROM plan').get()).toEqual({ n: 0 });
        // `environment` is the one alias, and the same list answers to it.
        expect((yield* run(world, laptop, ['environment', 'list'])).json.environments).toHaveLength(
          1,
        );
        // A bare group prints its help.
        for (const group of ['auth', 'org', 'env', 'secret', 'bin', 'key', 'activity']) {
          const bare = yield* run(world, laptop, [group]);
          expect(bare.json, group).toBeUndefined();
          expect(bare.stdout + bare.stderr, group).toContain('SUBCOMMANDS');
          expect(bare.stdout + bare.stderr, group).toContain(`baymutt ${group} <subcommand>`);
        }
      }),
    );

    it.effect('is refused a load, with the plan that gets one', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(async () => {
          await owner.createEnvironment('acme/app/production');
          await owner.set('acme/app/production', 'API_KEY', 'the value');
        });

        const loaded = yield* Effect.flip(load(world, laptop, 'acme/app/production'));
        expect(loaded.message).toContain('`access` step that reads acme/app/production');
        expect(loaded.message).toContain('baymutt ask');
      }),
    );
  });

  describe('ask schema and ask --check', () => {
    /** A world that fails any request: these commands never reach the store. */
    const offline = (): TestWorld => ({
      ...testWorld(),
      fetch: () => Promise.reject(new Error('the network was used')),
    });
    const VALUES = ['file-secret-xyz', 'dotenv-secret-xyz', 'env-secret-xyz'];
    const planWith = (from: ReadonlyArray<unknown>) =>
      JSON.stringify({
        reason: 'set up the preview',
        steps: [
          { type: 'environments', items: [{ op: 'create', environment: 'acme/app' }] },
          {
            type: 'secrets',
            items: from.map((source, index) => ({
              op: 'set',
              environment: 'acme/app',
              name: `S${index}`,
              from: source,
            })),
          },
        ],
      });

    it.effect('prints the format with no login and no network', () =>
      Effect.gen(function* () {
        const printed = yield* run(offline(), yield* seat, ['ask', 'schema']);
        expect(printed.exitCode).toBe(0);
        expect(printed.json).toEqual(JSON.parse(JSON.stringify(PLAN_JSON_SCHEMA)));
        expect(printed.json.description).toContain('one org');
      }),
    );

    it.effect('checks a plan and sends nothing, printing no value', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const world = offline();
        const computer = yield* seat;
        const here = yield* tempDirectory;
        yield* fs.writeFileString(`${here}/key.pem`, VALUES[0] ?? '');
        yield* fs.writeFileString(`${here}/.env`, `OTHER=${VALUES[1]}\n`);
        const plan = planWith([
          { file: `${here}/key.pem` },
          { dotenv: `${here}/.env`, key: 'OTHER' },
          { env: 'FROM_THE_ENVIRONMENT' },
        ]);

        const checked = yield* run(
          world,
          { ...computer, env: { FROM_THE_ENVIRONMENT: VALUES[2] ?? '' } },
          ['ask', '--check'],
          plan,
        );

        expect(checked.exitCode).toBe(0);
        expect(checked.lines).toEqual([
          {
            isWellFormed: true,
            isSent: false,
            org: 'acme',
            steps: [
              { index: 0, type: 'environments' },
              { index: 1, type: 'secrets' },
            ],
            next: expect.stringContaining('Nothing was sent'),
          },
        ]);
        for (const value of VALUES) expect(checked.stdout + checked.stderr).not.toContain(value);
        expect(world.sqlite.prepare('SELECT COUNT(*) AS n FROM plan').get()).toEqual({ n: 0 });
        // The same plan as a file.
        yield* fs.writeFileString(`${here}/plan.json`, plan);
        const asFile = yield* run(world, { ...computer, env: { FROM_THE_ENVIRONMENT: 'x' } }, [
          'ask',
          '--check',
          `${here}/plan.json`,
        ]);
        expect(asFile.lines[0]).toMatchObject({ isWellFormed: true, isSent: false });
      }),
    );

    it.effect('refuses as `ask` does: the same sentence and the same exit code', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const world = offline();
        const computer = yield* seat;
        const here = yield* tempDirectory;
        yield* fs.writeFileString(`${here}/large`, 'x'.repeat(65_537));
        const plans = [
          '{"reason": ',
          JSON.stringify({
            reason: 'r',
            steps: [{ type: 'access', read: ['acme/a', 'globex/b'] }],
          }),
          JSON.stringify({
            reason: 'r',
            steps: [{ type: 'access', read: ['acme/a'], expires: '1w' }],
          }),
          JSON.stringify({
            reason: 'r',
            steps: [{ type: 'access', read: ['acme/a'], expires: '99999d' }],
          }),
          planWith([{ file: `${here}/none` }]),
          planWith([{ env: 'NOT_SET_ANYWHERE' }]),
          planWith([{ file: `${here}/large` }]),
        ];
        for (const plan of plans) {
          const checked = yield* run(world, computer, ['ask', '--check'], plan);
          // `ask` stops at the login it has not got only after the same refusals.
          const asked = yield* run(world, computer, ['ask'], plan);
          expect(checked.exitCode, plan).not.toBe(0);
          expect(checked.error, plan).toBeDefined();
          if (asked.error.code === 'UsageError' && asked.exitCode !== 3) {
            expect(checked.error).toEqual(asked.error);
          }
        }
        // Where `ask` would go on to the login, `--check` has gone through the same refusals.
        expect((yield* run(world, computer, ['ask'], plans[4])).exitCode).toBe(3);
        expect((yield* run(world, computer, ['ask', '--check'], plans[4])).exitCode).toBe(5);
      }),
    );

    it.effect('is in the help, and the root help keeps to a line about `ask`', () =>
      Effect.gen(function* () {
        const world = offline();
        const computer = yield* seat;
        const ask = yield* run(world, computer, ['ask', '--help']);
        expect(ask.stdout + ask.stderr).toContain('`baymutt ask schema`');
        expect(ask.stdout + ask.stderr).toContain('`baymutt ask --check plan.json`');
        expect(ask.stdout + ask.stderr).toContain('`wait`, `cancel` or `schema`');
        // What agents guessed at: the end's format and start, the limits, a value from chat.
        for (const said of [
          '`30m`, `12h`, `14d`), or `"never"`',
          'counted from when the owner approves the step',
          'replaces the key’s end rather than adding to it',
          'At most 20 steps, 50 items in a step and 200 across the plan',
          'not even one you were told in chat',
          'are each optional, and one is needed',
          'unless `key` names another',
        ]) {
          expect(ask.stdout + ask.stderr).toContain(said);
        }
        const root = yield* run(world, computer, ['--help']);
        expect(root.stdout + root.stderr).not.toContain(EXAMPLE_PLAN);
        expect(root.stdout + root.stderr).toContain('Ask the owner for anything a task needs');
      }),
    );
  });

  describe('ask', () => {
    it.effect('shows one plan with every step type in its help, which it takes as written', () =>
      Effect.gen(function* () {
        const { world, laptop } = yield* paired;
        const help = yield* run(world, laptop, ['ask', '--help']);
        const shown = help.stdout + help.stderr;
        expect(shown).toContain('baymutt ask plan.json');
        expect(shown).toContain(EXAMPLE_PLAN);
        expect(shown).toContain('`./wait`');
        const decoded = decodePlanDocument(EXAMPLE_PLAN);
        if (Result.isFailure(decoded)) throw new Error(decoded.failure);
        const { steps } = decoded.success.plan;
        expect(new Set(steps.map(({ type }) => type))).toEqual(
          new Set(['environments', 'access', 'change', 'secrets']),
        );
        expect(
          new Set(
            steps.flatMap(step => (step.type === 'secrets' ? step.items : [])).map(i => i.op),
          ),
        ).toEqual(new Set(['set', 'paste', 'generate', 'delete', 'restore', 'rollback']));
      }),
    );

    it.effect(
      'asks for every step type in one plan; wait finishes each, with the owner’s note',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { world, owner, laptop } = yield* paired;
          const here = yield* tempDirectory;
          yield* Effect.promise(async () => {
            await owner.createEnvironment('acme/app/staging');
            await owner.set('acme/app/staging', 'OLD', 'one');
            await owner.set('acme/app/staging', 'OLD', 'two');
            await owner.set('acme/app/staging', 'GONE', 'gone');
            await owner.set('acme/app/staging', 'BINNED', 'binned');
            await owner.deleteSecret('acme/app/staging', 'BINNED');
            await owner.createEnvironment('acme/app/archive');
            await owner.deleteEnvironment('acme/app/archive');
          });
          // A key this login holds already, which the plan changes.
          const held = yield* askApproved(world, owner, laptop, 'acme/app/staging');
          yield* fs.writeFileString(`${here}/signing.pem`, `${PRIVATE_KEY}\n`);
          yield* fs.writeFileString(
            `${here}/.env.preview`,
            '# the preview\nDATABASE_URL="postgres://preview"\nOTHER=1\n',
          );
          const received = `${here}/received key`;
          const agentSeat: Seat = { ...laptop, env: { SENTRY_DSN: 'https://sentry.example/1' } };
          const preview = 'acme/app/preview';

          const plan = {
            reason: 'Set up the preview deploy',
            steps: [
              {
                type: 'environments',
                items: [
                  { op: 'create', environment: preview },
                  { op: 'restore', environment: 'acme/app/archive' },
                ],
              },
              {
                type: 'secrets',
                items: [
                  {
                    op: 'set',
                    environment: preview,
                    name: 'DATABASE_URL',
                    from: { dotenv: `${here}/.env.preview` },
                  },
                  {
                    op: 'set',
                    environment: preview,
                    name: 'SIGNING_KEY',
                    from: { file: `${here}/signing.pem` },
                  },
                  { op: 'set', environment: preview, name: 'SENTRY', from: { env: 'SENTRY_DSN' } },
                  { op: 'paste', environment: preview, name: 'STRIPE', hint: 'Stripe dashboard' },
                  { op: 'generate', environment: preview, name: 'SESSION' },
                  { op: 'rollback', environment: 'acme/app/staging', name: 'OLD', version: 1 },
                  { op: 'delete', environment: 'acme/app/staging', name: 'GONE' },
                  { op: 'restore', environment: 'acme/app/staging', name: 'BINNED' },
                  {
                    op: 'set',
                    environment: 'acme/app/archive',
                    name: 'ARCHIVED',
                    from: { dotenv: `${here}/.env.preview`, key: 'OTHER' },
                  },
                ],
              },
              { type: 'access', read: [preview, 'acme/app/archive'], expires: '2h' },
              {
                type: 'access',
                reason: 'CI deploys the preview',
                read: [preview],
                name: 'Preview CI',
                command: ['sh', '-c', 'cat > "$0"', received],
              },
              {
                type: 'change',
                key: held.id,
                read: [preview],
                giveBack: ['acme/app/staging'],
                expires: '1d',
              },
            ],
          };
          const file = `${here}/plan.json`;
          yield* fs.writeFileString(file, JSON.stringify(plan));
          const sent = yield* run(world, agentSeat, ['ask', file]);

          // It returns at once: the link the owner opens, and each step waiting for them.
          expect(sent).toMatchObject({
            exitCode: 0,
            json: {
              status: 'pending',
              url: `${ORIGIN}/orgs/acme/ask/${sent.json.id}`,
              steps: [0, 1, 2, 3, 4].map(index => ({ index, status: 'pending' })),
              next: expect.stringMatching(/last line.*baymutt ask wait.*in the background/s),
            },
          });
          const id: string = sent.json.id;
          expect(isUuid(id)).toBe(true);
          const stored = yield* Effect.promise(() => owner.plan(id));
          expect(stored.steps.map(({ type }) => type)).toEqual([
            'environments',
            'secrets',
            'access',
            'access',
            'change',
          ]);
          expect(stored.steps[2]).toMatchObject({ command: null, end: 2 * 3600 * 1000 });
          expect(stored.steps[3]).toMatchObject({
            command: `sh -c 'cat > "$0"' '${received}'`,
            end: 'never',
          });
          expect(stored.steps[4]).toMatchObject({ end: 24 * 3600 * 1000 });
          // Each new key is kept here before the plan is sent, and holds nothing yet.
          const keyIds = [stored.steps[2]?.key?.id ?? '', stored.steps[3]?.key?.id ?? ''];
          for (const keyId of keyIds) {
            expect(yield* fs.readFileString(`${keysOf(laptop)}/${keyId}`)).toMatch(/^baymutt_key_/);
            expect(((yield* fs.stat(`${keysOf(laptop)}/${keyId}`)).mode & 0o777).toString(8)).toBe(
              '600',
            );
          }
          expect(
            yield* isRefused(
              load(world, withKeyFile(laptop, `${keysOf(laptop)}/${keyIds[0]}`), preview),
            ),
          ).toBe(true);

          // Nothing waits on a step the owner has not answered: a wait that times out says so.
          expect(yield* wait(world, laptop, id, '--timeout', '0')).toMatchObject({
            exitCode: 9,
            lines: [0, 1, 2, 3, 4].map(index => ({ plan: id, index, status: 'pending' })),
          });

          yield* Effect.promise(async () => {
            await owner.approveStep(id, 0, { note: 'Made the preview; the archive is back.' });
            await owner.approveStep(id, 1, { pasted: { STRIPE: 'sk_test_pasted' } });
            await owner.approveStep(id, 2);
            await owner.approveStep(id, 3, { note: 'Rotate it in a month.' });
            await owner.approveStep(id, 4);
          });
          // The owner's browser opened each proposed value as it was on this computer.
          expect(Object.fromEntries(owner.opened)).toMatchObject({
            '1/DATABASE_URL': 'postgres://preview',
            '1/SIGNING_KEY': `${PRIVATE_KEY}\n`,
            '1/SENTRY': 'https://sentry.example/1',
            '1/ARCHIVED': '1',
          });

          const done = yield* wait(world, laptop, id);
          expect(done.exitCode).toBe(0);
          const [created, written, kept, piped, changed] = done.lines;
          expect(created).toEqual({
            plan: id,
            index: 0,
            type: 'environments',
            status: 'approved',
            note: 'Made the preview; the archive is back.',
          });
          expect(written).toEqual({ plan: id, index: 1, type: 'secrets', status: 'approved' });
          expect(kept).toMatchObject({
            index: 2,
            type: 'access',
            status: 'approved',
            key: keyIds[0],
            keyFile: `${keysOf(laptop)}/${keyIds[0]}`,
            environments: [preview, 'acme/app/archive'],
          });
          expect(piped).toMatchObject({
            index: 3,
            status: 'approved',
            key: keyIds[1],
            piped: true,
            exitCode: 0,
            expiresAt: null,
            note: 'Rotate it in a month.',
          });
          expect(changed).toMatchObject({
            index: 4,
            type: 'change',
            status: 'approved',
            key: held.id,
            environments: [preview],
          });

          // The key kept in a file reads exactly what it asked for.
          const agent = withKeyFile(laptop, kept.keyFile);
          const values = yield* load(world, agent, preview);
          expect(values).toMatchObject({
            DATABASE_URL: 'postgres://preview',
            SIGNING_KEY: `${PRIVATE_KEY}\n`,
            SENTRY: 'https://sentry.example/1',
            STRIPE: 'sk_test_pasted',
            SESSION: expect.stringMatching(/^generated-/),
          });
          expect(yield* load(world, agent, 'acme/app/archive')).toEqual({ ARCHIVED: '1' });
          expect(yield* isRefused(load(world, agent, 'acme/app/staging'))).toBe(true);
          // The one piped into its command was kept nowhere here, and works as BAYMUTT_KEY.
          const token = yield* fs.readFileString(received);
          expect(yield* fs.exists(`${keysOf(laptop)}/${keyIds[1]}`)).toBe(false);
          const ci: Seat = { configHome: yield* tempDirectory, env: { BAYMUTT_KEY: token } };
          expect((yield* load(world, ci, preview)).STRIPE).toBe('sk_test_pasted');
          // The changed key reads the preview now, and gave staging back.
          expect((yield* load(world, held.agent, preview)).STRIPE).toBe('sk_test_pasted');
          expect(yield* isRefused(load(world, held.agent, 'acme/app/staging'))).toBe(true);
          // The owner's secrets step happened as asked in staging too.
          const after = yield* askApproved(world, owner, laptop, 'acme/app/staging');
          expect(yield* load(world, after.agent, 'acme/app/staging')).toEqual({
            OLD: 'one',
            BINNED: 'binned',
          });

          // No value was printed, and the store holds none as written.
          const printed = [sent, done].map(({ stdout, stderr }) => stdout + stderr).join('\n');
          const dump = JSON.stringify(
            ['plan_item', 'secret_version', 'activity_event', 'plan_step'].flatMap(table =>
              world.sqlite.prepare(`SELECT * FROM ${table}`).all(),
            ),
          );
          for (const value of [
            'postgres://preview',
            'MIIEvQIBADANBg',
            'sentry.example',
            'sk_test_pasted',
            token.trim(),
          ]) {
            expect(printed).not.toContain(value);
            expect(dump).not.toContain(value);
          }
          // The note reaches the agent, and the store holds it sealed.
          expect(dump).not.toContain('Rotate it in a month');
          // Everything is finished: what was kept for the plan goes, and a second wait says so.
          expect(yield* fs.exists(`${keysOf(laptop)}/${id}.plan`)).toBe(false);
          expect((yield* wait(world, laptop, id)).exitCode).toBe(5);
        }),
    );

    it.effect('seals a paste item’s hint so that only the owner’s vault opens it', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app'));
        // What a weak agent did when pushed: the value itself, in the hint.
        const planted = 'sk_live_51PlantedInTheHint';
        const hint = `Stripe dashboard, Developers, API keys: ${planted}`;
        const bodies: string[] = [];
        const recording: TestWorld = {
          ...world,
          fetch: async (input, init) => {
            const request = new Request(input, init);
            bodies.push(await request.clone().text());
            return world.fetch(request);
          },
        };
        const id = yield* asked(recording, laptop, {
          steps: [
            {
              type: 'secrets',
              items: [
                { op: 'paste', environment: 'acme/app', name: 'STRIPE', hint },
                { op: 'paste', environment: 'acme/app', name: 'BARE' },
              ],
            },
          ],
        });
        const kept = yield* fs.readFileString(`${keysOf(laptop)}/${id}.plan`);
        const stored = yield* Effect.promise(() => owner.plan(id));
        expect(stored.steps[0]?.items?.map(({ sealedHint }) => typeof sealedHint)).toEqual([
          'string',
          'object',
        ]);
        yield* Effect.promise(() => owner.approveStep(id, 0));
        expect(Object.fromEntries(owner.hints)).toEqual({ '0/STRIPE': hint });
        const done = yield* wait(world, laptop, id);
        expect(done.exitCode).toBe(0);

        expect(bodies.some(body => body.includes('"sealedHint"'))).toBe(true);
        const dump = JSON.stringify(
          ['plan', 'plan_step', 'plan_item', 'activity_event'].flatMap(table =>
            world.sqlite.prepare(`SELECT * FROM ${table}`).all(),
          ),
        );
        for (const words of [planted, 'Stripe dashboard']) {
          for (const body of bodies) expect(body).not.toContain(words);
          expect(dump).not.toContain(words);
          expect(kept).not.toContain(words);
          expect(done.stdout + done.stderr).not.toContain(words);
        }
      }),
    );

    it.effect(
      'reads each value where its item says, and refuses one that is not there, empty or too large',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { world, owner, laptop } = yield* paired;
          yield* Effect.promise(() => owner.createEnvironment('acme/app'));
          const here = yield* tempDirectory;
          yield* fs.writeFileString(`${here}/empty`, '');
          yield* fs.writeFileString(`${here}/large`, 'x'.repeat(65_537));
          yield* fs.writeFileString(`${here}/.env`, 'PRESENT=yes\nBLANK=\n');
          const setting = (from: unknown) => ({
            steps: [
              { type: 'access', read: ['acme/app'] },
              {
                type: 'secrets',
                items: [
                  { op: 'generate', environment: 'acme/app', name: 'FIRST' },
                  { op: 'set', environment: 'acme/app', name: 'PRESENT', from },
                ],
              },
            ],
          });
          const seatWith = { ...laptop, env: { EMPTY_VARIABLE: '' } };

          for (const [from, exitCode, message] of [
            [{ file: `${here}/none` }, 5, 'steps[1].items[1].from.file: there is no file'],
            [
              { env: 'NOT_SET_ANYWHERE' },
              5,
              'steps[1].items[1].from.env: NOT_SET_ANYWHERE is not set',
            ],
            [{ env: 'EMPTY_VARIABLE' }, 5, 'steps[1].items[1].from.env: EMPTY_VARIABLE is not set'],
            [
              { dotenv: `${here}/.env`, key: 'ABSENT' },
              5,
              `steps[1].items[1].from: ${here}/.env has no ABSENT`,
            ],
            [{ dotenv: `${here}/.env`, key: 'BLANK' }, 2, 'the value there is empty'],
            [{ file: `${here}/empty` }, 2, 'the value there is empty'],
            [{ file: `${here}/large` }, 2, 'is 65537 bytes, and a value may be 65536'],
          ] as const) {
            const refused = yield* ask(world, seatWith, setting(from));
            expect(refused.exitCode, JSON.stringify(from)).toBe(exitCode);
            expect(refused.error.message).toContain(message);
          }
          // Refused before anything was sent, or any key kept.
          expect(world.sqlite.prepare('SELECT COUNT(*) AS n FROM plan').get()).toEqual({ n: 0 });
          expect(yield* fs.exists(keysOf(laptop))).toBe(false);

          // A dotenv's variable is the item's name unless `key` says otherwise.
          const id = yield* asked(world, laptop, setting({ dotenv: `${here}/.env` }));
          yield* Effect.promise(() => owner.approveStep(id, 1));
          expect(owner.opened.get('1/PRESENT')).toBe('yes');
        }),
    );

    it.effect('refuses a plan it cannot use, naming the path, before anything is sent', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(async () => {
          await owner.createOrg('globex');
          await owner.createEnvironment('acme/app');
          await owner.createEnvironment('globex/app');
        });
        const refusals: ReadonlyArray<readonly [unknown, number, string]> = [
          [
            { steps: [{ type: 'access', read: ['acme/app'] }], org: 'acme' },
            2,
            'org: nothing reads this field. The fields of the plan are: reason, steps.',
          ],
          [
            { steps: [{ type: 'access' }] },
            2,
            'steps[0].read is missing. The fields of steps[0] are: type, reason?, read, expires?, name?, command?.',
          ],
          [
            { steps: [{ type: 'acces', read: ['acme/app'] }] },
            2,
            'steps[0].type: expected "environments", "access", "change" or "secrets".',
          ],
          [
            {
              steps: [
                {
                  type: 'secrets',
                  items: [{ op: 'set', environment: 'acme/app', name: 'A', value: 'sk_live_x' }],
                },
              ],
            },
            2,
            'steps[0].items[0].value: nothing reads this field. A plan never holds a value',
          ],
          [
            { steps: [{ type: 'access', read: ['app'] }] },
            2,
            'steps[0].read[0]: expected an environment as <org>/<name>',
          ],
          [
            { steps: [{ type: 'access', read: ['acme/app'], expires: '1w' }] },
            2,
            'steps[0].expires: expected minutes, hours or days',
          ],
          [
            { steps: [{ type: 'access', read: ['acme/app'], expires: '99999d' }] },
            2,
            'steps[0]: a key lasts between one minute and ten years',
          ],
          [
            { steps: [{ type: 'access', read: ['acme/app', 'acme/app'] }] },
            2,
            'steps[0].read[1]: this step already names acme/app',
          ],
          [
            {
              steps: [
                {
                  type: 'secrets',
                  items: [
                    { op: 'generate', environment: 'acme/app', name: 'A' },
                    { op: 'delete', environment: 'acme/app', name: 'A' },
                  ],
                },
              ],
            },
            2,
            'steps[0].items[1]: this step already names A in acme/app. A step names each secret once.',
          ],
          [
            {
              steps: [
                { type: 'access', read: ['acme/app'] },
                { type: 'access', read: ['globex/app'] },
              ],
            },
            2,
            'steps[1].read[0]: a plan asks in one org, and this one names acme and globex',
          ],
          [
            { steps: [{ type: 'access', read: ['acme/nothing'] }] },
            5,
            'steps[0].read[0]: acme/nothing is not an environment of acme',
          ],
          [
            { steps: [{ type: 'access', read: ['initech/app'] }] },
            5,
            'none of your orgs is initech',
          ],
          [
            {
              steps: [{ type: 'environments', items: [{ op: 'create', environment: 'acme/app' }] }],
            },
            6,
            'steps[0].items[0].environment: acme/app already exists',
          ],
          [
            {
              steps: [
                { type: 'environments', items: [{ op: 'restore', environment: 'acme/old' }] },
              ],
            },
            5,
            'acme/old is not in the bin of acme',
          ],
          [
            {
              steps: [
                { type: 'access', read: ['acme/new'] },
                { type: 'environments', items: [{ op: 'create', environment: 'acme/new' }] },
              ],
            },
            5,
            'no earlier step creates or restores it',
          ],
          // The store refuses what only it can know, at its path.
          [
            {
              steps: [
                {
                  type: 'secrets',
                  items: [{ op: 'delete', environment: 'acme/app', name: 'NONE' }],
                },
              ],
            },
            5,
            'steps[0].items[0]: this environment has no secret by this name',
          ],
          [
            { steps: [{ type: 'change', key: crypto.randomUUID(), read: ['acme/app'] }] },
            5,
            'steps[0].keyId',
          ],
        ];
        for (const [plan, exitCode, message] of refusals) {
          const refused = yield* run(
            world,
            laptop,
            ['ask'],
            JSON.stringify({ reason: 'r', ...(plan as object) }),
          );
          expect(refused.exitCode, message).toBe(exitCode);
          expect(refused.error.message).toContain(message);
        }
        expect(world.sqlite.prepare('SELECT COUNT(*) AS n FROM plan').get()).toEqual({ n: 0 });
        expect(
          yield* fs.readDirectory(keysOf(laptop)).pipe(Effect.orElseSucceed(() => [])),
        ).toEqual([]);

        expect((yield* run(world, laptop, ['ask'], '{ "reason": ')).error.message).toContain(
          'The plan is not JSON',
        );
        // No plan at all: neither a file nor stdin.
        expect((yield* run(world, laptop, ['ask'])).exitCode).toBe(2);
        expect(
          (yield* run(world, laptop, ['ask', `${laptop.configHome}/none.json`])).exitCode,
        ).toBe(5);
        // A file named `wait` is read as the subcommand; `./wait` is the file.
        const here = yield* tempDirectory;
        yield* fs.writeFileString(
          `${here}/wait`,
          JSON.stringify({ reason: 'r', ...reading('acme/app') }),
        );
        expect((yield* run(world, laptop, ['ask', `${here}/wait`])).exitCode).toBe(0);
        // A key asks for nothing itself.
        const { agent } = yield* askApproved(world, owner, laptop, 'acme/app');
        const fromKey = yield* ask(world, agent, reading('acme/app'));
        expect(fromKey.exitCode).toBe(2);
        expect(fromKey.error.message).toContain('runs from a CLI login');
      }),
    );

    it.effect(
      'prints every step when one is rejected, with the owner’s note, and removes its key',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { world, owner, laptop } = yield* paired;
          yield* Effect.promise(() => owner.createEnvironment('acme/app'));
          const id = yield* asked(world, laptop, {
            steps: [
              { type: 'access', read: ['acme/app'] },
              {
                type: 'secrets',
                items: [{ op: 'generate', environment: 'acme/app', name: 'TOKEN' }],
              },
            ],
          });
          const keyId = (yield* Effect.promise(() => owner.plan(id))).steps[0]?.key?.id ?? '';
          expect(yield* fs.exists(`${keysOf(laptop)}/${keyId}`)).toBe(true);

          yield* Effect.promise(async () => {
            await owner.rejectStep(id, 0, { note: 'Use the staging key instead.' });
            await owner.approveStep(id, 1);
          });
          const rejected = yield* wait(world, laptop, id);

          expect(rejected.exitCode).toBe(4);
          expect(rejected.lines).toEqual([
            {
              plan: id,
              index: 0,
              type: 'access',
              status: 'rejected',
              note: 'Use the staging key instead.',
            },
            { plan: id, index: 1, type: 'secrets', status: 'approved' },
          ]);
          expect(rejected.error.message).toContain(
            'Step 0 did not go through: the owner rejected it',
          );
          expect(yield* fs.exists(`${keysOf(laptop)}/${keyId}`)).toBe(false);
          // What it printed is kept: it waits for nothing more and says the same again.
          expect(yield* fs.exists(`${keysOf(laptop)}/${id}.plan`)).toBe(false);
        }),
    );

    it.effect('finishes what was answered at a timeout, and the rest on the next wait', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(async () => {
          await owner.createEnvironment('acme/app');
          await owner.set('acme/app', 'API_KEY', 'the value');
        });
        const id = yield* asked(world, laptop, {
          steps: [
            { type: 'access', read: ['acme/app'] },
            { type: 'access', read: ['acme/app'] },
          ],
        });
        yield* Effect.promise(() => owner.approveStep(id, 0));

        const early = yield* wait(world, laptop, id, '--timeout', '0');
        expect(early.exitCode).toBe(9);
        expect(early.error.message).toContain(`baymutt ask wait ${id}`);
        const [first, second] = early.lines;
        expect(first).toMatchObject({ index: 0, status: 'approved', keyFile: expect.any(String) });
        expect(second).toEqual({ plan: id, index: 1, type: 'access', status: 'pending' });
        expect(yield* load(world, withKeyFile(laptop, first.keyFile), 'acme/app')).toEqual({
          API_KEY: 'the value',
        });

        yield* Effect.promise(() => owner.approveStep(id, 1));
        const done = yield* wait(world, laptop, id);
        expect(done.exitCode).toBe(0);
        // The first is printed as it ended, not finished again.
        expect(done.lines[0]).toEqual(first);
        expect(done.lines[1]).toMatchObject({ index: 1, status: 'approved' });
        expect(yield* fs.exists(`${keysOf(laptop)}/${id}.plan`)).toBe(false);
        expect((yield* wait(world, laptop, id, '--timeout', 'soon')).exitCode).not.toBe(0);
      }),
    );

    it.effect('removes the key of a step nobody answered within the hour', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app'));
        const id = yield* asked(world, laptop, reading('acme/app'));
        const keyId = (yield* Effect.promise(() => owner.plan(id))).steps[0]?.key?.id ?? '';
        world.sqlite
          .prepare('UPDATE plan SET created_at = created_at - ? WHERE id = ?')
          .run(3600 * 1000, id);

        const expired = yield* wait(world, laptop, id);
        expect(expired).toMatchObject({
          exitCode: 4,
          lines: [{ index: 0, status: 'expired' }],
        });
        expect(expired.error.message).toContain('nobody answered it within an hour');
        expect(yield* fs.exists(`${keysOf(laptop)}/${keyId}`)).toBe(false);
      }),
    );

    it.effect('withdraws a plan with `ask cancel`, and removes its keys', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app'));
        const id = yield* asked(world, laptop, {
          steps: [
            { type: 'access', read: ['acme/app'] },
            { type: 'access', read: ['acme/app'] },
          ],
        });
        const plan = yield* Effect.promise(() => owner.plan(id));
        const [answered, waiting] = plan.steps.map(step => step.key?.id ?? '');
        yield* Effect.promise(() => owner.approveStep(id, 0));

        const cancelled = yield* run(world, laptop, ['ask', 'cancel', id]);
        expect(cancelled).toMatchObject({
          exitCode: 0,
          json: {
            id,
            status: 'cancelled',
            steps: [
              { index: 0, status: 'approved' },
              { index: 1, status: 'cancelled' },
            ],
            next: expect.stringContaining(`baymutt ask wait ${id}`),
          },
        });
        expect(yield* fs.exists(`${keysOf(laptop)}/${waiting}`)).toBe(false);
        // The step answered before it was withdrawn is still finished by a wait.
        const done = yield* wait(world, laptop, id);
        expect(done.exitCode).toBe(4);
        expect(done.lines.map(({ status }) => status)).toEqual(['approved', 'cancelled']);
        expect(done.lines[0].keyFile).toBe(`${keysOf(laptop)}/${answered}`);
        // Nothing is left to withdraw.
        expect((yield* run(world, laptop, ['ask', 'cancel', id])).exitCode).toBe(6);
        for (const command of ['wait', 'cancel']) {
          expect((yield* run(world, laptop, ['ask', command, '../../../outside'])).exitCode).toBe(
            2,
          );
        }
      }),
    );

    it.effect('shows no note the owner did not seal for that step and decision', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app'));
        const id = yield* asked(world, laptop, {
          steps: [
            { type: 'secrets', items: [{ op: 'generate', environment: 'acme/app', name: 'A' }] },
            { type: 'secrets', items: [{ op: 'generate', environment: 'acme/app', name: 'B' }] },
          ],
        });
        yield* Effect.promise(async () => {
          await owner.rejectStep(id, 0, { note: 'Not this one.' });
          await owner.approveStep(id, 1, { note: 'Fine.' });
        });
        // The store shows the rejection's note beside the approval.
        world.sqlite
          .prepare(
            'UPDATE plan_step SET note = (SELECT note FROM plan_step WHERE plan_id = ? AND position = 0) WHERE plan_id = ? AND position = 1',
          )
          .run(id, id);

        const waited = yield* wait(world, laptop, id);
        expect(waited.lines[0]).toMatchObject({ note: 'Not this one.' });
        expect(waited.lines[1]).not.toHaveProperty('note');
        expect(waited.lines[1].noteError).toContain('could not be verified');
        expect(waited.stdout).not.toContain('Fine.');
      }),
    );

    it.effect('hands out nothing the store says the owner approved that they did not', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app'));
        const real = yield* askApproved(world, owner, laptop, 'acme/app');
        const received = `${yield* tempDirectory}/received key`;
        const id = yield* asked(world, laptop, {
          steps: [
            { type: 'access', read: ['acme/app'], command: ['sh', '-c', 'cat > "$0"', received] },
            { type: 'access', read: ['acme/app'] },
          ],
        });
        const keyIds = (yield* Effect.promise(() => owner.plan(id))).steps.map(
          step => step.key?.id ?? '',
        );
        // The store marks both approved without the owner: one holds nothing, the other a copy
        // of the real key's grant, whose proof and wrap were made for another key.
        world.sqlite
          .prepare(`UPDATE plan_step SET status = 'approved', resolved_at = 1 WHERE plan_id = ?`)
          .run(id);
        world.sqlite
          .prepare(
            `INSERT INTO environment_grant
             (environment_id, credential_id, read_wrap, key_proof, key_version, created_at)
           SELECT environment_id, ?, read_wrap, key_proof, key_version, created_at
           FROM environment_grant WHERE credential_id = ?`,
          )
          .run(keyIds[1] ?? '', real.id);

        const refused = yield* wait(world, laptop, id);
        expect(refused.exitCode).toBe(8);
        for (const line of refused.lines) {
          expect(line.error.message).toContain('holds no read the owner gave it');
        }
        expect(yield* fs.exists(received)).toBe(false);
        for (const keyId of keyIds) {
          expect(yield* fs.exists(`${keysOf(laptop)}/${keyId}`)).toBe(true);
        }
      }),
    );

    it.effect('refuses an answer about another plan, or with other steps, touching no file', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app'));
        const waiting = yield* asked(world, laptop, reading('acme/app'));
        const other = yield* asked(world, laptop, reading('acme/app'));
        const answeringWith = (rewrite: (url: string) => string): TestWorld => ({
          ...world,
          fetch: (input, init) => {
            const request = new Request(input, init);
            return world.fetch(new Request(rewrite(request.url), request));
          },
        });
        // About another plan.
        const swapped = answeringWith(url => url.replace(`/plans/${waiting}`, `/plans/${other}`));
        expect(yield* wait(swapped, laptop, waiting)).toMatchObject({ exitCode: 8, stdout: '' });
        expect((yield* run(swapped, laptop, ['ask', 'cancel', waiting])).exitCode).toBe(8);
        // The same plan, with a step whose key is another's.
        const forged: TestWorld = {
          ...world,
          fetch: async (input, init) => {
            const response = await world.fetch(new Request(input, init));
            const text = await response.text();
            const body = JSON.parse(text, (key, value) =>
              key === 'key' && typeof value === 'object' && value !== null
                ? { ...value, id: crypto.randomUUID() }
                : value,
            );
            return new Response(JSON.stringify(body), {
              status: response.status,
              headers: { 'content-type': 'application/json' },
            });
          },
        };
        expect((yield* wait(forged, laptop, waiting)).exitCode).toBe(8);

        const keyId = (yield* Effect.promise(() => owner.plan(waiting))).steps[0]?.key?.id ?? '';
        expect(yield* fs.exists(`${keysOf(laptop)}/${keyId}`)).toBe(true);
        expect((yield* Effect.promise(() => owner.plan(waiting))).steps[0]?.status).toBe('pending');
      }),
    );

    it.effect('revokes the key when the command that takes it fails', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app'));
        const id = yield* asked(world, laptop, {
          steps: [{ type: 'access', read: ['acme/app'], command: ['sh', '-c', 'exit 3'] }],
        });
        yield* Effect.promise(() => owner.approveStep(id, 0));

        const failed = yield* wait(world, laptop, id);

        expect(failed.exitCode).toBe(2);
        expect(failed.error.message).toContain('revoked');
        expect((yield* run(world, laptop, ['key', 'list'])).json.keys).toHaveLength(1);
      }),
    );

    it.effect(
      'keeps what a plan needs when the store’s answer is lost, and removes it when the store refuses',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { world, owner, laptop } = yield* paired;
          yield* Effect.promise(() => owner.createEnvironment('acme/app'));
          const creating = (answer: (made: Response) => Response): TestWorld => ({
            ...world,
            fetch: async (input, init) => {
              const request = new Request(input, init);
              const isCreate =
                request.method === 'POST' && new URL(request.url).pathname === '/api/v1/plans';
              return isCreate ? answer(await world.fetch(request)) : world.fetch(request);
            },
          });

          // The store made the plan, and its answer never arrived.
          const lost = yield* ask(
            creating(() => {
              throw new TypeError('fetch failed');
            }),
            laptop,
            reading('acme/app'),
          );
          expect(lost.exitCode).toBe(7);
          expect(lost.error.message).toContain('may have been made');
          const id = /Plan ([0-9a-f-]{36})/.exec(lost.error.message)?.[1] ?? '';
          expect(lost.error.message).toContain(`baymutt ask wait ${id}`);
          yield* Effect.promise(() => owner.approveStep(id, 0));
          expect((yield* wait(world, laptop, id)).lines[0]).toMatchObject({ status: 'approved' });

          // The store said no in its own words: there is no plan, so nothing is kept for one.
          const before = yield* fs.readDirectory(keysOf(laptop));
          const refused = yield* ask(
            creating(
              () =>
                new Response(
                  JSON.stringify({
                    code: 'LimitReachedError',
                    message: 'Up to 20 plans wait for the owner in one org at once.',
                    limit: 20,
                  }),
                  { status: 403, headers: { 'content-type': 'application/json' } },
                ),
            ),
            laptop,
            reading('acme/app'),
          );
          expect(refused.exitCode).toBe(6);
          expect(yield* fs.readDirectory(keysOf(laptop))).toEqual(before);

          // Lost on its way, and never made: a wait says so and removes what was kept.
          const never = yield* ask(
            {
              ...world,
              fetch: (input, init) => {
                const request = new Request(input, init);
                return request.method === 'POST' &&
                  new URL(request.url).pathname === '/api/v1/plans'
                  ? Promise.reject(new TypeError('fetch failed'))
                  : world.fetch(request);
              },
            },
            laptop,
            reading('acme/app'),
          );
          const neverId = /Plan ([0-9a-f-]{36})/.exec(never.error.message)?.[1] ?? '';
          const gone = yield* wait(world, laptop, neverId);
          expect(gone.exitCode).toBe(5);
          expect(gone.error.message).toContain('never reached the store');
          expect(yield* fs.readDirectory(keysOf(laptop))).toEqual(before);
        }),
    );

    it.effect('removes key files the store no longer lists, and keeps a waiting one', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app'));
        const keyOf = Effect.fnUntraced(function* (id: string) {
          return (yield* Effect.promise(() => owner.plan(id))).steps[0]?.key?.id ?? '';
        });
        const waiting = yield* keyOf(yield* asked(world, laptop, reading('acme/app')));
        const revoked = yield* askApproved(world, owner, laptop, 'acme/app');
        yield* run(world, laptop, ['key', 'revoke', revoked.id]);
        const stray = crypto.randomUUID();
        yield* fs.writeFileString(`${keysOf(laptop)}/${stray}`, 'baymutt_key_stray\n');
        // A file this young may be an ask in another terminal that has not sent its plan yet.
        yield* asked(world, laptop, reading('acme/app'));
        expect(yield* fs.exists(`${keysOf(laptop)}/${stray}`)).toBe(true);

        yield* TestClock.setTime(Date.now() + 3600 * 1000);
        yield* asked(world, laptop, reading('acme/app'));

        expect(yield* fs.exists(`${keysOf(laptop)}/${waiting}`)).toBe(true);
        expect(yield* fs.exists(`${keysOf(laptop)}/${revoked.id}`)).toBe(false);
        expect(yield* fs.exists(`${keysOf(laptop)}/${stray}`)).toBe(false);
      }),
    );
  });

  describe('a change step', () => {
    it.effect('that only gives back takes effect at once, and wait checks the key', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(async () => {
          await owner.createEnvironment('acme/app/production');
          await owner.createEnvironment('acme/app/staging');
        });
        const held = yield* askApproved(
          world,
          owner,
          laptop,
          'acme/app/production',
          'acme/app/staging',
        );
        const sent = yield* ask(world, laptop, {
          steps: [{ type: 'change', key: held.id, giveBack: ['acme/app/staging'] }],
        });
        expect(sent.json).toMatchObject({
          status: 'answered',
          steps: [{ index: 0, type: 'change', status: 'applied' }],
          next: expect.stringContaining('Nothing waits for the owner'),
        });
        expect(yield* isRefused(load(world, held.agent, 'acme/app/staging'))).toBe(true);
        const checked = yield* wait(world, laptop, sent.json.id);
        expect(checked).toMatchObject({
          exitCode: 0,
          lines: [{ status: 'applied', key: held.id, environments: ['acme/app/production'] }],
        });
      }),
    );

    it.effect(
      'to a service account says what it could not check, and stays in the key’s own org',
      () =>
        Effect.gen(function* () {
          const { world, owner, laptop } = yield* paired;
          yield* Effect.promise(async () => {
            await owner.createEnvironment('acme/app/production');
            await owner.createEnvironment('acme/app/staging');
            await owner.createOrg('globex');
            await owner.createEnvironment('globex/app');
          });
          const piped = yield* asked(world, laptop, {
            steps: [{ type: 'access', read: ['acme/app/production'], command: ['true'] }],
          });
          yield* Effect.promise(() => owner.approveStep(piped, 0));
          const handed = yield* wait(world, laptop, piped);
          const serviceAccount: string = handed.lines[0].key;

          const id = yield* asked(world, laptop, {
            steps: [{ type: 'change', key: serviceAccount, read: ['acme/app/staging'] }],
          });
          yield* Effect.promise(() => owner.approveStep(id, 0));
          const changed = yield* wait(world, laptop, id);
          expect(changed.exitCode).toBe(0);
          expect(changed.lines[0]).toMatchObject({
            status: 'approved',
            key: serviceAccount,
            environments: expect.arrayContaining(['acme/app/production', 'acme/app/staging']),
            unchecked: expect.stringContaining('No file of this key is on this computer'),
          });

          // A key holds environments of its own org only.
          const outside = yield* ask(world, laptop, {
            steps: [{ type: 'change', key: serviceAccount, read: ['globex/app'] }],
          });
          expect(outside.exitCode).toBe(2);
          expect(outside.error.message).toContain('steps[0]');
          expect(outside.error.message).toContain('acme');
        }),
    );
    it.effect('that asks only for a new end is in the org of its key', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(async () => {
          await owner.createEnvironment('acme/app');
          await owner.createOrg('globex');
          await owner.createEnvironment('globex/app');
        });
        const held = yield* askApproved(world, owner, laptop, 'acme/app');
        const before = (yield* Effect.promise(() => owner.plan(held.plan))).steps[0]?.key
          ?.expiresAt;

        const id = yield* asked(world, laptop, {
          steps: [{ type: 'change', key: held.id, expires: '1d' }],
        });
        expect((yield* Effect.promise(() => owner.plan(id))).org.slug).toBe('acme');
        const end = Date.now() + 24 * 3600 * 1000;
        yield* Effect.promise(() => owner.approveStep(id, 0, { expiresAt: end }));
        const changed = yield* wait(world, laptop, id);
        expect(changed).toMatchObject({
          exitCode: 0,
          lines: [
            {
              index: 0,
              type: 'change',
              status: 'approved',
              key: held.id,
              keyFile: held.agent.env?.BAYMUTT_KEY_FILE,
              expiresAt: end,
              environments: ['acme/app'],
            },
          ],
        });
        expect(end).not.toBe(before);

        // A key this login did not ask for, keys of two orgs, and a change that asks for nothing.
        const unknown = yield* ask(world, laptop, {
          steps: [{ type: 'change', key: crypto.randomUUID(), expires: '1d' }],
        });
        expect(unknown.exitCode).toBe(5);
        expect(unknown.error.message).toContain(
          'steps[0].key: no key this CLI login asked for has the id',
        );
        const globex = yield* askApproved(world, owner, laptop, 'globex/app');
        const across = yield* ask(world, laptop, {
          steps: [
            { type: 'change', key: held.id, expires: '1d' },
            { type: 'change', key: globex.id, expires: '1d' },
          ],
        });
        expect(across.exitCode).toBe(2);
        expect(across.error.message).toContain(
          'steps[1].key: a plan asks in one org, and this one changes keys of acme and globex',
        );
        const nothing = yield* ask(world, laptop, { steps: [{ type: 'change', key: held.id }] });
        expect(nothing.exitCode).toBe(2);
        expect(nothing.error.message).toContain('steps[0]: a `change` step asks for something');
        expect(
          world.sqlite
            .prepare('SELECT COUNT(*) AS n FROM plan WHERE id NOT IN (?, ?, ?)')
            .get(id, held.plan, globex.plan),
        ).toEqual({ n: 0 });
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
          await owner.set('acme/app/production', 'API_KEY', 'second');
          await owner.set('acme/app/production', 'OLD_KEY', 'old');
          await owner.deleteSecret('acme/app/production', 'OLD_KEY');
        });
        const { id, agent } = yield* askApproved(world, owner, laptop, 'acme/app/production');
        expect(yield* load(world, agent, 'acme/app/production')).toEqual({ API_KEY: 'second' });

        expect((yield* run(world, laptop, ['bin', 'list'])).json).toMatchObject({
          environments: [],
          secrets: [{ environmentName: 'app/production', name: 'OLD_KEY', latestVersion: 1 }],
        });
        expect(
          (yield* run(world, agent, ['secret', 'history', 'acme/app/production', 'API_KEY'])).json,
        ).toMatchObject({
          environment: 'acme/app/production',
          name: 'API_KEY',
          versions: [
            { version: 2, isCurrent: true },
            { version: 1, isCurrent: false },
          ],
        });
        const activity = (yield* run(world, agent, ['activity', 'list'])).json.events as {
          action: string;
          environmentName: string | null;
        }[];
        expect(activity).toContainEqual(
          expect.objectContaining({
            action: 'environment.load',
            environmentName: 'app/production',
          }),
        );
        const { keys } = (yield* run(world, laptop, ['key', 'list'])).json;
        expect(keys).toMatchObject(
          expect.arrayContaining([
            expect.objectContaining({ id: loginId, kind: 'cli-login', org: null, grants: [] }),
            expect.objectContaining({
              id,
              kind: 'agent-key',
              org: 'acme',
              parentId: loginId,
              grants: [expect.objectContaining({ environmentName: 'app/production' })],
            }),
          ]),
        );
        expect((yield* run(world, agent, ['auth', 'whoami'])).json.key).toMatchObject({
          id,
          grants: [{ environmentName: 'app/production' }],
        });
      }),
    );

    it.effect('in another org open with that org’s names key', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(async () => {
          await owner.createOrg('globex');
          await owner.createEnvironment('globex/app/production');
          await owner.set('globex/app/production', 'API_KEY', 'globex value');
          await owner.createEnvironment('acme/app/production');
        });
        expect(
          (yield* run(world, laptop, ['env', 'list'])).json.environments.map(
            ({ address }: { address: string }) => address,
          ),
        ).toEqual(expect.arrayContaining(['acme/app/production', 'globex/app/production']));
        const { id: globexKey, agent } = yield* askApproved(
          world,
          owner,
          laptop,
          'globex/app/production',
        );
        expect(
          (yield* run(world, laptop, ['key', 'list'])).json.keys.find(
            ({ id }: { id: string }) => id === globexKey,
          ),
        ).toMatchObject({ org: 'globex' });
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
        const { agent } = yield* askApproved(world, owner, laptop, 'acme/app/production');
        yield* Effect.promise(() => owner.unseal('acme'));

        expect(yield* load(world, agent, 'acme/app/production')).toEqual({
          API_KEY: 'for the deploy',
        });
        expect(
          (yield* run(world, laptop, ['secret', 'list', 'acme/app/production'])).json.secrets,
        ).toMatchObject([{ name: 'API_KEY' }]);
        // A plan waits for the owner to seal the org.
        const asking = yield* ask(world, laptop, reading('acme/app/production'));
        expect(asking.exitCode).toBe(6);
        expect(asking.error.message).toContain('not sealed yet');

        // The deploy loads with the new plugin from the store it replaces: no sealed name, no names
        // key, and only the routes that store has.
        const lastRelease = hidingSealing(world, undefined);
        expect(yield* load(lastRelease.store, agent, 'acme/app/production')).toEqual({
          API_KEY: 'for the deploy',
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
        const { agent } = yield* askApproved(world, owner, laptop, 'acme/app/production');
        // The org is sealed; the store strips every sealed name and names key, so it looks unsealed.
        const { store, urls } = hidingSealing(world, null);

        const history = yield* run(store, agent, [
          'secret',
          'history',
          environmentId,
          'SECRET_VENDOR_TOKEN',
        ]);
        expect(history.exitCode).toBe(5);
        expect(history.error.message).toContain('no secret SECRET_VENDOR_TOKEN');
        const asking = yield* ask(store, laptop, {
          steps: [
            {
              type: 'secrets',
              items: [
                {
                  op: 'rollback',
                  environment: 'acme/app/production',
                  name: 'SECRET_VENDOR_TOKEN',
                  version: 1,
                },
              ],
            },
          ],
        });
        expect(asking.exitCode).toBe(6);

        expect(urls.length).toBeGreaterThan(0);
        expect(urls.filter(url => url.includes('SECRET_VENDOR_TOKEN'))).toEqual([]);
      }),
    );
  });

  describe('values', () => {
    it.effect('are refused when the store swaps the environment’s key or a value’s slot', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(async () => {
          await owner.createEnvironment('acme/app/production');
          await owner.set('acme/app/production', 'PUBLIC_URL', 'https://example.com');
          await owner.set('acme/app/production', 'API_KEY', 'the secret');
        });
        const { agent } = yield* askApproved(world, owner, laptop, 'acme/app/production');
        expect(yield* load(world, agent, 'acme/app/production')).toEqual({
          PUBLIC_URL: 'https://example.com',
          API_KEY: 'the secret',
        });

        // The store answers one name with the other's ciphertext.
        const original = world.sqlite.prepare('SELECT rowid, ciphertext FROM secret_version').all();
        world.sqlite.exec(
          'UPDATE secret_version SET ciphertext = (SELECT ciphertext FROM secret_version ORDER BY rowid LIMIT 1)',
        );
        expect(yield* isRefused(load(world, agent, 'acme/app/production'))).toBe(true);
        for (const row of original as { rowid: number; ciphertext: string }[]) {
          world.sqlite
            .prepare('UPDATE secret_version SET ciphertext = ? WHERE rowid = ?')
            .run(row.ciphertext, row.rowid);
        }

        // A store that shows a whole environment of its own: key and wrap.
        const environmentId = owner.environmentAt('acme/app/production').id;
        const forged = yield* Effect.promise(() => generateEnvironmentKey());
        world.sqlite.prepare('UPDATE environment SET public_key = ?').run(forged.publicKey);
        expect(yield* isRefused(load(world, agent, 'acme/app/production'))).toBe(true);
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

    it.effect('logout revokes this login and the keys its plans made, and forgets their keys', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, owner, laptop, loginId } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
        const { agent } = yield* askApproved(world, owner, laptop, 'acme/app/production');
        const ci: Seat = { configHome: laptop.configHome, env: { BAYMUTT_KEY: 'unused' } };
        const keys = `${laptop.configHome}/baymutt/localhost-5183/keys`;

        // A service account's key file, or one that is not there, logs nothing out.
        const asAgent = yield* run(world, agent, ['auth', 'logout']);
        expect(asAgent.exitCode).toBe(2);
        expect(asAgent.error.message).toContain('baymutt key revoke');
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
        // The keys its plans made are gone from here too.
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

    it.effect('a key from a plan stops when it expires, with its own error', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* Effect.promise(() => owner.createEnvironment('acme/app/production'));
        const { id, agent } = yield* askApproved(world, owner, laptop, 'acme/app/production');
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
