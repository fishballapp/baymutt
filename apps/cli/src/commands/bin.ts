// The bin: what was deleted, and bringing a secret back. Nothing here removes anything for good:
// that is the owner's alone, in the dashboard.
import { SecretNameSchema, VersionSchema } from '@baymutt/api';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { listEnvironments, resolveEnvironment } from '../environments.ts';
import { report, usage } from '../errors.ts';
import { openStoredName } from '../names.ts';
import { print } from '../output.ts';
import { openSecret, secretParams, shownSecret } from '../secrets.ts';
import { ServiceAccount } from '../service-account.ts';
import { environmentArgument } from './environments.ts';

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
    const resolved = yield* resolveEnvironment(environment);
    const params = yield* secretParams(resolved, name);
    const { secrets } = yield* api.bin.list();
    const binned = secrets.find(
      secret => secret.environmentId === params.environmentId && secret.name === params.name,
    );
    if (binned === undefined) {
      return yield* usage(
        `${name} is not in the bin of ${environment}. See what is with \`baymutt bin list\`.`,
        'notFound',
      );
    }
    const restored = yield* api.secrets.rollback({
      params,
      payload: {
        version: Option.getOrElse(to, () => binned.latestVersion),
        // Refused if something set it again since the list above.
        fromBin: true,
      },
    });
    yield* print(shownSecret(yield* openSecret(resolved, restored)));
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
