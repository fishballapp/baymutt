// Access: asking the owner for it, making a narrower machine for a job, revoking, and the log.
import { LabelSchema, type Project } from '@baymutt/api';
import {
  generateMachineToken,
  machineKeyFromToken,
  vouchForProjectKey,
  wrapProjectKey,
} from '@baymutt/keys';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import * as Stream from 'effect/Stream';
import { crypto_, report, usage } from '../errors.ts';
import { Machine } from '../machine.ts';
import { print } from '../output.ts';
import { openProject, resolveProject, trustedKey } from '../projects.ts';
import { projectArgument } from './projects.ts';

const requestCommand = Command.make(
  'request',
  {
    project: projectArgument,
    read: Flag.Boolean('read').pipe(
      Flag.withDescription('Ask to load its values'),
      Flag.withDefault(false),
    ),
    write: Flag.Boolean('write').pipe(
      Flag.withDescription('Ask to set, delete and roll back its values'),
      Flag.withDefault(false),
    ),
    reason: Flag.String('reason').pipe(Flag.withDescription('Why, for the owner to read')),
  },
  Effect.fn('access.request')(function* ({ project, read, write, reason }) {
    if (!read && !write) return yield* usage('Ask for --read, --write or both.');
    const { api } = yield* Machine;
    yield* print(
      yield* api.accessRequests.create({
        payload: {
          id: crypto.randomUUID(),
          projectName: project,
          wantsRead: read,
          wantsWrite: write,
          reason,
        },
      }),
    );
  }, report),
).pipe(
  Command.withDescription(
    'Ask the owner for access to a project. A machine cannot give itself any; the owner approves in the dashboard',
  ),
);

const listRequestsCommand = Command.make(
  'list',
  {},
  Effect.fn('access.list')(function* () {
    const { api } = yield* Machine;
    yield* print(yield* api.accessRequests.list());
  }, report),
).pipe(
  Command.withDescription('This machine’s access requests and how each was answered'),
  Command.withAlias('ls'),
);

export const accessCommand = Command.make('access').pipe(
  Command.withDescription('Ask for access to a project'),
  Command.withSubcommands([requestCommand, listRequestsCommand]),
  Command.provide(Machine.layer),
);

const listMachinesCommand = Command.make(
  'list',
  {},
  Effect.fn('machines.list')(function* () {
    const { api } = yield* Machine;
    yield* print(yield* api.credentials.list());
  }, report),
).pipe(Command.withDescription('This machine and the machines it made'), Command.withAlias('ls'));

/** Hands the new machine's key to `command` on its stdin, and to nothing else. */
const deliver = Effect.fnUntraced(
  function* (command: ReadonlyArray<string>, token: string) {
    const [executable, ...args] = command;
    if (executable === undefined) return yield* Effect.die('deliver was given no command');
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(executable, args, {
        stdin: Stream.make(new TextEncoder().encode(token)),
        stdout: 'inherit',
        stderr: 'inherit',
      }),
    );
    return Number(yield* handle.exitCode);
  },
  Effect.scoped,
  Effect.catchTag('PlatformError', error =>
    Effect.fail(usage(`Could not run the command that takes the key: ${error.message}`)),
  ),
);

const createMachineCommand = Command.make(
  'create',
  {
    name: Flag.String('name').pipe(
      Flag.withDescription('What the machine is, such as "CI: app deploy"'),
      Flag.withSchema(LabelSchema),
    ),
    read: Flag.String('read').pipe(
      Flag.withDescription('A project it may load (repeatable). This machine must be able to'),
      Flag.atLeast(0),
    ),
    write: Flag.String('write').pipe(
      Flag.withDescription('A project it may write (repeatable). This machine must be able to'),
      Flag.atLeast(0),
    ),
    command: Argument.String('command').pipe(
      Argument.withDescription(
        'After `--`: the command that receives the new machine’s key on stdin, such as `gh secret set BAYMUTT_KEY -R owner/repo`',
      ),
      Argument.variadic({ min: 1 }),
    ),
  },
  Effect.fn('machines.create')(function* ({ name, read, write, command }) {
    const machine = yield* Machine;
    const names = [...new Set([...read, ...write])];
    if (names.length === 0) return yield* usage('Give it at least one --read or --write project.');
    const projects = yield* Effect.forEach(names, resolveProject, { concurrency: 4 });

    // The new machine's key carries this machine's public key, so it knows whose proofs to take.
    const token = generateMachineToken(machine.key.publicKey);
    const made = yield* crypto_(() => machineKeyFromToken(token));
    const reader = { id: made.credentialId, publicKey: made.publicKey };
    const grantFor = Effect.fnUntraced(function* (project: Project) {
      const canWrite = write.includes(project.name) || write.includes(project.id);
      const canRead = read.includes(project.name) || read.includes(project.id);
      const { publicKey, binding } = yield* trustedKey(project);
      const keyProof = yield* crypto_(() =>
        vouchForProjectKey({
          voucherKey: machine.key.privateKey,
          reader,
          binding,
          projectPublicKey: publicKey,
        }),
      );
      if (!canRead) return { projectId: project.id, canWrite, readWrap: null, keyProof };
      // A read is the project key wrapped to the new machine, which only a holder of the key
      // can make: this machine opens it and seals it again.
      const { encodedProjectKey } = yield* openProject(project);
      const readWrap = yield* crypto_(() =>
        wrapProjectKey({
          projectPrivateKey: encodedProjectKey,
          readerPublicKey: reader.publicKey,
          readerId: reader.id,
          binding,
        }),
      );
      return { projectId: project.id, canWrite, readWrap, keyProof };
    });
    const created = yield* machine.api.credentials.create({
      payload: {
        id: made.credentialId,
        name,
        publicKey: made.publicKey,
        bearerHash: made.bearerHash,
        grants: yield* Effect.forEach(projects, grantFor, { concurrency: 4 }),
      },
    });

    // A key nobody received is a machine nobody can use: take it back out.
    const exitCode = yield* deliver(command, token).pipe(
      Effect.tapError(() => machine.api.credentials.revoke({ params: { id: created.id } })),
    );
    if (exitCode !== 0) {
      yield* machine.api.credentials.revoke({ params: { id: created.id } });
      return yield* usage(
        `\`${command.join(' ')}\` exited ${exitCode}, so the new machine was revoked. Nothing was left behind.`,
      );
    }
    yield* print(created);
  }, report),
).pipe(
  Command.withDescription(
    'Make a machine that holds part of this one’s access, for a CI job or another agent. Its key goes to the command after `--`, on stdin, and is never printed',
  ),
);

const revokeCommand = Command.make(
  'revoke',
  {
    id: Argument.String('id').pipe(
      Argument.withDescription(
        'The machine’s id (see `baymutt machines`). Omit to revoke this machine itself',
      ),
      Argument.optional,
    ),
  },
  Effect.fn('machines.revoke')(function* ({ id }) {
    const { api, key } = yield* Machine;
    yield* print(
      yield* api.credentials.revoke({
        params: { id: Option.getOrElse(id, () => key.credentialId) },
      }),
    );
  }, report),
).pipe(
  Command.withDescription(
    'Revoke this machine or one it made, with every machine that one made. What it already read stays read: replace those values at their vendors',
  ),
);

export const machinesCommand = Command.make('machines').pipe(
  Command.withDescription('List, make and revoke machines'),
  Command.withSubcommands([listMachinesCommand, createMachineCommand, revokeCommand]),
  Command.provide(Machine.layer),
);

export const auditCommand = Command.make(
  'audit',
  {
    project: Flag.String('project').pipe(
      Flag.withDescription('Only this project’s entries'),
      Flag.optional,
    ),
    limit: Flag.Int('limit').pipe(
      Flag.withDescription('How many entries (1 to 200)'),
      Flag.withDefault(50),
    ),
    before: Flag.String('before').pipe(
      Flag.withDescription(
        'An entry id: answer the entries before it (`nextBefore` of the last page)',
      ),
      Flag.optional,
    ),
  },
  Effect.fn('audit')(function* ({ project, limit, before }) {
    const { api } = yield* Machine;
    const projectId = Option.isSome(project)
      ? (yield* resolveProject(project.value)).id
      : undefined;
    yield* print(
      yield* api.audit.list({
        query: {
          limit,
          ...(projectId === undefined ? {} : { projectId }),
          ...(Option.isSome(before) ? { before: before.value } : {}),
        },
      }),
    );
  }, report),
).pipe(
  Command.withDescription(
    'What this machine did, newest first. The owner reads the whole log in the dashboard',
  ),
  Command.provide(Machine.layer),
);
