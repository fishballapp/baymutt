// Where the service account key lives: `BAYMUTT_KEY` in CI, the login keychain on a Mac, an owner-only
// file elsewhere (or wherever `BAYMUTT_KEY_FILE` says, for a container or a test). It is read into
// this process and never printed.
import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import * as Redacted from 'effect/Redacted';
import * as Stream from 'effect/Stream';
import { usage } from './errors.ts';
import { Settings } from './settings.ts';

/** The operating system, for the choice of store. A test names another. */
export const Platform = Context.Reference<NodeJS.Platform>('@baymutt/cli/Platform', {
  defaultValue: () => process.platform,
});

const ACCOUNT = 'baymutt';

type Store = {
  readonly source: 'environment' | 'keychain' | 'file';
  readonly read: Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
  readonly write: (
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<void, ReturnType<typeof usage>>;
  /** Forgets the key. Nothing kept is not a failure. */
  readonly remove: Effect.Effect<void, ReturnType<typeof usage>>;
};

const security = Effect.fnUntraced(
  function* (args: ReadonlyArray<string>, stdin?: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make('/usr/bin/security', args, {
        stdin: stdin === undefined ? 'ignore' : Stream.make(new TextEncoder().encode(stdin)),
        stderr: 'ignore',
      }),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
      { concurrency: 2 },
    );
    return { stdout, exitCode: Number(exitCode) };
  },
  Effect.scoped,
  Effect.orDie,
);

export class KeyStore extends Context.Service<KeyStore, Store>()('@baymutt/cli/KeyStore') {
  static readonly layer = Layer.effect(
    KeyStore,
    Effect.gen(function* () {
      const { keyFile, keychainService } = yield* Settings;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fromEnvironment = yield* Config.Redacted('BAYMUTT_KEY').pipe(
        Config.option,
        Effect.orDie,
      );

      if (Option.isSome(fromEnvironment)) {
        return KeyStore.of({
          source: 'environment',
          read: Effect.succeed(fromEnvironment),
          write: () =>
            Effect.fail(usage('BAYMUTT_KEY is set, so the key comes from it. Unset it to log in.')),
          remove: Effect.fail(
            usage(
              'BAYMUTT_KEY is set, so this key belongs to whatever set it, not to this computer. Revoke it with `baymutt service-accounts revoke <id>` or in the dashboard, and remove it from where it is kept.',
            ),
          ),
        });
      }

      const keyFileOverride = yield* Config.String('BAYMUTT_KEY_FILE').pipe(
        Config.option,
        Effect.orDie,
      );
      const file = Option.getOrElse(keyFileOverride, () => keyFile);

      if (Option.isNone(keyFileOverride) && (yield* Platform) === 'darwin') {
        const run = (args: ReadonlyArray<string>, stdin?: string) =>
          security(args, stdin).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
        return KeyStore.of({
          source: 'keychain',
          read: Effect.map(
            run(['find-generic-password', '-a', ACCOUNT, '-s', keychainService, '-w']),
            ({ stdout, exitCode }) =>
              exitCode === 0 && stdout.trim() !== ''
                ? Option.some(Redacted.make(stdout.trim()))
                : Option.none(),
          ),
          // Through `security -i`, which reads its command from stdin: as an argument the key
          // would show in the process list.
          write: token =>
            Effect.flatMap(
              run(
                ['-i'],
                `add-generic-password -U -a ${ACCOUNT} -s "${keychainService}" -w "${Redacted.value(token)}"\n`,
              ),
              ({ exitCode }) =>
                exitCode === 0
                  ? Effect.void
                  : Effect.fail(
                      usage('The login keychain refused the CLI login’s key. Is it unlocked?'),
                    ),
            ),
          // Exit 44 is "no such item": already gone.
          remove: Effect.flatMap(
            run(['delete-generic-password', '-a', ACCOUNT, '-s', keychainService]),
            ({ exitCode }) =>
              exitCode === 0 || exitCode === 44
                ? Effect.void
                : Effect.fail(
                    usage(
                      'The login keychain refused to delete the CLI login’s key. Is it unlocked?',
                    ),
                  ),
          ),
        });
      }

      return KeyStore.of({
        source: 'file',
        read: fs.readFileString(file).pipe(
          Effect.map(text => Option.some(Redacted.make(text.trim()))),
          Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
          Effect.orDie,
        ),
        write: token =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(path.dirname(file), { recursive: true });
            yield* fs.writeFileString(file, `${Redacted.value(token)}\n`, { mode: 0o600 });
          }).pipe(Effect.orDie),
        remove: fs.remove(file).pipe(
          Effect.catchReason('PlatformError', 'NotFound', () => Effect.void),
          Effect.orDie,
        ),
      });
    }),
  );
}
