// Service accounts: making a narrower one for a job, changing what it holds, revoking; and the log.
import { LabelSchema, type ServiceAccount as Listed, type Project } from '@baymutt/api';
import {
  generateServiceAccountToken,
  serviceAccountKeyFromToken,
  vouchedServiceAccountKey,
  vouchForProjectKey,
  vouchForServiceAccount,
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
import { aboutFlags, aboutPayload } from '../about.ts';
import { crypto_, report, usage } from '../errors.ts';
import { print } from '../output.ts';
import { openProject, resolveProject, trustedKey } from '../projects.ts';
import { ServiceAccount } from '../service-account.ts';

const listServiceAccountsCommand = Command.make(
  'list',
  {},
  Effect.fn('service-accounts.list')(function* () {
    const { api } = yield* ServiceAccount;
    yield* print(yield* api.credentials.list());
  }, report),
).pipe(
  Command.withDescription('This service account and the service accounts it made'),
  Command.withAlias('ls'),
);

/** Hands the new service account's key to `command` on its stdin, and to nothing else. */
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

const createServiceAccountCommand = Command.make(
  'create',
  {
    name: Flag.String('name').pipe(
      Flag.withDescription('Its name, up to 60 characters, such as "deploy"'),
      Flag.withSchema(LabelSchema),
    ),
    read: Flag.String('read').pipe(
      Flag.withDescription(
        'A project it may load (repeatable). This service account must be able to',
      ),
      Flag.atLeast(0),
    ),
    write: Flag.String('write').pipe(
      Flag.withDescription(
        'A project it may write (repeatable). This service account must be able to',
      ),
      Flag.atLeast(0),
    ),
    command: Argument.String('command').pipe(
      Argument.withDescription(
        'After `--`: the command that receives the new service account’s key on stdin, such as `gh secret set BAYMUTT_KEY -R owner/repo`',
      ),
      Argument.variadic({ min: 1 }),
    ),
    ...aboutFlags,
  },
  Effect.fn('service-accounts.create')(function* ({
    name,
    read,
    write,
    command,
    description,
    expires,
  }) {
    const serviceAccount = yield* ServiceAccount;
    const names = [...new Set([...read, ...write])];
    if (names.length === 0) return yield* usage('Give it at least one --read or --write project.');
    const projects = yield* Effect.forEach(names, resolveProject, { concurrency: 4 });

    // The new service account's key carries this service account's public key, so it knows whose proofs to take.
    const token = generateServiceAccountToken(serviceAccount.key.publicKey);
    const made = yield* crypto_(() => serviceAccountKeyFromToken(token));
    const reader = { id: made.credentialId, publicKey: made.publicKey };
    const grantFor = Effect.fnUntraced(function* (project: Project) {
      const canWrite = write.includes(project.name) || write.includes(project.id);
      const canRead = read.includes(project.name) || read.includes(project.id);
      const { publicKey, binding } = yield* trustedKey(project);
      const keyProof = yield* crypto_(() =>
        vouchForProjectKey({
          voucherKey: serviceAccount.key.privateKey,
          reader,
          binding,
          projectPublicKey: publicKey,
        }),
      );
      if (!canRead) return { projectId: project.id, canWrite, readWrap: null, keyProof };
      // A read is the project key wrapped to the new service account, which only a holder of the key
      // can make: this service account opens it and seals it again.
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
    const about = yield* aboutPayload({ description, expires });
    // This login vouches for the new key, so its access can change later without anyone taking
    // the store's word for it. Only with an account key learned at pairing, never the store's.
    const account = yield* serviceAccount.account;
    const vouchers = account.isPinned
      ? yield* crypto_(() =>
          vouchForServiceAccount({
            makerKey: serviceAccount.key.privateKey,
            accountId: account.id,
            accountPublicKey: account.publicKey,
            serviceAccount: reader,
          }),
        )
      : undefined;
    const created = yield* serviceAccount.api.credentials.create({
      payload: {
        ...about,
        id: made.credentialId,
        name,
        publicKey: made.publicKey,
        bearerHash: made.bearerHash,
        grants: yield* Effect.forEach(projects, grantFor, { concurrency: 4 }),
        ...(vouchers === undefined ? {} : { vouchers }),
      },
    });

    // A key nobody received is a service account nobody can use: take it back out.
    const exitCode = yield* deliver(command, token).pipe(
      Effect.tapError(() => serviceAccount.api.credentials.revoke({ params: { id: created.id } })),
    );
    if (exitCode !== 0) {
      yield* serviceAccount.api.credentials.revoke({ params: { id: created.id } });
      return yield* usage(
        `\`${command.join(' ')}\` exited ${exitCode}, so the new service account was revoked. Nothing was left behind.`,
      );
    }
    yield* print(created);
  }, report),
).pipe(
  Command.withDescription(
    'Make a service account that holds only the projects named here, with the access given. It cannot widen its own access, and makes no others; this login and the owner can change it later. Its key goes to the command after `--`, on stdin, and is never printed',
  ),
);

/**
 * Its access to one project, as it is to become, ready to send. A read or a project it gains needs
 * its key, as this login vouched for it. Nothing is written here, so a refusal changes nothing.
 */
const accessOn = Effect.fnUntraced(function* (
  target: Listed,
  reader: { readonly id: string; readonly publicKey: string } | null,
  project: Project,
  { canRead, canWrite }: { readonly canRead: boolean; readonly canWrite: boolean },
) {
  const serviceAccount = yield* ServiceAccount;
  const held = target.grants.find(grant => grant.projectId === project.id);
  const gainsProject = held === undefined;
  const gainsRead = canRead && !held?.canRead;
  if ((gainsProject || gainsRead) && reader === null) {
    return yield* usage(
      `Nothing vouches for ${target.name}’s key: a CLI before 0.4.0 made it. It can lose access, and can gain only write on a project it already holds.`,
      'integrity',
    );
  }
  const keyProof =
    gainsProject && reader !== null
      ? yield* Effect.gen(function* () {
          const { publicKey, binding } = yield* trustedKey(project);
          return yield* crypto_(() =>
            vouchForProjectKey({
              voucherKey: serviceAccount.key.privateKey,
              reader,
              binding,
              projectPublicKey: publicKey,
            }),
          );
        })
      : undefined;
  // A read is the project key wrapped to it, which only a holder of the key can make.
  const readWrap =
    gainsRead && reader !== null
      ? yield* Effect.gen(function* () {
          const { encodedProjectKey, binding } = yield* openProject(project);
          return yield* crypto_(() =>
            wrapProjectKey({
              projectPrivateKey: encodedProjectKey,
              readerPublicKey: reader.publicKey,
              readerId: reader.id,
              binding,
            }),
          );
        })
      : undefined;
  return {
    params: { id: target.id, projectId: project.id },
    payload: {
      canRead,
      canWrite,
      ...(readWrap === undefined ? {} : { readWrap }),
      ...(keyProof === undefined ? {} : { keyProof }),
    },
  };
});

const changeAccessCommand = Command.make(
  'access',
  {
    id: Argument.String('id').pipe(
      Argument.withDescription(
        'The id of a service account this login made (see `baymutt service-accounts`)',
      ),
    ),
    read: Flag.String('read').pipe(
      Flag.withDescription(
        'A project it may load (repeatable). Each project named gets exactly the access given here',
      ),
      Flag.atLeast(0),
    ),
    write: Flag.String('write').pipe(
      Flag.withDescription('A project it may write (repeatable)'),
      Flag.atLeast(0),
    ),
    remove: Flag.String('remove').pipe(
      Flag.withDescription('A project it loses (repeatable)'),
      Flag.atLeast(0),
    ),
  },
  Effect.fn('service-accounts.access')(function* ({ id, read, write, remove }) {
    const serviceAccount = yield* ServiceAccount;
    const names = [...new Set([...read, ...write])];
    if (names.length === 0 && remove.length === 0) {
      return yield* usage('Name at least one --read, --write or --remove project.');
    }
    const { credentials } = yield* serviceAccount.api.credentials.list();
    const target = credentials.find(listed => listed.id === id);
    if (target?.parentId !== serviceAccount.key.credentialId) {
      return yield* usage(
        `This login made no service account with id ${id}. See the ones it made with \`baymutt service-accounts\`.`,
        'notFound',
      );
    }
    // Its key as this login vouched for it when it made it, never as the store lists it.
    const account = yield* serviceAccount.account;
    const reader =
      target.keyVoucher === null
        ? null
        : yield* crypto_(() =>
            vouchedServiceAccountKey({
              readerKey: serviceAccount.key.privateKey,
              makerPublicKey: serviceAccount.key.publicKey,
              accountId: account.id,
              serviceAccount: target,
            }),
          );
    // Resolved before anything is written: one project may be named twice, by name and by id.
    const given = new Map<string, { project: Project; canRead: boolean; canWrite: boolean }>();
    for (const name of names) {
      const project = yield* resolveProject(name);
      const before = given.get(project.id);
      given.set(project.id, {
        project,
        canRead: (before?.canRead ?? false) || read.includes(name),
        canWrite: (before?.canWrite ?? false) || write.includes(name),
      });
    }
    const removed = yield* Effect.forEach(remove, resolveProject);
    const clash = removed.find(project => given.has(project.id));
    if (clash !== undefined) return yield* usage(`${clash.name} is both given and removed.`);
    const prepared = yield* Effect.forEach([...given.values()], ({ project, canRead, canWrite }) =>
      accessOn(target, reader, project, { canRead, canWrite }),
    );
    yield* Effect.forEach(prepared, request => serviceAccount.api.credentials.setAccess(request));
    yield* Effect.forEach(removed, project =>
      serviceAccount.api.credentials.removeAccess({
        params: { id: target.id, projectId: project.id },
      }),
    );
    const { credentials: after } = yield* serviceAccount.api.credentials.list();
    yield* print(after.find(listed => listed.id === id) ?? null);
  }, report),
).pipe(
  Command.withDescription(
    'Change what a service account this login made can reach, keeping its key: give it a project, change read or write on one, or take one away. It cannot change its own access',
  ),
);

const revokeCommand = Command.make(
  'revoke',
  {
    id: Argument.String('id').pipe(
      Argument.withDescription(
        'The service account’s id (see `baymutt service-accounts`). To revoke this computer’s own login and forget its key, use `baymutt logout`',
      ),
    ),
  },
  Effect.fn('service-accounts.revoke')(function* ({ id }) {
    const { api } = yield* ServiceAccount;
    yield* print(yield* api.credentials.revoke({ params: { id } }));
  }, report),
).pipe(
  Command.withDescription(
    'Revoke a service account this one made, or this one itself by its id, with every service account it made. What it already read stays read: replace those values at their vendors',
  ),
);

export const serviceAccountsCommand = Command.make('service-accounts').pipe(
  Command.withDescription('List, make, change and revoke service accounts'),
  Command.withSubcommands([
    listServiceAccountsCommand,
    createServiceAccountCommand,
    changeAccessCommand,
    revokeCommand,
  ]),
  Command.provide(ServiceAccount.layer),
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
    const { api } = yield* ServiceAccount;
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
    'What this service account did, newest first. The owner reads the whole log in the dashboard',
  ),
  Command.provide(ServiceAccount.layer),
);
