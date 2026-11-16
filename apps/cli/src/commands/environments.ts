import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import { listEnvironments } from '../environments.ts';
import { report } from '../errors.ts';
import { print } from '../output.ts';
import { ServiceAccount } from '../service-account.ts';

export const environmentArgument = Argument.String('environment').pipe(
  Argument.withDescription(
    'The environment, its org first: <org>/<name>, such as acme/app/production',
  ),
);

const listCommand = Command.make(
  'list',
  {},
  Effect.fn('env.list')(function* () {
    const { environments } = yield* listEnvironments();
    yield* print({
      environments: environments.map(({ namesKey: _, ...environment }) => environment),
    });
  }, report),
).pipe(
  Command.withDescription(
    'The environments this key reaches, across its orgs, and what it may do in each. A CLI login lists every environment of its orgs and holds none: `baymutt ask access` gets one. Deleted ones are in `baymutt bin list`',
  ),
);

export const envCommand = Command.make('env').pipe(
  Command.withDescription(
    'List environments. The owner creates them in the dashboard; `baymutt ask create-environment` asks for a new one',
  ),
  Command.withAlias('environment'),
  Command.withSubcommands([listCommand]),
  Command.provide(ServiceAccount.layer),
);
