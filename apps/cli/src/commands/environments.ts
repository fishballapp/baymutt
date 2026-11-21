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
    // A key only reads, so the store's `canWrite` (kept for older CLIs) is false for every caller here.
    yield* print({
      environments: environments.map(
        ({ namesKey: _, canWrite: __, ...environment }) => environment,
      ),
    });
  }, report),
).pipe(
  Command.withDescription(
    'The environments this key reaches, across its orgs, and whether it reads each. A CLI login lists every environment of its orgs and holds none: a plan’s `access` step gets one (`baymutt ask`). Deleted ones are in `baymutt bin list`',
  ),
);

export const envCommand = Command.make('env').pipe(
  Command.withDescription(
    'List environments. A plan’s `environments` step asks the owner for a new one (`baymutt ask`)',
  ),
  Command.withAlias('environment'),
  Command.withSubcommands([listCommand]),
  Command.provide(ServiceAccount.layer),
);
