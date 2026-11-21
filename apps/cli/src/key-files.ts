// The key an `access` step makes, on this computer, from `baymutt ask` to the owner's answer. The
// key is written to an owner-only file before the ask is sent, and leaves it when it is piped
// into the command it was asked for, refused, or no longer live at the store. The command, when
// there is one, waits in an owner-only file of its own beside the key, so asks running at once
// never share a file.
import { IdSchema } from '@baymutt/api';
import { unwrapEnvironmentKey, vouchedEnvironmentKey } from '@baymutt/keys';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import * as Semaphore from 'effect/Semaphore';
import * as Stream from 'effect/Stream';
import { listEnvironments } from './environments.ts';
import { crypto_, type UsageError, usage } from './errors.ts';
import { ServiceAccount, serviceAccountFromToken } from './service-account.ts';
import { Settings } from './settings.ts';

/** One key is handed out at a time: steps finished together would otherwise share a command's output. */
const handingOut = Semaphore.makeUnsafe(1);

/** A key file younger than this may belong to an `ask` in another terminal that has not sent its ask yet. */
const SETTLING_MS = 10 * 60 * 1000;

/** What a command file's name ends in: the rest is its key's id, the name of its key file. */
const COMMAND_SUFFIX = '.command';

export const isId = Schema.is(IdSchema);

/** Where a key is kept: only ever for an id, so no answer can name a path outside the keys directory. */
export const keyFileOf = Effect.fn('keyFiles.keyFile')(function* (id: string) {
  if (!isId(id)) return yield* usage(`${id} is not the id of a key.`);
  const path = yield* Path.Path;
  const { keysDirectory } = yield* Settings;
  return path.join(keysDirectory, id);
});

const commandFileOf = (id: string) => Effect.map(keyFileOf(id), file => `${file}${COMMAND_SUFFIX}`);

/** The command a key is piped into, as typed on this computer: never as the store tells it. */
const CommandFileSchema = Schema.fromJsonString(Schema.Array(Schema.String));

/** The command a key waits to be piped into, as typed here; None for a key kept in a file. */
const readCommand = Effect.fn('keyFiles.readCommand')(function* (id: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* commandFileOf(id);
  const text = yield* fs.readFileString(file).pipe(
    Effect.asSome,
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
    Effect.orDie,
  );
  if (Option.isNone(text)) return Option.none<ReadonlyArray<string>>();
  const command = yield* Schema.decodeEffect(CommandFileSchema)(text.value).pipe(
    Effect.catchTag('SchemaError', () =>
      Effect.fail(usage(`This file is not a command baymutt kept: ${file}. Fix or delete it.`)),
    ),
  );
  return Option.some(command);
});

/** Keeps a new key, and the command it is to be piped into, before the ask that asks for it is sent. */
export const keepKey = Effect.fn('keyFiles.keep')(function* ({
  id,
  token,
  command,
}: {
  readonly id: string;
  readonly token: Redacted.Redacted<string>;
  readonly command: ReadonlyArray<string> | null;
}) {
  const fs = yield* FileSystem.FileSystem;
  const { keysDirectory } = yield* Settings;
  yield* fs.makeDirectory(keysDirectory, { recursive: true, mode: 0o700 }).pipe(Effect.orDie);
  const file = yield* keyFileOf(id);
  // The command first: a key file with no command beside it is a key kept in a file.
  if (command !== null) {
    const text = yield* Schema.encodeEffect(CommandFileSchema)(command).pipe(Effect.orDie);
    yield* fs
      .writeFileString(yield* commandFileOf(id), `${text}\n`, { mode: 0o600 })
      .pipe(Effect.orDie);
  }
  yield* fs.writeFileString(file, `${Redacted.value(token)}\n`, { mode: 0o600 }).pipe(Effect.orDie);
  return file;
});

/** Forgets a key here: its file, and the command it waited to be piped into. */
export const forgetKey = Effect.fn('keyFiles.forget')(function* (id: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.forEach(
    [yield* keyFileOf(id), yield* commandFileOf(id)],
    file =>
      fs.remove(file).pipe(
        Effect.catchReason('PlatformError', 'NotFound', () => Effect.void),
        Effect.orDie,
      ),
    { discard: true },
  );
});

/** Forgets every key and ask kept here, for a logout: the store revoked them all. */
export const forgetAllKeys = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { keysDirectory } = yield* Settings;
  yield* fs.remove(keysDirectory, { recursive: true }).pipe(
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.void),
    Effect.orDie,
  );
});

/** Removes the files of keys the store no longer lists as live or waiting: rejected, revoked or expired. */
export const forgetDeadKeys = Effect.fn('keyFiles.forgetDead')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { keysDirectory } = yield* Settings;
  const { api } = yield* ServiceAccount;
  const files = yield* fs.readDirectory(keysDirectory).pipe(
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed([])),
    Effect.orDie,
  );
  if (files.length === 0) return;
  const now = yield* Clock.currentTimeMillis;
  // A key still waiting for the owner is an `access` step, not yet a listed credential. The asks
  // are read first and the credentials only after: a step approved between the two reads is then
  // pending in the first and live in the second. Read the other way round, or at once, it can be
  // in neither, and its only key file would be deleted.
  const { asks } = yield* api.asks.list({ query: {} });
  const { credentials } = yield* api.credentials.list();
  const live = new Set([
    ...credentials
      .filter(credential => credential.expiresAt === null || credential.expiresAt > now)
      .map(credential => credential.id),
    ...asks.flatMap(ask =>
      ask.steps.flatMap(step =>
        step.type === 'access' && step.status === 'pending' ? [step.key.id] : [],
      ),
    ),
  ]);
  yield* Effect.forEach(
    files,
    Effect.fnUntraced(function* (file) {
      const id = file.endsWith(COMMAND_SUFFIX) ? file.slice(0, -COMMAND_SUFFIX.length) : file;
      // Not a key file: an ask's record, or a file baymutt does not keep. Left alone.
      if (!isId(id) || live.has(id)) return;
      const info = yield* fs.stat(path.join(keysDirectory, file)).pipe(
        Effect.asSome,
        // Removed with its key file, earlier in this loop.
        Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
        Effect.orDie,
      );
      if (Option.isNone(info)) return;
      const modified = Option.getOrElse(info.value.mtime, () => undefined)?.getTime() ?? 0;
      if (now - modified < SETTLING_MS) return;
      yield* forgetKey(id);
    }),
    { discard: true },
  );
});

/** A command as one line the owner reads: each argument quoted for a POSIX shell where it needs it. */
export const commandLine = (command: ReadonlyArray<string>): string =>
  command
    .map(argument =>
      /^[A-Za-z0-9_@%+=:,./-]+$/u.test(argument)
        ? argument
        : `'${argument.replaceAll("'", `'\\''`)}'`,
    )
    .join(' ');

/** Hands the key to `command` on its stdin, and to nothing else. */
const deliver = Effect.fnUntraced(
  function* (command: ReadonlyArray<string>, token: string) {
    const [executable, ...args] = command;
    if (executable === undefined) return yield* Effect.die('deliver was given no command');
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(executable, args, {
        stdin: Stream.make(new TextEncoder().encode(token)),
        stdout: 'inherit',
        stderr: 'inherit',
      }),
    );
    return Number(yield* handle.exitCode);
  },
  Effect.scoped,
  Effect.catchTag('PlatformError', error =>
    Effect.fail(usage(`Could not run the command that takes the key: ${error.message}`)),
  ),
);

/** Each environment by its address, as this login lists them; an id it does not list stays an id. */
export const addressesOf = Effect.fn('keyFiles.addressesOf')(function* (
  environmentIds: ReadonlyArray<string>,
) {
  const { environments } = yield* listEnvironments();
  return environmentIds.map(
    environmentId => environments.find(({ id }) => id === environmentId)?.address ?? environmentId,
  );
});

/**
 * That the owner really gave the key `token` a read of each of `environmentIds`, as that key sees
 * it: each is listed to the key as read, with a proof of its public key that opens under the
 * account key this login pinned, which only the owner's browser can make, and its read key opens
 * with the key itself. "Approved" alone is the store's word, and a key the owner never approved
 * would be piped into a command or handed out holding nothing. Answers what the key lists.
 */
export const checkReads = Effect.fn('keyFiles.checkReads')(function* (
  environmentIds: ReadonlyArray<string>,
  token: string,
  unproven: UsageError,
) {
  const { pinnedAccount } = yield* ServiceAccount;
  const account = yield* pinnedAccount;
  const { key, api } = yield* serviceAccountFromToken(Redacted.make(token));
  const { environments } = yield* api.environments.list();
  yield* Effect.forEach(
    environmentIds,
    Effect.fnUntraced(function* (environmentId) {
      const listed = environments.find(environment => environment.id === environmentId);
      if (listed === undefined || listed.keyProof === null || !listed.canRead) {
        return yield* unproven;
      }
      const proof = listed.keyProof;
      const binding = { environmentId: listed.id, keyVersion: listed.keyVersion };
      const publicKey = yield* crypto_(() =>
        vouchedEnvironmentKey({
          proof,
          readerKey: key.privateKey,
          readerId: key.credentialId,
          vouchers: [account.publicKey],
          binding,
        }),
      ).pipe(Effect.catchTag('IntegrityError', () => Effect.fail(unproven)));
      if (publicKey !== listed.publicKey) return yield* unproven;
      const { wrap } = yield* api.secrets.bundle({ params: { environmentId: listed.id } }).pipe(
        Effect.catchTags({
          NoAccessError: () => Effect.fail(unproven),
          NotFoundError: () => Effect.fail(unproven),
        }),
      );
      yield* crypto_(() =>
        unwrapEnvironmentKey({
          wrap,
          readerKey: key.privateKey,
          // Its own id, never one the store names: the wrap opens only if it was sealed to it.
          readerId: key.credentialId,
          binding,
          environmentPublicKey: publicKey,
        }),
      ).pipe(Effect.catchTag('IntegrityError', () => Effect.fail(unproven)));
    }),
    { discard: true },
  );
  return environments;
});

/**
 * Finishes a key the owner approved: checks it reads each of `read`, then hands it out. With no
 * command, its file stays where the result says; with one, it is piped in and kept nowhere. A key
 * nobody received is a key nobody can use, so a command that fails takes it back out.
 */
export const handOut = Effect.fn('keyFiles.handOut')(function* ({
  keyId,
  read,
  expiresAt,
}: {
  readonly keyId: string;
  readonly read: ReadonlyArray<string>;
  readonly expiresAt: number | null;
}) {
  const fs = yield* FileSystem.FileSystem;
  const { api } = yield* ServiceAccount;
  const keyFile = yield* keyFileOf(keyId);
  const stored = yield* fs.readFileString(keyFile).pipe(
    Effect.asSome,
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
    Effect.orDie,
  );
  if (Option.isNone(stored)) {
    return yield* usage(
      `The owner approved key ${keyId}, but it is not on this computer (${keyFile}): it is where \`baymutt ask\` ran.`,
      'notFound',
    );
  }
  const token = stored.value.trim();
  yield* checkReads(
    read,
    token,
    usage(
      `The store says key ${keyId} was approved, but it holds no read the owner gave it. Nothing was piped or handed out; it stays at ${keyFile}.`,
      'integrity',
    ),
  );
  const environments = yield* addressesOf(read);
  const kept = yield* readCommand(keyId);
  if (Option.isNone(kept)) return { key: keyId, keyFile, expiresAt, environments };
  return yield* handingOut.withPermit(
    Effect.gen(function* () {
      const revoke = Effect.andThen(
        api.credentials.revoke({ params: { id: keyId } }),
        forgetKey(keyId),
      );
      const command = kept.value;
      const exitCode = yield* deliver(command, token).pipe(Effect.tapError(() => revoke));
      if (exitCode !== 0) {
        yield* revoke;
        return yield* usage(
          `\`${commandLine(command)}\` exited ${exitCode}, so the approved key ${keyId} was revoked. Nothing was left behind; ask again.`,
        );
      }
      yield* forgetKey(keyId);
      return {
        key: keyId,
        piped: true,
        command: commandLine(command),
        exitCode,
        expiresAt,
        environments,
      };
    }),
  );
});
