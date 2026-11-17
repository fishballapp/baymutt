// A request's key on this computer, from `baymutt ask access` to the owner's answer. The key is written to
// an owner-only file before the request is sent, and leaves it when it is piped into the command it
// was asked for, refused, or no longer live at the store. The command, when there is one, waits in
// an owner-only file of its own beside the key, so asks running at once never share a file.
import { IdSchema, type Request } from '@baymutt/api';
import { unwrapEnvironmentKey, vouchedEnvironmentKey } from '@baymutt/keys';
import * as Clock from 'effect/Clock';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import * as Redacted from 'effect/Redacted';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import * as Semaphore from 'effect/Semaphore';
import * as Stream from 'effect/Stream';
import { listEnvironments } from './environments.ts';
import { answerFor, crypto_, type UsageError, usage } from './errors.ts';
import { openStoredName } from './names.ts';
import type { Outcome } from './outcome.ts';
import { ServiceAccount, serviceAccountFromToken } from './service-account.ts';
import { Settings } from './settings.ts';

const POLL_EVERY = Duration.seconds(2);

/** One key is handed out at a time: asks waited on together would otherwise share a command's output. */
const handingOut = Semaphore.makeUnsafe(1);

/** Where the owner answers a request: its page under the org its key belongs to. */
export const requestUrl = Effect.fn('requests.url')(function* ({
  id,
  org,
}: Pick<Request, 'id' | 'org'>) {
  const { origin } = yield* Settings;
  return `${origin}/orgs/${org.slug}/ask/access/${id}`;
});

/** A key file younger than this may belong to an `ask` in another terminal that has not sent its request yet. */
const SETTLING_MS = 10 * 60 * 1000;

/** What a command file's name ends in: the rest is its request's id, the name of its key file. */
const COMMAND_SUFFIX = '.command';

export const isId = Schema.is(IdSchema);

/** Where a request's key is kept: only ever for an id, so no answer can name a path outside the keys directory. */
export const keyFileOf = Effect.fn('requests.keyFile')(function* (id: string) {
  if (!isId(id)) return yield* usage(`${id} is not the id of a request.`);
  const path = yield* Path.Path;
  const { keysDirectory } = yield* Settings;
  return path.join(keysDirectory, id);
});

const commandFileOf = (id: string) => Effect.map(keyFileOf(id), file => `${file}${COMMAND_SUFFIX}`);

/** The command a request's key is piped into, as typed on this computer: never as the store tells it. */
const CommandFileSchema = Schema.fromJsonString(Schema.Array(Schema.String));

/** The command a request waits to pipe its key into, as typed here; None for a key-file request. */
const readCommand = Effect.fn('requests.readCommand')(function* (id: string) {
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

/** Keeps a new request's key, and the command it is to be piped into, before the request is sent. */
export const keepRequestKey = Effect.fn('requests.keep')(function* ({
  id,
  token,
  command,
}: {
  readonly id: string;
  readonly token: string;
  readonly command: ReadonlyArray<string> | null;
}) {
  const fs = yield* FileSystem.FileSystem;
  const { keysDirectory } = yield* Settings;
  yield* fs.makeDirectory(keysDirectory, { recursive: true, mode: 0o700 }).pipe(Effect.orDie);
  const file = yield* keyFileOf(id);
  // The command first: a key file with no command beside it is a key-file request.
  if (command !== null) {
    const text = yield* Schema.encodeEffect(CommandFileSchema)(command).pipe(Effect.orDie);
    yield* fs
      .writeFileString(yield* commandFileOf(id), `${text}\n`, { mode: 0o600 })
      .pipe(Effect.orDie);
  }
  yield* fs.writeFileString(file, `${token}\n`, { mode: 0o600 }).pipe(Effect.orDie);
  return file;
});

/** Forgets a request's key here: its file, and the command it waited to be piped into. */
export const forgetRequestKey = Effect.fn('requests.forget')(function* (id: string) {
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

/** Forgets every request's key here, for a logout: the store revoked them all. */
export const forgetAllRequestKeys = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { keysDirectory } = yield* Settings;
  yield* fs.remove(keysDirectory, { recursive: true }).pipe(
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.void),
    Effect.orDie,
  );
});

/** Removes the key files of keys the store no longer lists as live or waiting: rejected, revoked or expired. */
export const forgetDeadKeys = Effect.fn('requests.forgetDead')(function* () {
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
  // A key still waiting for the owner is a request, not yet a listed credential. The requests are
  // read first and the credentials only after: a request approved between the two reads is then
  // pending in the first and live in the second. Read the other way round, or at once, it can be in
  // neither, and its only key file would be deleted.
  const { requests } = yield* api.requests.list();
  const { credentials } = yield* api.credentials.list();
  const live = new Set([
    ...credentials
      .filter(credential => credential.expiresAt === null || credential.expiresAt > now)
      .map(credential => credential.id),
    ...requests.filter(request => request.status === 'pending').map(request => request.id),
  ]);
  yield* Effect.forEach(
    files,
    Effect.fnUntraced(function* (file) {
      const id = file.endsWith(COMMAND_SUFFIX) ? file.slice(0, -COMMAND_SUFFIX.length) : file;
      // Not a file baymutt keeps: left alone.
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
      yield* forgetRequestKey(id);
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

/** Each environment a request names, by its address, and what it asks for on it. */
const describeItems = Effect.fn('requests.describeItems')(function* (request: Request) {
  const { namesKeys } = yield* listEnvironments();
  return yield* Effect.forEach(
    request.items,
    item =>
      Effect.map(
        openStoredName(namesKeys.get(item.orgId) ?? null, {
          scopeId: item.orgId,
          stored: { name: item.environmentName, sealedName: item.environmentSealedName },
        }),
        name => ({
          environment: `${item.orgSlug}/${name}`,
          canRead: item.canRead,
          canWrite: item.canWrite,
        }),
      ),
    { concurrency: 'unbounded' },
  );
});

/**
 * That the owner really gave the key `token` each of `items`, as that key sees it: each is listed to
 * the key with at least the access named and a proof of its public key that opens under the account
 * key this login pinned, which only the owner's browser can make. "Approved" alone is the store's
 * word, and a key the owner never approved would be piped into a command or handed out holding
 * nothing. Answers what the key lists, for describing it.
 */
export const checkHolds = Effect.fn('requests.checkHolds')(function* (
  items: ReadonlyArray<{
    readonly environmentId: string;
    readonly canRead: boolean;
    readonly canWrite: boolean;
  }>,
  token: string,
  unproven: UsageError,
  {
    unwrapsReads = false,
  }: {
    /**
     * Also open the read key of each environment asked to read, with this key: a proof of the
     * environment's public key is not a read, since a key that only writes holds one too.
     */
    readonly unwrapsReads?: boolean;
  } = {},
) {
  const { pinnedAccount } = yield* ServiceAccount;
  const account = yield* pinnedAccount;
  const { key, api } = yield* serviceAccountFromToken(Redacted.make(token));
  const { environments } = yield* api.environments.list();
  yield* Effect.forEach(
    items,
    Effect.fnUntraced(function* (item) {
      const listed = environments.find(environment => environment.id === item.environmentId);
      if (
        listed === undefined ||
        listed.keyProof === null ||
        (item.canRead && !listed.canRead) ||
        (item.canWrite && !listed.canWrite)
      ) {
        return yield* unproven;
      }
      const proof = listed.keyProof;
      const publicKey = yield* crypto_(() =>
        vouchedEnvironmentKey({
          proof,
          readerKey: key.privateKey,
          readerId: key.credentialId,
          vouchers: [account.publicKey],
          binding: { environmentId: listed.id, keyVersion: listed.keyVersion },
        }),
      ).pipe(Effect.catchTag('IntegrityError', () => Effect.fail(unproven)));
      if (publicKey !== listed.publicKey) return yield* unproven;
      if (!(unwrapsReads && item.canRead)) return;
      const binding = { environmentId: listed.id, keyVersion: listed.keyVersion };
      const { wrap } = yield* api.secrets.bundle({ params: { environmentId: listed.id } }).pipe(
        Effect.catchTag('NoAccessError', () => Effect.fail(unproven)),
        Effect.catchTag('NotFoundError', () => Effect.fail(unproven)),
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

/** That the owner really approved `request`: its key holds everything it named. */
const checkApproved = Effect.fn('requests.checkApproved')(function* (
  request: Request,
  token: string,
) {
  const unproven = usage(
    `The store says request ${request.id} was approved, but its key holds no access the owner gave it. Nothing was piped or handed out; its key stays at ${yield* keyFileOf(request.id)}.`,
    'integrity',
  );
  if (request.items.length === 0) return yield* unproven;
  yield* checkHolds(request.items, token, unproven);
});

const finishApproved = Effect.fn('requests.finishApproved')(function* (request: Request) {
  const fs = yield* FileSystem.FileSystem;
  const { api } = yield* ServiceAccount;
  const keyFile = yield* keyFileOf(request.id);
  const stored = yield* fs.readFileString(keyFile).pipe(
    Effect.asSome,
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
    Effect.orDie,
  );
  if (Option.isNone(stored)) {
    return yield* usage(
      `The owner approved request ${request.id}, but its key is not on this computer (${keyFile}): it is where \`baymutt ask access\` ran.`,
      'notFound',
    );
  }
  const token = stored.value;
  yield* checkApproved(request, token.trim());
  const environments = yield* describeItems(request);
  const kept = yield* readCommand(request.id);
  if (Option.isNone(kept)) {
    return {
      id: request.id,
      status: 'approved',
      keyFile,
      expiresAt: request.expiresAt,
      environments,
    };
  }
  // A key nobody received is a service account nobody can use: take it back out.
  const revoke = Effect.andThen(
    api.credentials.revoke({ params: { id: request.id } }),
    forgetRequestKey(request.id),
  );
  const command = kept.value;
  const exitCode = yield* deliver(command, token.trim()).pipe(Effect.tapError(() => revoke));
  if (exitCode !== 0) {
    yield* revoke;
    return yield* usage(
      `\`${commandLine(command)}\` exited ${exitCode}, so the approved key was revoked. Nothing was left behind; ask again.`,
    );
  }
  yield* forgetRequestKey(request.id);
  return {
    id: request.id,
    status: 'approved',
    piped: true,
    command: commandLine(command),
    exitCode,
    expiresAt: request.expiresAt,
    environments,
  };
});

/**
 * Waits up to `timeout` seconds for the owner's answer to a request this login made, then finishes
 * it: approved, the key is where the result says or piped into its command; rejected, expired or
 * gone, the key is removed here.
 */
export const settleRequest = Effect.fn('requests.settle')(function* (
  request: Request,
  timeout: number,
) {
  const { api } = yield* ServiceAccount;
  // None: the store no longer has it.
  const latest = api.requests.get({ params: { id: request.id } }).pipe(
    answerFor(request.id),
    Effect.asSome,
    Effect.catchTag('NotFoundError', () => Effect.succeedNone),
  );
  const answered =
    request.status === 'pending'
      ? yield* latest.pipe(
          Effect.repeat({
            schedule: Schedule.spaced(POLL_EVERY),
            until: current => Option.isNone(current) || current.value.status !== 'pending',
          }),
          Effect.timeoutOption(Duration.seconds(timeout)),
        )
      : Option.some(Option.some(request));

  if (Option.isNone(answered)) {
    return {
      kind: 'unanswered',
      result: {
        id: request.id,
        status: 'pending',
        url: yield* requestUrl(request),
        next: `Run \`baymutt ask wait ${request.id}\` to keep waiting.`,
      },
      failure: usage(
        `The owner has not answered request ${request.id} yet. It waits an hour from when it was asked: run \`baymutt ask wait ${request.id}\` to keep waiting.`,
        'differs',
      ),
    } satisfies Outcome;
  }
  const current = answered.value;
  if (Option.isSome(current) && current.value.status === 'approved') {
    const result = yield* handingOut.withPermit(finishApproved(current.value));
    return { kind: 'granted', result } satisfies Outcome;
  }
  yield* forgetRequestKey(request.id);
  if (Option.isSome(current) && current.value.status === 'expired') {
    return {
      kind: 'refused',
      status: 'expired',
      failure: usage(
        `Nobody answered request ${request.id} within an hour, so it expired. Its key was removed from this computer. Run \`baymutt ask access\` again when the owner is around.`,
        'noAccess',
      ),
    } satisfies Outcome;
  }
  return {
    kind: 'refused',
    status: Option.isSome(current) ? current.value.status : 'gone',
    failure: usage(
      Option.isSome(current)
        ? `The owner rejected request ${request.id}. Its key was removed from this computer.`
        : `Request ${request.id} is gone: the store no longer has it. Its key was removed from this computer.`,
      'noAccess',
    ),
  } satisfies Outcome;
});
