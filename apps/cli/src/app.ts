import * as CliConfig from 'effect/cli/CliConfig';
import * as CliOutput from 'effect/cli/CliOutput';
import * as Command from 'effect/cli/Command';
import * as GlobalFlag from 'effect/cli/GlobalFlag';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import { auditCommand, serviceAccountsCommand } from './commands/access.ts';
import { loginCommand, logoutCommand } from './commands/login.ts';
import { projectsCommand, whoamiCommand } from './commands/projects.ts';
import { secretCommands } from './commands/secrets.ts';
import { KeyStore } from './key-store.ts';
import { Settings } from './settings.ts';

export const cli = Command.make('baymutt').pipe(
  Command.withDescription(
    'A zero-knowledge secret store, from an agent’s side. Values are sealed and opened on this computer; every command prints JSON on stdout and no command prints a value. Failures are one JSON line on stderr: exit 2 usage, 3 not logged in, 4 no access, 5 not found, 6 conflict, 7 unreachable, 8 integrity, 9 check differs.',
  ),
  Command.withSubcommands([
    loginCommand,
    logoutCommand,
    whoamiCommand,
    projectsCommand,
    ...secretCommands,
    serviceAccountsCommand,
    auditCommand,
  ]),
  // Inside the tree, so `--help` and `--version` never read the settings or the key.
  Command.provide(KeyStore.layer.pipe(Layer.provideMerge(Settings.layer))),
);

const formatter = CliOutput.defaultFormatter();

// Logs go to stderr: stdout is the command's JSON. No request carries trace headers: the CLI
// exports no traces, so they would only leak ids to the store.
export const CliLayer = Layer.mergeAll(
  CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }),
  CliOutput.layer({
    ...formatter,
    formatError: formatter.formatCliError,
    formatErrors: errors => errors.map(formatter.formatCliError).join('\n'),
    formatVersion: (_name, version) => version,
  }),
  Layer.succeed(Logger.LogToStderr, true),
  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
);
