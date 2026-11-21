// The bin: what was deleted. Bringing something back is asked for in a plan (`baymutt ask`), and
// removing it for good is the owner's alone, in the dashboard.
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import { listEnvironments } from '../environments.ts';
import { report } from '../errors.ts';
import { openStoredName } from '../names.ts';
import { print } from '../output.ts';
import { ServiceAccount } from '../service-account.ts';

const listCommand = Command.make(
  'list',
  {},
  Effect.fn('bin.list')(function* () {
    const { api } = yield* ServiceAccount;
    const [bin, { namesKeys }] = yield* Effect.all([api.bin.list(), listEnvironments()], {
      concurrency: 2,
    });
    const namesKeyOf = (orgId: string) => namesKeys.get(orgId) ?? null;
    const environments = yield* Effect.forEach(
      bin.environments,
      ({ name, sealedName, ...environment }) =>
        Effect.map(
          openStoredName(namesKeyOf(environment.orgId), {
            scopeId: environment.orgId,
            stored: { name, sealedName },
          }),
          opened => ({ ...environment, name: opened }),
        ),
      { concurrency: 'unbounded' },
    );
    const secrets = yield* Effect.forEach(
      bin.secrets,
      Effect.fnUntraced(function* ({
        name,
        sealedName,
        environmentName,
        environmentSealedName,
        ...secret
      }) {
        const namesKey = namesKeyOf(secret.orgId);
        return {
          ...secret,
          environmentName: yield* openStoredName(namesKey, {
            scopeId: secret.orgId,
            stored: { name: environmentName, sealedName: environmentSealedName },
          }),
          name: yield* openStoredName(namesKey, {
            scopeId: secret.environmentId,
            stored: { name, sealedName },
          }),
        };
      }),
      { concurrency: 'unbounded' },
    );
    yield* print({ environments, secrets });
  }, report),
).pipe(
  Command.withDescription(
    'Deleted environments and secrets, newest first, with when each is removed for good (`purgeAt`)',
  ),
);

export const binCommand = Command.make('bin').pipe(
  Command.withDescription(
    'What was deleted. For 30 days a plan can ask the owner to restore it (`baymutt ask`), then it is removed for good',
  ),
  Command.withSubcommands([listCommand]),
  Command.provide(ServiceAccount.layer),
);
