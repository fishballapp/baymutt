import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import { report } from '../errors.ts';
import { print } from '../output.ts';
import { ServiceAccount } from '../service-account.ts';

const listCommand = Command.make(
  'list',
  {},
  Effect.fn('org.list')(function* () {
    const { api } = yield* ServiceAccount;
    yield* print(yield* api.orgs.list());
  }, report),
).pipe(
  Command.withDescription(
    'The orgs this key reaches. The owner creates them in the dashboard; an environment is named with its org first, <org>/<name>',
  ),
);

export const orgCommand = Command.make('org').pipe(
  Command.withDescription('List the orgs. An environment belongs to one'),
  Command.withSubcommands([listCommand]),
  Command.provide(ServiceAccount.layer),
);
