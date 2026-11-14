import { EnvironmentNameSchema, OrgSlugSchema } from '@baymutt/api';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { createEnvironment } from '../environments.ts';
import { report, usage } from '../errors.ts';
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
  Effect.fn('environments.list')(function* () {
    const { api } = yield* ServiceAccount;
    yield* print(yield* api.environments.list());
  }, report),
).pipe(
  Command.withDescription(
    'The environments this CLI login or service account reaches, across its orgs, and what it may do in each. Deleted ones are in `baymutt bin list`',
  ),
  Command.withAlias('ls'),
);

const isSlug = Schema.is(OrgSlugSchema);
const isName = Schema.is(EnvironmentNameSchema);

const createCommand = Command.make(
  'create',
  {
    environment: Argument.String('environment').pipe(
      Argument.withDescription(
        '<org>/<name>: an org of yours, then lower-case segments joined by /, such as acme/app/production',
      ),
    ),
  },
  Effect.fn('environments.create')(function* ({ environment }) {
    const slash = environment.indexOf('/');
    const orgSlug = environment.slice(0, slash);
    const name = environment.slice(slash + 1);
    if (slash === -1 || !isSlug(orgSlug) || !isName(name)) {
      return yield* usage(
        `${environment} is not <org>/<name>: an org slug (lower-case letters, digits, hyphens), then lower-case segments joined by /, such as acme/app/production.`,
      );
    }
    yield* print(yield* createEnvironment({ orgSlug, name }));
  }, report),
).pipe(
  Command.withDescription(
    'Create an environment in one of your orgs. Its key is made here; this CLI login gets read and write, and the owner can read it.',
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
      credential: credentials.find(({ id }) => id === key.credentialId) ?? null,
    });
  }, report),
).pipe(
  Command.withDescription('This CLI login or service account, its account and the access it holds'),
  Command.provide(ServiceAccount.layer),
);
