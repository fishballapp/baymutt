// Reading an environment's secret names and versions. Nothing here writes or prints a value: a
// value is asked for in an ask (`baymutt ask`), and the owner writes it.
import { SecretNameSchema } from '@baymutt/api';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import { resolveEnvironment } from '../environments.ts';
import { report, usage } from '../errors.ts';
import { print } from '../output.ts';
import { listSecrets, secretParams, shownSecret } from '../secrets.ts';
import { ServiceAccount } from '../service-account.ts';
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
        `${missing.length} name(s) the schema declares are not in ${address}: ${missing.join(', ')}. Ask the owner for each in an ask's \`secrets\` step: \`baymutt ask\` (see \`baymutt ask --help\`).`,
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

export const secretCommand = Command.make('secret').pipe(
  Command.withDescription(
    'An environment’s secrets: list them, see the history of one, and check them against a schema. No command prints or writes a value: ask the owner for one with `baymutt ask`',
  ),
  Command.withSubcommands([listCommand, historyCommand, checkCommand]),
);
