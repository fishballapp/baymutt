// Reading names and versions, writing values, and paste links for a value only the owner can fetch.
// No command here takes a value as an argument or prints one.
import { SecretNameSchema, VersionSchema } from '@baymutt/api';
import { publicKeyFingerprint, randomToken, tokenHash } from '@baymutt/keys';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';
import * as Stdio from 'effect/Stdio';
import * as Stream from 'effect/Stream';
import { addressOf, resolveEnvironment, trustedKey } from '../environments.ts';
import { crypto_, report, usage } from '../errors.ts';
import { print, say } from '../output.ts';
import { describeWrite, writeValue } from '../secrets.ts';
import { ServiceAccount } from '../service-account.ts';
import { Settings } from '../settings.ts';
import { environmentArgument } from './environments.ts';

const nameArgument = Argument.String('name').pipe(
  Argument.withDescription(
    'The secret’s name: letters, digits and underscores, not starting with a digit, such as STRIPE_SECRET_KEY',
  ),
  Argument.withSchema(SecretNameSchema),
);

const listCommand = Command.make(
  'secrets',
  { environment: environmentArgument },
  Effect.fn('secrets.list')(function* ({ environment }) {
    const { api } = yield* ServiceAccount;
    const resolved = yield* resolveEnvironment(environment);
    const { secrets } = yield* api.secrets.list({ params: { environmentId: resolved.id } });
    // A deleted one is in the bin, listed by `baymutt bin list`.
    yield* print({
      environment: addressOf(resolved),
      secrets: secrets.filter(secret => secret.currentVersion !== null),
    });
  }, report),
).pipe(
  Command.provide(ServiceAccount.layer),
  Command.withDescription(
    'An environment’s secrets: names, versions and sizes. Never a value. Deleted ones are in `baymutt bin list`',
  ),
);

const stdinValue = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  if (yield* stdio.stdinIsTerminal) {
    return yield* usage(
      'The value comes from stdin, never an argument: `baymutt set <environment> <NAME> < file`, or pipe it. For a value only the owner can fetch, make a paste link with `baymutt paste-link`.',
    );
  }
  const value = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString, Effect.orDie);
  if (value === '') return yield* usage('stdin was empty, so there is no value to set.');
  return value;
});

const setCommand = Command.make(
  'set',
  {
    environment: environmentArgument,
    name: nameArgument,
    keepNewline: Flag.Boolean('keep-newline').pipe(
      Flag.withDescription(
        'Keep a single trailing newline, which is otherwise dropped as a file’s or `echo`’s',
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fn('secrets.set')(function* ({ environment, name, keepNewline }) {
    const resolved = yield* resolveEnvironment(environment);
    const piped = yield* stdinValue;
    const value = keepNewline ? piped : piped.replace(/\r?\n$/, '');
    yield* print(
      describeWrite(resolved, yield* writeValue({ environment: resolved, name, value }), value),
    );
  }, report),
).pipe(
  Command.provide(ServiceAccount.layer),
  Command.withDescription(
    'Set a secret from stdin, as a new version. Needs write access. Prints the name, version and length',
  ),
);

const FORMATS = {
  base64url: (bytes: Uint8Array) => bytes.toBase64({ alphabet: 'base64url', omitPadding: true }),
  base64: (bytes: Uint8Array) => bytes.toBase64(),
  hex: (bytes: Uint8Array) => bytes.toHex(),
} as const;

const generateCommand = Command.make(
  'generate',
  {
    environment: environmentArgument,
    name: nameArgument,
    bytes: Flag.Int('bytes').pipe(
      Flag.withDescription('How many random bytes (16 to 1024)'),
      Flag.withDefault(32),
    ),
    format: Flag.Literals('format', ['base64url', 'base64', 'hex']).pipe(
      Flag.withDescription('How the bytes are written'),
      Flag.withDefault('base64url'),
    ),
  },
  Effect.fn('secrets.generate')(function* ({ environment, name, bytes, format }) {
    if (bytes < 16 || bytes > 1024) return yield* usage('--bytes is between 16 and 1024.');
    const resolved = yield* resolveEnvironment(environment);
    const value = FORMATS[format](crypto.getRandomValues(new Uint8Array(bytes)));
    yield* print(
      describeWrite(resolved, yield* writeValue({ environment: resolved, name, value }), value),
    );
  }, report),
).pipe(
  Command.provide(ServiceAccount.layer),
  Command.withDescription(
    'Make a random value here and set it, without showing it. On an existing name this replaces the value',
  ),
);

const deleteCommand = Command.make(
  'delete',
  { environment: environmentArgument, name: nameArgument },
  Effect.fn('secrets.delete')(function* ({ environment, name }) {
    const { api } = yield* ServiceAccount;
    const { id } = yield* resolveEnvironment(environment);
    yield* print(yield* api.secrets.remove({ params: { environmentId: id, name } }));
  }, report),
).pipe(
  Command.provide(ServiceAccount.layer),
  Command.withDescription(
    'Delete a secret. It goes to the bin: a load stops answering it, `baymutt bin restore` brings it back with every version for 30 days, then it is removed for good',
  ),
);

const rollbackCommand = Command.make(
  'rollback',
  {
    environment: environmentArgument,
    name: nameArgument,
    to: Flag.Int('to').pipe(
      Flag.withDescription('The version to make current (see `baymutt history`)'),
      Flag.withSchema(VersionSchema),
    ),
  },
  Effect.fn('secrets.rollback')(function* ({ environment, name, to }) {
    const { api } = yield* ServiceAccount;
    const { id } = yield* resolveEnvironment(environment);
    yield* print(
      yield* api.secrets.rollback({
        params: { environmentId: id, name },
        payload: { version: to },
      }),
    );
  }, report),
).pipe(
  Command.provide(ServiceAccount.layer),
  Command.withDescription('Make an earlier version of a secret the current one'),
);

const historyCommand = Command.make(
  'history',
  { environment: environmentArgument, name: nameArgument },
  Effect.fn('secrets.history')(function* ({ environment, name }) {
    const { api } = yield* ServiceAccount;
    const { id } = yield* resolveEnvironment(environment);
    yield* print(yield* api.secrets.versions({ params: { environmentId: id, name } }));
  }, report),
).pipe(
  Command.provide(ServiceAccount.layer),
  Command.withDescription('A secret’s versions: who wrote each, and when'),
);

/** The names a `.env.schema` declares: `NAME=` at the start of a line, comments apart. */
export const schemaNames = (schema: string): ReadonlyArray<string> =>
  Array.from(schema.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/gm), ([, name]) => name ?? '');

const checkCommand = Command.make(
  'check',
  {
    environment: environmentArgument,
    schema: Flag.String('schema').pipe(
      Flag.withDescription('The schema file whose names the environment should hold'),
      Flag.withDefault('.env.schema'),
    ),
    ignore: Flag.String('ignore').pipe(
      Flag.withDescription('A name the schema declares and the store need not hold (repeatable)'),
      Flag.atLeast(0),
    ),
  },
  Effect.fn('secrets.check')(function* ({ environment, schema, ignore }) {
    const fs = yield* FileSystem.FileSystem;
    const { api } = yield* ServiceAccount;
    const resolved = yield* resolveEnvironment(environment);
    const address = addressOf(resolved);
    const declared = new Set(
      schemaNames(
        yield* fs
          .readFileString(schema)
          .pipe(
            Effect.catchReason('PlatformError', 'NotFound', () =>
              Effect.fail(
                usage(`There is no schema at ${schema}. Name one with --schema.`, 'notFound'),
              ),
            ),
          ),
      ),
    ).difference(new Set(ignore));
    const { secrets } = yield* api.secrets.list({ params: { environmentId: resolved.id } });
    const stored = new Set(
      secrets.filter(secret => secret.currentVersion !== null).map(secret => secret.name),
    );
    const missing = [...declared.difference(stored)].toSorted();
    yield* print({
      environment: address,
      schema,
      present: [...declared.intersection(stored)].toSorted(),
      missing,
      unused: [...stored.difference(declared)].toSorted(),
    });
    if (missing.length > 0) {
      return yield* usage(
        `${missing.length} name(s) the schema declares are not in ${address}: ${missing.join(', ')}. Set each with \`baymutt set\` or \`baymutt generate\`, or make a paste link for the owner with \`baymutt paste-link\`.`,
        'differs',
      );
    }
  }, report),
).pipe(
  Command.provide(ServiceAccount.layer),
  Command.withDescription(
    'Compare a .env.schema with what an environment holds. Exits 9 when a declared name is missing',
  ),
);

const pasteLinkCommand = Command.make(
  'paste-link',
  {
    environment: environmentArgument,
    name: nameArgument,
    reason: Flag.String('reason').pipe(
      Flag.withDescription('Why it is needed, for the owner to read'),
    ),
    where: Flag.String('where').pipe(
      Flag.withDescription(
        'Where the owner finds the value: "Stripe dashboard, Developers, API keys"',
      ),
    ),
  },
  Effect.fn('secrets.pasteLink')(function* ({ environment, name, reason, where }) {
    const { api } = yield* ServiceAccount;
    const { origin } = yield* Settings;
    const resolved = yield* resolveEnvironment(environment);
    const id = crypto.randomUUID();
    const token = randomToken();
    const { publicKey } = yield* trustedKey(resolved);
    const [hash, fingerprint] = yield* crypto_(() =>
      Promise.all([tokenHash(token), publicKeyFingerprint(publicKey)]),
    );
    const link = yield* api.pasteLinks.create({
      payload: { id, environmentId: resolved.id, name, reason, hint: where, tokenHash: hash },
    });
    // The fragment never reaches the store: the token proves the link, and the fingerprint lets
    // the page refuse an environment key the store swapped.
    const url = `${origin}/paste/${id}#${token}.${fingerprint}`;
    yield* say(
      `Ask the owner to open this link and paste ${name}. It works once, for 15 minutes; after that it is in the dashboard, under Paste links.`,
    );
    yield* print({ ...link, url });
  }, report),
).pipe(
  Command.provide(ServiceAccount.layer),
  Command.withDescription(
    'Make a paste link: a single-use link to a page where the owner pastes one value into one environment and name',
  ),
);

const WAIT_POLL = Duration.seconds(3);

const waitCommand = Command.make(
  'wait',
  {
    id: Argument.String('link-id').pipe(
      Argument.withDescription('The paste link’s id, as `baymutt paste-link` printed it'),
    ),
    timeout: Flag.Int('timeout').pipe(
      Flag.withDescription('Seconds to wait before giving up (the link stays open)'),
      Flag.withDefault(900),
    ),
  },
  Effect.fn('secrets.wait')(function* ({ id, timeout }) {
    const { api } = yield* ServiceAccount;
    // A credential's list holds its own links while they wait: one that has left it was answered
    // or dismissed.
    const isWaiting = Effect.map(api.pasteLinks.list(), ({ links }) =>
      links.some(link => link.id === id),
    );
    const settled = yield* isWaiting.pipe(
      Effect.repeat({ schedule: Schedule.spaced(WAIT_POLL), until: waiting => !waiting }),
      Effect.timeoutOption(Duration.seconds(timeout)),
    );
    if (Option.isNone(settled)) {
      yield* print({ id, status: 'pending' });
      return yield* usage(
        `Nobody has answered this paste link in ${timeout} seconds. It is still open: run \`baymutt wait ${id}\` again, or ask the owner to answer it under Paste links in the dashboard.`,
        'differs',
      );
    }
    yield* print({ id, status: 'answered' });
  }, report),
).pipe(
  Command.provide(ServiceAccount.layer),
  Command.withDescription(
    'Wait until the owner has answered a paste link (pasted, or dismissed it). Exits 9 on timeout. Check the value arrived with `baymutt secrets <environment>`',
  ),
);

const cancelCommand = Command.make(
  'cancel',
  {
    id: Argument.String('link-id').pipe(
      Argument.withDescription('The paste link’s id, as `baymutt paste-link` printed it'),
    ),
  },
  Effect.fn('secrets.cancel')(function* ({ id }) {
    const { api } = yield* ServiceAccount;
    yield* api.pasteLinks.cancel({ params: { id } });
    yield* print({ id, status: 'cancelled' });
  }, report),
).pipe(
  Command.provide(ServiceAccount.layer),
  Command.withDescription(
    'Withdraw a paste link made from this key: it stops working and the owner no longer sees it',
  ),
);

export const secretCommands = [
  listCommand,
  setCommand,
  generateCommand,
  deleteCommand,
  rollbackCommand,
  historyCommand,
  checkCommand,
  pasteLinkCommand,
  waitCommand,
  cancelCommand,
] as const;
