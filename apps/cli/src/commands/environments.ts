import { EnvironmentNameSchema } from '@baymutt/api';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import { createEnvironment } from '../environments.ts';
import { report } from '../errors.ts';
import { print } from '../output.ts';
import { ServiceAccount } from '../service-account.ts';

export const environmentArgument = Argument.String('environment').pipe(
  Argument.withDescription('The environment’s name, such as app/production'),
);

const listCommand = Command.make(
  'list',
  {},
  Effect.fn('environments.list')(function* () {
    const { api } = yield* ServiceAccount;
    yield* print(yield* api.environments.list());
  }, report),
).pipe(
  Command.withDescription(
    'The environments this service account holds a grant on, and what it may do in each. Deleted ones are in `baymutt bin list`',
  ),
  Command.withAlias('ls'),
);

const createCommand = Command.make(
  'create',
  {
    name: Argument.String('name').pipe(
      Argument.withDescription('Lower-case segments joined by /, such as app/production'),
      Argument.withSchema(EnvironmentNameSchema),
    ),
  },
  Effect.fn('environments.create')(function* ({ name }) {
    yield* print(yield* createEnvironment(name));
  }, report),
).pipe(
  Command.withDescription(
    'Create an environment. Its key is made here; this service account gets read and write, and the owner can read it.',
  ),
);

export const environmentsCommand = Command.make('environments').pipe(
  Command.withDescription('List and create environments'),
  Command.withAlias('envs'),
  Command.withSubcommands([listCommand, createCommand]),
  Command.provide(ServiceAccount.layer),
);

export const whoamiCommand = Command.make(
  'whoami',
  {},
  Effect.fn('whoami')(function* () {
    const { api, key } = yield* ServiceAccount;
    const [me, { credentials }] = yield* Effect.all(
      [api.credentials.me(), api.credentials.list()],
      { concurrency: 2 },
    );
    yield* print({
      account: { id: me.accountId, name: me.accountName },
      serviceAccount: credentials.find(({ id }) => id === key.credentialId) ?? null,
    });
  }, report),
).pipe(
  Command.withDescription('This service account, its account and the grants it holds'),
  Command.provide(ServiceAccount.layer),
);
