// Reading names and versions, writing values, and paste links for a value only the owner can fetch.
// No command here takes a value as an argument or prints one.
import { SecretNameSchema, VersionSchema } from '@baymutt/api';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Stdio from 'effect/Stdio';
import * as Stream from 'effect/Stream';
import { handOver } from '../asks.ts';
import { resolveEnvironment } from '../environments.ts';
import { report, usage } from '../errors.ts';
import { sealNewName } from '../names.ts';
import { print } from '../output.ts';
import {
  describeWrite,
  listSecrets,
  openSecret,
  secretParams,
  shownSecret,
  writeValue,
} from '../secrets.ts';
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
  'list',
  { environment: environmentArgument },
  Effect.fn('secret.list')(function* ({ environment }) {
    const resolved = yield* resolveEnvironment(environment);
    const secrets = yield* listSecrets(resolved);
    // A deleted one is in the bin, listed by `baymutt bin list`.
    yield* print({
      environment: resolved.address,
      secrets: secrets.filter(secret => secret.currentVersion !== null).map(shownSecret),
    });
  }, report),
).pipe(
  Command.provide(ServiceAccount.layer),
  Command.withDescription(
    'An environment’s secrets: names, versions and sizes. Never a value. A CLI login lists them too. Deleted ones are in `baymutt bin list`',
  ),
);

const stdinValue = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  if (yield* stdio.stdinIsTerminal) {
    return yield* usage(
      'The value comes from stdin, never an argument: `baymutt secret set <environment> <NAME> < file`, or pipe it. For a value only the owner can fetch, make a paste link with `baymutt ask paste-link`.',
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
  Effect.fn('secret.set')(function* ({ environment, name, keepNewline }) {
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
  Effect.fn('secret.generate')(function* ({ environment, name, bytes, format }) {
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
  Effect.fn('secret.delete')(function* ({ environment, name }) {
    const { api } = yield* ServiceAccount;
    const resolved = yield* resolveEnvironment(environment);
    const removed = yield* api.secrets.remove({ params: yield* secretParams(resolved, name) });
    yield* print(shownSecret(yield* openSecret(resolved, removed)));
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
      Flag.withDescription('The version to make current (see `baymutt secret history`)'),
      Flag.withSchema(VersionSchema),
    ),
  },
  Effect.fn('secret.rollback')(function* ({ environment, name, to }) {
    const { api } = yield* ServiceAccount;
    const resolved = yield* resolveEnvironment(environment);
    const rolledBack = yield* api.secrets.rollback({
      params: yield* secretParams(resolved, name),
      payload: { version: to },
    });
    yield* print(shownSecret(yield* openSecret(resolved, rolledBack)));
  }, report),
).pipe(
  Command.provide(ServiceAccount.layer),
  Command.withDescription('Make an earlier version of a secret the current one'),
);

const historyCommand = Command.make(
  'history',
  { environment: environmentArgument, name: nameArgument },
  Effect.fn('secret.history')(function* ({ environment, name }) {
    const { api } = yield* ServiceAccount;
    const resolved = yield* resolveEnvironment(environment);
    const { versions } = yield* api.secrets.versions({
      params: yield* secretParams(resolved, name),
    });
    yield* print({ environment: resolved.address, name, versions });
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
  Effect.fn('secret.check')(function* ({ environment, schema, ignore }) {
    const fs = yield* FileSystem.FileSystem;
    const resolved = yield* resolveEnvironment(environment);
    const address = resolved.address;
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
    const secrets = yield* listSecrets(resolved);
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
        `${missing.length} name(s) the schema declares are not in ${address}: ${missing.join(', ')}. Set each with \`baymutt secret set\` or \`baymutt secret generate\`, or make a paste link for the owner with \`baymutt ask paste-link\`.`,
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

/** `baymutt ask paste-link`: one of the things asked of the owner, so it lives in that group. */
export const pasteLinkCommand = Command.make(
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
  Effect.fn('secret.pasteLink')(function* ({ environment, name, reason, where }) {
    const { api } = yield* ServiceAccount;
    const { origin } = yield* Settings;
    const resolved = yield* resolveEnvironment(environment);
    const id = crypto.randomUUID();
    const sealed = yield* sealNewName(resolved.namesKey, {
      scopeId: resolved.id,
      name,
      orgSlug: resolved.orgSlug,
    });
    const {
      name: _,
      sealedName: __,
      environmentName: ___,
      environmentSealedName: ____,
      ...link
    } = yield* api.pasteLinks.create({
      payload: { id, environmentId: resolved.id, ...sealed, reason, hint: where },
    });
    // The link carries nothing but its id: only the owner, signed in with the vault open, answers it.
    const url = `${origin}/paste/${id}`;
    yield* print({ ...link, environment: resolved.address, name, url, next: handOver(id) });
  }, report),
).pipe(
  Command.provide(ServiceAccount.layer),
  Command.withDescription(
    'Make a paste link: a single-use link to a page where the owner, signed in, pastes one value into one environment and name. A CLI login can make one. It prints the link and returns at once, and the link works for an hour: end your reply to the owner with the link, alone on its last line, since they see only that reply. Run `baymutt ask wait <id>` in the background, or after that reply, never before it: a wait that blocks first hides the link',
  ),
);

export const secretCommand = Command.make('secret').pipe(
  Command.withDescription(
    'An environment’s secrets: list, set, generate, delete, roll back, see the history of, and check them against a schema. No command prints a value',
  ),
  Command.withSubcommands([
    listCommand,
    setCommand,
    generateCommand,
    deleteCommand,
    rollbackCommand,
    historyCommand,
    checkCommand,
  ]),
);
