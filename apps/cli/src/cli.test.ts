// The CLI against the real Worker app, in process: its own key handling and the real key
// schedule on both sides, with the owner's browser played by `@baymutt/keys` and the API.
import { type PairingRequest, PairingRequestSchema } from '@baymutt/api';
import {
  approvePairing,
  createAccountKey,
  createVault,
  derivePasskeyEncKey,
  generateProjectKey,
  generateRecoveryKey,
  grantToServiceAccount,
  type OwnerKeys,
  openAccountKey,
  openOwnedProject,
  recoveryVaultKey,
  rewrapDek,
  sealValue,
  tokenHash,
  vaultProof,
  wrapProjectKey,
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
import * as TestConsole from 'effect/testing/TestConsole';
import { CliLayer, cli } from './app.ts';
import { Reported } from './errors.ts';
import { KeyStore, Platform } from './key-store.ts';
import { loadValues } from './projects.ts';
import { ServiceAccount } from './service-account.ts';
import { Settings } from './settings.ts';

/** A service account: its own config home, so its own key and state. */
type Seat = { readonly configHome: string; readonly env?: Record<string, string> };

const withSeat = <A, E, R>(world: TestWorld, seat: Seat, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, world.fetch as typeof fetch)),
      ),
    ),
    // The file store, on any service account the tests run on: never the developer's keychain.
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
      return {
        exitCode,
        stdout,
        stderr, // Help text, which the parser prints for bad usage, is not a result.
        json: /^[{[]/.test(stdout) ? JSON.parse(stdout) : undefined,
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

/** What this service account loads, through the same flow the varlock plugin uses. */
const load = (world: TestWorld, seat: Seat, project: string) =>
  withSeat(
    world,
    seat,
    Effect.map(loadValues(project), ({ values }) => values).pipe(
      Effect.provide(
        ServiceAccount.layer.pipe(
          Layer.provideMerge(KeyStore.layer),
          Layer.provideMerge(Settings.layer),
        ),
      ),
    ),
  );

const seat = Effect.map(
  Effect.flatMap(FileSystem.FileSystem, fs => fs.makeTempDirectoryScoped()),
  (configHome): Seat => ({ configHome }),
);

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
    name: 'Jason',
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

  type ProjectRow = { id: string; name: string; publicKey: string; keyVersion: number };
  /** The project as the vault proves it, with what the store listed beside it. */
  const projectByName = async (name: string) => {
    const { projects } = await api<{ projects: ProjectRow[] }>('GET', '/projects');
    const project = projects.find(candidate => candidate.name === name);
    if (project === undefined) throw new Error(`no project ${name}`);
    const { ownerWrap, ownerProof, keyVersion, creator } = await api<{
      ownerWrap: string;
      ownerProof: string;
      keyVersion: number;
      creator: { id: string; publicKey: string; endorsement: string | null } | null;
    }>('GET', `/projects/${project.id}/owner-wrap`);
    const owned = { accountId, projectId: project.id, keyVersion, ownerWrap, ownerProof, creator };
    return { ...project, owned, opened: await openOwnedProject(keys, owned) };
  };

  return {
    accountId,
    api,
    /** Approves the link `baymutt login` printed, as the pairing page does. */
    approve: async (url: string) => {
      const request: PairingRequest = Schema.decodeUnknownSync(
        Schema.fromJsonString(PairingRequestSchema),
      )(decodeURIComponent(new URL(url).hash.slice(1)));
      const { pairingSecret, ...serviceAccount } = request;
      await api('POST', '/credentials/pair', {
        ...serviceAccount,
        ...(await approvePairing(keys, { ...serviceAccount, pairingSecret })),
      });
      return serviceAccount.id;
    },
    /** Approves every pending access request, wrapping the project key to the service account that asked. */
    approveAccess: async () => {
      const { requests } = await api<{
        requests: {
          id: string;
          projectName: string;
          credentialId: string;
          credentialPublicKey: string;
          endorsement: string | null;
          wantsRead: boolean;
          wantsWrite: boolean;
        }[];
      }>('GET', '/access-requests');
      for (const request of requests) {
        const project = await projectByName(request.projectName);
        await api('POST', `/access-requests/${request.id}/approve`, {
          canWrite: request.wantsWrite,
          keyVersion: project.keyVersion,
          ...(await grantToServiceAccount(
            keys,
            project.owned,
            {
              id: request.credentialId,
              publicKey: request.credentialPublicKey,
              endorsement: request.endorsement,
            },
            { canRead: request.wantsRead },
          )),
        });
      }
    },
    projectByName,
  };
};

/** A world with an owner and one paired service account. */
const paired = Effect.gen(function* () {
  const world = testWorld();
  const owner = yield* Effect.promise(() => makeOwner(world));
  const laptop = yield* seat;
  const pending = yield* run(world, laptop, ['login', '--name', 'laptop', '--wait', '0']);
  const serviceAccountId = yield* Effect.promise(() => owner.approve(pending.json.url));
  const done = yield* run(world, laptop, ['login', '--wait', '0']);
  return { world, owner, laptop, serviceAccountId, pending, done };
});

const PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nline three\n-----END PRIVATE KEY-----';

layer(NodeServices.layer)(it => {
  describe('pairing', () => {
    it.effect(
      'prints a link and a code, waits for the owner, then pins the account the browser named',
      () =>
        Effect.gen(function* () {
          const { owner, serviceAccountId, pending, done, world, laptop } = yield* paired;

          expect(pending).toMatchObject({
            exitCode: 0,
            json: {
              status: 'pending',
              serviceAccountId,
              code: expect.stringMatching(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/),
            },
          });
          expect(pending.stderr).toContain(pending.json.code);
          expect(done).toMatchObject({
            exitCode: 0,
            json: {
              status: 'loggedIn',
              serviceAccountId,
              account: { id: owner.accountId, name: 'Jason' },
            },
          });
          // A new service account holds nothing.
          expect((yield* run(world, laptop, ['projects', 'list'])).json).toEqual({ projects: [] });
        }),
    );

    it.effect('refuses a welcome the owner’s browser did not seal for this pairing', () =>
      Effect.gen(function* () {
        const world = testWorld();
        const owner = yield* Effect.promise(() => makeOwner(world));
        const laptop = yield* seat;
        const pending = yield* run(world, laptop, ['login', '--wait', '0']);
        yield* Effect.promise(() => owner.approve(pending.json.url));
        // The store answers with a welcome of its own making.
        world.sqlite.exec(
          "UPDATE credential SET welcome = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'",
        );

        const done = yield* run(world, laptop, ['login', '--wait', '0']);

        expect(done.exitCode).toBe(8);
        expect(JSON.parse(done.stderr)).toMatchObject({ error: { code: 'IntegrityError' } });
        expect((yield* run(world, laptop, ['projects', 'create', 'app/dev'])).exitCode).toBe(3);
      }),
    );

    it.effect('says a service account with no key is not paired, with exit code 3', () =>
      Effect.gen(function* () {
        const result = yield* run(testWorld(), yield* seat, ['whoami']);

        expect(result.exitCode).toBe(3);
        expect(JSON.parse(result.stderr)).toMatchObject({
          error: { code: 'UsageError', exitCode: 3 },
        });
        expect(result.stdout).toBe('');
      }),
    );
  });

  describe('values', () => {
    it.effect('are sealed here, stored as ciphertext, and opened by this service account', () =>
      Effect.gen(function* () {
        const { world, laptop } = yield* paired;
        yield* run(world, laptop, ['projects', 'create', 'app/production']);

        const set = yield* run(
          world,
          laptop,
          ['set', 'app/production', 'SIGNING_KEY'],
          `${PRIVATE_KEY}\n`,
        );
        const generated = yield* run(world, laptop, [
          'generate',
          'app/production',
          'SESSION_SECRET',
        ]);

        expect(set).toMatchObject({
          exitCode: 0,
          json: {
            project: 'app/production',
            name: 'SIGNING_KEY',
            version: 1,
            length: PRIVATE_KEY.length,
          },
        });
        expect(generated.json).toMatchObject({ name: 'SESSION_SECRET', version: 1, length: 43 });

        const loaded = yield* load(world, laptop, 'app/production');
        expect(loaded.SIGNING_KEY).toBe(PRIVATE_KEY);
        expect(loaded.SESSION_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);

        // No command printed a value, and the store holds none.
        for (const output of [set.stdout, set.stderr, generated.stdout, generated.stderr]) {
          expect(output).not.toContain('MIIEvQIBADANBg');
          expect(output).not.toContain(loaded.SESSION_SECRET);
        }
        const stored = JSON.stringify(
          world.sqlite
            .prepare('SELECT * FROM secret_version')
            .all()
            .concat(
              world.sqlite.prepare('SELECT * FROM project').all(),
              world.sqlite.prepare('SELECT * FROM audit_event').all(),
            ),
        );
        expect(stored).not.toContain('MIIEvQIBADANBg');
        expect(stored).not.toContain(loaded.SESSION_SECRET);
      }),
    );

    it.effect('take a new version on each set, and come back with rollback after a delete', () =>
      Effect.gen(function* () {
        const { world, laptop } = yield* paired;
        yield* run(world, laptop, ['projects', 'create', 'app/dev']);
        yield* run(world, laptop, ['set', 'app/dev', 'API_KEY'], 'first');
        const second = yield* run(world, laptop, ['set', 'app/dev', 'API_KEY'], 'second');

        expect(second.json).toMatchObject({ version: 2, length: 6 });
        expect((yield* load(world, laptop, 'app/dev')).API_KEY).toBe('second');

        expect((yield* run(world, laptop, ['delete', 'app/dev', 'API_KEY'])).json).toMatchObject({
          currentVersion: null,
          latestVersion: 2,
        });
        expect(yield* load(world, laptop, 'app/dev')).toEqual({});

        yield* run(world, laptop, ['rollback', 'app/dev', 'API_KEY', '--to', '1']);
        expect((yield* load(world, laptop, 'app/dev')).API_KEY).toBe('first');
        expect(
          (yield* run(world, laptop, ['history', 'app/dev', 'API_KEY'])).json.versions,
        ).toMatchObject([
          { version: 2, isCurrent: false },
          { version: 1, isCurrent: true },
        ]);
      }),
    );

    it.effect('come from stdin only, and a name must be an environment variable’s', () =>
      Effect.gen(function* () {
        const { world, laptop } = yield* paired;
        yield* run(world, laptop, ['projects', 'create', 'app/dev']);

        const noStdin = yield* run(world, laptop, ['set', 'app/dev', 'API_KEY']);
        const empty = yield* run(world, laptop, ['set', 'app/dev', 'API_KEY'], '');
        const missing = yield* run(world, laptop, ['set', 'app/nope', 'API_KEY'], 'x');

        expect(noStdin.exitCode).toBe(2);
        expect(JSON.parse(noStdin.stderr).error.message).toContain('stdin');
        expect(empty.exitCode).toBe(2);
        expect(missing.exitCode).toBe(5);
        expect(
          (yield* run(world, laptop, ['set', 'app/dev', 'not-a-name'], 'x')).exitCode,
        ).not.toBe(0);
      }),
    );

    it.effect('keep a trailing newline only when asked to', () =>
      Effect.gen(function* () {
        const { world, laptop } = yield* paired;
        yield* run(world, laptop, ['projects', 'create', 'app/dev']);
        yield* run(world, laptop, ['set', 'app/dev', 'TRIMMED'], 'value\n');
        yield* run(world, laptop, ['set', 'app/dev', 'KEPT', '--keep-newline'], 'value\n');

        expect(yield* load(world, laptop, 'app/dev')).toEqual({
          TRIMMED: 'value',
          KEPT: 'value\n',
        });
      }),
    );
  });

  describe('access', () => {
    it.effect(
      'is asked for, and a read works once the owner wraps the project key to this service account',
      () =>
        Effect.gen(function* () {
          const { world, owner, laptop } = yield* paired;
          yield* run(world, laptop, ['projects', 'create', 'app/production']);
          yield* run(world, laptop, ['set', 'app/production', 'API_KEY'], 'the value');
          const agent = yield* seat;
          const pending = yield* run(world, agent, ['login', '--name', 'agent', '--wait', '0']);
          yield* Effect.promise(() => owner.approve(pending.json.url));
          yield* run(world, agent, ['login', '--wait', '0']);

          expect((yield* run(world, agent, ['secrets', 'app/production'])).exitCode).toBe(5);
          const asked = yield* run(world, agent, [
            'access',
            'request',
            'app/production',
            '--read',
            '--reason',
            'to deploy',
          ]);
          expect(asked.json).toMatchObject({
            status: 'pending',
            wantsRead: true,
            wantsWrite: false,
          });

          yield* Effect.promise(() => owner.approveAccess());

          expect(yield* load(world, agent, 'app/production')).toEqual({ API_KEY: 'the value' });
          // Read was all it asked for.
          const write = yield* run(world, agent, ['set', 'app/production', 'API_KEY'], 'changed');
          expect(write.exitCode).toBe(4);
          expect(JSON.parse(write.stderr).error).toMatchObject({ code: 'NoAccessError' });
        }),
    );

    it.effect('to write alone seals values this service account can never load', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* run(world, laptop, ['projects', 'create', 'app/production']);
        const writer = yield* seat;
        const pending = yield* run(world, writer, ['login', '--name', 'writer', '--wait', '0']);
        yield* Effect.promise(() => owner.approve(pending.json.url));
        yield* run(world, writer, ['login', '--wait', '0']);
        yield* run(world, writer, [
          'access',
          'request',
          'app/production',
          '--write',
          '--reason',
          'rotation',
        ]);
        yield* Effect.promise(() => owner.approveAccess());

        expect(
          (yield* run(world, writer, ['set', 'app/production', 'API_KEY'], 'written blind')).json,
        ).toMatchObject({ version: 1 });
        expect(Exit.isFailure(yield* Effect.exit(load(world, writer, 'app/production')))).toBe(
          true,
        );
        expect((yield* load(world, laptop, 'app/production')).API_KEY).toBe('written blind');
      }),
    );

    it.effect('refuses to seal to a project key the store swapped for its own', () =>
      Effect.gen(function* () {
        const { world, laptop } = yield* paired;
        yield* run(world, laptop, ['projects', 'create', 'app/production']);
        yield* run(world, laptop, ['set', 'app/production', 'API_KEY'], 'first');
        // A store that wants to read the next value shows a public key of its own.
        world.sqlite.exec(
          "UPDATE project SET public_key = 'hSDwCYkwp1R0i33ctD73Wg2_Og0mOBr066SpjqqbTmo'",
        );

        const swapped = yield* run(world, laptop, ['set', 'app/production', 'API_KEY'], 'second');

        expect(swapped.exitCode).toBe(8);
        expect(
          world.sqlite.prepare('SELECT COUNT(*) AS versions FROM secret_version').get(),
        ).toEqual({
          versions: 1,
        });
      }),
    );

    it.effect('is not fooled by a store that forges the whole project: key, wrap and all', () =>
      Effect.gen(function* () {
        const { world, owner, laptop, serviceAccountId } = yield* paired;
        yield* run(world, laptop, ['projects', 'create', 'app/production']);
        const project = yield* Effect.promise(() => owner.projectByName('app/production'));
        const serviceAccountPublicKey = String(
          world.sqlite.prepare('SELECT public_key FROM credential').get()?.public_key,
        );
        // The store makes a key pair of its own and seals its private half to the service account, which
        // anyone can do. Only the proof it cannot make.
        const forged = yield* Effect.promise(async () => {
          const pair = await generateProjectKey();
          const wrap = await wrapProjectKey({
            projectPrivateKey: pair.privateKey,
            readerPublicKey: serviceAccountPublicKey,
            readerId: serviceAccountId,
            binding: { accountId: owner.accountId, projectId: project.id, keyVersion: 1 },
          });
          return { publicKey: pair.publicKey, wrap };
        });
        world.sqlite.prepare('UPDATE project SET public_key = ?').run(forged.publicKey);
        world.sqlite.prepare('UPDATE project_grant SET read_wrap = ?').run(forged.wrap);

        const write = yield* run(
          world,
          laptop,
          ['set', 'app/production', 'API_KEY'],
          'for the store',
        );
        const asked = yield* run(world, laptop, [
          'request',
          'app/production',
          'API_KEY',
          '--reason',
          'r',
          '--where',
          'w',
        ]);

        expect(write.exitCode).toBe(8);
        expect(asked.exitCode).toBe(8);
        expect(Exit.isFailure(yield* Effect.exit(load(world, laptop, 'app/production')))).toBe(
          true,
        );
        expect(
          world.sqlite.prepare('SELECT COUNT(*) AS versions FROM secret_version').get(),
        ).toEqual({
          versions: 0,
        });
      }),
    );

    it.effect('gives a CI service account, which keeps no state, the same refusal', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, laptop } = yield* paired;
        yield* run(world, laptop, ['projects', 'create', 'app/production']);
        const keyFile = `${yield* fs.makeTempDirectoryScoped()}/key`;
        yield* run(world, laptop, [
          'service-accounts',
          'create',
          '--name',
          'ci',
          '--write',
          'app/production',
          '--',
          'sh',
          '-c',
          `cat > ${keyFile}`,
        ]);
        const ci: Seat = {
          configHome: yield* fs.makeTempDirectoryScoped(),
          env: { BAYMUTT_KEY: yield* fs.readFileString(keyFile) },
        };

        expect(
          (yield* run(world, ci, ['set', 'app/production', 'API_KEY'], 'first')).exitCode,
        ).toBe(0);
        // On every run it meets the store afresh: a swapped key must fail the first time too.
        world.sqlite.exec(
          "UPDATE project SET public_key = 'hSDwCYkwp1R0i33ctD73Wg2_Og0mOBr066SpjqqbTmo'",
        );

        expect(
          (yield* run(world, ci, ['set', 'app/production', 'API_KEY'], 'second')).exitCode,
        ).toBe(8);
        expect(
          world.sqlite.prepare('SELECT COUNT(*) AS versions FROM secret_version').get(),
        ).toEqual({
          versions: 1,
        });
      }),
    );

    it.effect('refuses values the store put in a slot under another name', () =>
      Effect.gen(function* () {
        const { world, laptop } = yield* paired;
        yield* run(world, laptop, ['projects', 'create', 'app/production']);
        yield* run(world, laptop, ['set', 'app/production', 'PUBLIC_URL'], 'https://example.com');
        yield* run(world, laptop, ['set', 'app/production', 'API_KEY'], 'the secret');
        // The store answers API_KEY with PUBLIC_URL's ciphertext.
        world.sqlite.exec(
          "UPDATE secret_version SET ciphertext = (SELECT ciphertext FROM secret_version WHERE name = 'PUBLIC_URL') WHERE name = 'API_KEY'",
        );

        expect(Exit.isFailure(yield* Effect.exit(load(world, laptop, 'app/production')))).toBe(
          true,
        );
      }),
    );
  });

  describe('a narrower service account', () => {
    it.effect('gets its key on a command’s stdin, loads what it was handed, and nothing else', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, laptop } = yield* paired;
        yield* run(world, laptop, ['projects', 'create', 'app/production']);
        yield* run(world, laptop, ['projects', 'create', 'app/other']);
        yield* run(world, laptop, ['set', 'app/production', 'API_KEY'], 'for ci');
        const keyFile = `${yield* fs.makeTempDirectoryScoped()}/key`;

        const created = yield* run(world, laptop, [
          'service-accounts',
          'create',
          '--name',
          'ci',
          '--read',
          'app/production',
          '--',
          'sh',
          '-c',
          `cat > ${keyFile}`,
        ]);

        expect(created).toMatchObject({
          exitCode: 0,
          json: {
            name: 'ci',
            grants: [{ projectName: 'app/production', canRead: true, canWrite: false }],
          },
        });
        const key = yield* fs.readFileString(keyFile);
        expect(key).toMatch(/^baymutt_key_/);
        expect(created.stdout + created.stderr).not.toContain(key);

        // In CI the key is the environment's, and there is no state on disk.
        const ci: Seat = {
          configHome: yield* fs.makeTempDirectoryScoped(),
          env: { BAYMUTT_KEY: key },
        };
        expect(yield* load(world, ci, 'app/production')).toEqual({ API_KEY: 'for ci' });
        expect((yield* run(world, ci, ['projects', 'list'])).json.projects).toHaveLength(1);
        expect((yield* run(world, ci, ['set', 'app/production', 'API_KEY'], 'x')).exitCode).toBe(4);
        expect((yield* run(world, ci, ['projects', 'create', 'app/ci-made'])).exitCode).toBe(2);
      }),
    );

    it.effect('is revoked again when the command that takes its key fails', () =>
      Effect.gen(function* () {
        const { world, laptop } = yield* paired;
        yield* run(world, laptop, ['projects', 'create', 'app/production']);

        const created = yield* run(world, laptop, [
          'service-accounts',
          'create',
          '--name',
          'ci',
          '--write',
          'app/production',
          '--',
          'sh',
          '-c',
          'exit 3',
        ]);

        expect(created.exitCode).toBe(2);
        expect(JSON.parse(created.stderr).error.message).toContain('revoked');
        expect(
          (yield* run(world, laptop, ['service-accounts', 'list'])).json.credentials,
        ).toHaveLength(1);
      }),
    );
  });

  describe('check and request', () => {
    it.effect('check compares a schema with the project, and exits 9 when a name is missing', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { world, laptop } = yield* paired;
        yield* run(world, laptop, ['projects', 'create', 'app/dev']);
        yield* run(world, laptop, ['set', 'app/dev', 'API_KEY'], 'x');
        yield* run(world, laptop, ['set', 'app/dev', 'OLD_KEY'], 'x');
        const schema = `${yield* fs.makeTempDirectoryScoped()}/.env.schema`;
        yield* fs.writeFileString(
          schema,
          '# @defaultSensitive=true\n# ---\n# COMMENTED=\nAPI_KEY=\nSTRIPE_KEY=\nBAYMUTT_KEY=\nPORT=3000\n',
        );

        const differs = yield* run(world, laptop, [
          'check',
          'app/dev',
          '--schema',
          schema,
          '--ignore',
          'BAYMUTT_KEY',
          '--ignore',
          'PORT',
        ]);

        expect(differs.exitCode).toBe(9);
        expect(differs.json).toMatchObject({
          present: ['API_KEY'],
          missing: ['STRIPE_KEY'],
          unused: ['OLD_KEY'],
        });

        yield* run(world, laptop, ['set', 'app/dev', 'STRIPE_KEY'], 'x');
        expect(
          (yield* run(world, laptop, [
            'check',
            'app/dev',
            '--schema',
            schema,
            '--ignore',
            'BAYMUTT_KEY',
            '--ignore',
            'PORT',
          ])).exitCode,
        ).toBe(0);
      }),
    );

    it.effect('request prints a single-use link whose holder seals one value for one name', () =>
      Effect.gen(function* () {
        const { world, owner, laptop } = yield* paired;
        yield* run(world, laptop, ['projects', 'create', 'app/production']);

        const asked = yield* run(world, laptop, [
          'request',
          'app/production',
          'STRIPE_SECRET_KEY',
          '--reason',
          'to take payments',
          '--where',
          'Stripe dashboard, Developers, API keys',
        ]);
        const url = new URL(asked.json.url);
        const [token = '', fingerprint] = url.hash.slice(1).split('.');

        expect(asked.json).toMatchObject({ status: 'pending', name: 'STRIPE_SECRET_KEY' });
        expect(url.pathname).toBe(`/paste/${asked.json.id}`);

        // The paste page: fetch the target with the token, check the key, seal, post.
        const headers = { 'x-baymutt-paste-token': token, origin: ORIGIN };
        const target = (yield* Effect.promise(async () =>
          (
            await world.api(`/api/v1/paste/${asked.json.id}`, send('GET', undefined, headers))
          ).json(),
        )) as {
          projectPublicKey: string;
          keyVersion: number;
          nextVersion: number;
          accountId: string;
        };
        const project = yield* Effect.promise(() => owner.projectByName('app/production'));
        expect(fingerprint).toBeDefined();
        // Nobody has pasted yet: `wait` gives up at its timeout and says the request is open.
        expect(yield* run(world, laptop, ['wait', asked.json.id, '--timeout', '0'])).toMatchObject({
          exitCode: 9,
          json: { status: 'pending' },
        });
        const ciphertext = yield* Effect.promise(() =>
          sealValue({
            projectPublicKey: target.projectPublicKey,
            slot: {
              accountId: target.accountId,
              projectId: project.id,
              keyVersion: target.keyVersion,
              name: 'STRIPE_SECRET_KEY',
              version: target.nextVersion,
            },
            value: 'sk_live_pasted\nsecond line',
          }),
        );
        const fulfilled = yield* Effect.promise(() =>
          world.api(
            `/api/v1/paste/${asked.json.id}`,
            send(
              'POST',
              { version: target.nextVersion, keyVersion: target.keyVersion, ciphertext },
              headers,
            ),
          ),
        );

        expect(fulfilled.status).toBe(200);
        expect(yield* run(world, laptop, ['wait', asked.json.id])).toMatchObject({
          exitCode: 0,
          json: { id: asked.json.id, status: 'answered' },
        });
        expect((yield* load(world, laptop, 'app/production')).STRIPE_SECRET_KEY).toBe(
          'sk_live_pasted\nsecond line',
        );

        // A request made by mistake is withdrawn: nothing waits, and its link is spent.
        const mistaken = yield* run(world, laptop, [
          'request',
          'app/production',
          'NOT_NEEDED',
          '--reason',
          'asked by mistake',
          '--where',
          'nowhere',
        ]);
        const spent = new URL(mistaken.json.url).hash.slice(1).split('.')[0] ?? '';
        expect(yield* run(world, laptop, ['cancel', mistaken.json.id])).toMatchObject({
          exitCode: 0,
          json: { id: mistaken.json.id, status: 'cancelled' },
        });
        expect(yield* run(world, laptop, ['wait', mistaken.json.id])).toMatchObject({
          exitCode: 0,
        });
        const afterwards = yield* Effect.promise(() =>
          world.api(
            `/api/v1/paste/${mistaken.json.id}`,
            send('GET', undefined, { 'x-baymutt-paste-token': spent, origin: ORIGIN }),
          ),
        );
        expect(afterwards.status).toBe(410);
      }),
    );
  });
});
