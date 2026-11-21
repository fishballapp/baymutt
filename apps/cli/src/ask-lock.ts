// One `baymutt` process at a time follows an ask on this computer. Two that did would read the
// same unfinished record and key before either removed them, and could each pipe a key into its
// `command`. The lock is a file beside the ask's record, made exclusively and holding the pid of
// the process that made it: one left by a process that is gone (killed, or its machine reset)
// names a pid nothing runs, and is taken over.
import process from 'node:process';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import { usage } from './errors.ts';
import { isId, keyFileOf } from './key-files.ts';
import { Settings } from './settings.ts';

/** Whether a process with this pid runs: signal 0 only checks, and a process of another user still runs. */
const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
};

const lockFileOf = Effect.fn('askLock.file')(function* (id: string) {
  if (!isId(id)) return yield* usage(`${id} is not the id of an ask.`);
  return `${yield* keyFileOf(id)}.lock`;
});

/** The pid a lock file names; None when it is empty or not a pid, as a lock half made by a kill is. */
const holderOf = (text: string) => {
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? Option.some(pid) : Option.none<number>();
};

/**
 * Holds ask `id` for the rest of the scope, or fails at once, with exit 6, when another process
 * holds it. Released when the scope ends, by a kill too; a lock a kill could not release is taken
 * over by the next process that finds its pid gone.
 */
export const holdingAsk = Effect.fn('askLock.holding')(function* (id: string) {
  const fs = yield* FileSystem.FileSystem;
  const { keysDirectory } = yield* Settings;
  const lock = yield* lockFileOf(id);
  yield* fs.makeDirectory(keysDirectory, { recursive: true, mode: 0o700 }).pipe(Effect.orDie);
  const take = fs.writeFileString(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }).pipe(
    Effect.as(true),
    Effect.catchReason('PlatformError', 'AlreadyExists', () => Effect.succeed(false)),
    Effect.orDie,
  );
  const holder = fs.readFileString(lock).pipe(
    Effect.map(text => holderOf(text)),
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeed(Option.none<number>())),
    Effect.orDie,
  );
  // One take over: a second lock file found stale in a row is another process racing for it.
  const isHeld = yield* take.pipe(
    Effect.flatMap(isTaken =>
      isTaken
        ? Effect.succeed(false)
        : Effect.gen(function* () {
            const pid = yield* holder;
            if (Option.isSome(pid) && isRunning(pid.value)) return true;
            yield* fs.remove(lock).pipe(
              Effect.catchReason('PlatformError', 'NotFound', () => Effect.void),
              Effect.orDie,
            );
            return !(yield* take);
          }),
    ),
  );
  if (isHeld) {
    const pid = Option.getOrUndefined(yield* holder);
    return yield* usage(
      `Another baymutt process${pid === undefined ? '' : ` (pid ${pid})`} is already waiting on ask ${id} on this computer and prints its answers: wait for that one. If none is running, delete ${lock} and run this again.`,
      'conflict',
    );
  }
  yield* Effect.addFinalizer(() =>
    fs.remove(lock).pipe(
      Effect.catchReason('PlatformError', 'NotFound', () => Effect.void),
      Effect.orDie,
    ),
  );
});
