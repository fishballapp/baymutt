import { ProjectNameSchema } from '@baymutt/api';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import { report } from '../errors.ts';
import { Machine } from '../machine.ts';
import { print } from '../output.ts';
import { createProject } from '../projects.ts';

export const projectArgument = Argument.String('project').pipe(
  Argument.withDescription('The project’s name, such as app/production'),
);

const listCommand = Command.make(
  'list',
  {},
  Effect.fn('projects.list')(function* () {
    const { api } = yield* Machine;
    yield* print(yield* api.projects.list());
  }, report),
).pipe(
  Command.withDescription('The projects this machine holds a grant on, and what it may do in each'),
  Command.withAlias('ls'),
);

const createCommand = Command.make(
  'create',
  {
    name: Argument.String('name').pipe(
      Argument.withDescription(
        'Lower-case segments joined by /. Dev and production are separate projects: app/production',
      ),
      Argument.withSchema(ProjectNameSchema),
    ),
  },
  Effect.fn('projects.create')(function* ({ name }) {
    yield* print(yield* createProject(name));
  }, report),
).pipe(
  Command.withDescription(
    'Create a project. Its key is made here; this machine gets read and write, and the owner can read it.',
  ),
);

export const projectsCommand = Command.make('projects').pipe(
  Command.withDescription('List and create projects'),
  Command.withSubcommands([listCommand, createCommand]),
  Command.provide(Machine.layer),
);

export const whoamiCommand = Command.make(
  'whoami',
  {},
  Effect.fn('whoami')(function* () {
    const { api, key } = yield* Machine;
    const [me, { credentials }] = yield* Effect.all(
      [api.credentials.me(), api.credentials.list()],
      { concurrency: 2 },
    );
    yield* print({
      account: { id: me.accountId, name: me.accountName },
      machine: credentials.find(({ id }) => id === key.credentialId) ?? null,
    });
  }, report),
).pipe(
  Command.withDescription('This machine, its account and the grants it holds'),
  Command.provide(Machine.layer),
);
