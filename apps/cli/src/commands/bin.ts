// The bin: what was deleted, and bringing a secret back. Nothing here removes anything for good:
// that is the owner's alone, in the dashboard.
import { SecretNameSchema, VersionSchema } from '@baymutt/api';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { resolveEnvironment } from '../environments.ts';
import { report, usage } from '../errors.ts';
import { print } from '../output.ts';
import { ServiceAccount } from '../service-account.ts';
import { environmentArgument } from './environments.ts';

const listCommand = Command.make(
  'list',
  {},
  Effect.fn('bin.list')(function* () {
    const { api } = yield* ServiceAccount;
    yield* print(yield* api.bin.list());
  }, report),
).pipe(
  Command.withDescription(
    'Deleted environments and secrets, newest first, with when each is removed for good (`purgeAt`)',
  ),
  Command.withAlias('ls'),
);

const restoreCommand = Command.make(
  'restore',
  {
    environment: environmentArgument,
    name: Argument.String('name').pipe(
      Argument.withDescription('The deleted secret’s name'),
      Argument.withSchema(SecretNameSchema),
    ),
    to: Flag.Int('to').pipe(
      Flag.withDescription('The version to make current. Default: its newest'),
      Flag.withSchema(VersionSchema),
      Flag.optional,
    ),
  },
  Effect.fn('bin.restore')(function* ({ environment, name, to }) {
    const { api } = yield* ServiceAccount;
    const { id } = yield* resolveEnvironment(environment);
    const { secrets } = yield* api.bin.list();
    const binned = secrets.find(secret => secret.environmentId === id && secret.name === name);
    if (binned === undefined) {
      return yield* usage(
        `${name} is not in the bin of ${environment}. See what is with \`baymutt bin list\`.`,
        'notFound',
      );
    }
    yield* print(
      yield* api.secrets.rollback({
        params: { environmentId: id, name },
        payload: {
          version: Option.getOrElse(to, () => binned.latestVersion),
          // Refused if something set it again since the list above.
          fromBin: true,
        },
      }),
    );
  }, report),
).pipe(
  Command.withDescription(
    'Bring a deleted secret back, with every version. A deleted environment is restored by the owner, in the dashboard',
  ),
);

export const binCommand = Command.make('bin').pipe(
  Command.withDescription(
    'What was deleted. It can be restored for 30 days, then it is removed for good',
  ),
  Command.withSubcommands([listCommand, restoreCommand]),
  Command.provide(ServiceAccount.layer),
);
