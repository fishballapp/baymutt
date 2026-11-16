// `baymutt ask`: everything an agent asks of the owner. A CLI login holds no environment, so
// `ask access` makes a key that holds nothing, keeps it in a file here, and sends a request naming
// whole environments, why, and for how long; approved, the key holds exactly that. `ask
// create-environment` asks for a new environment, `ask paste-link` for one value; `ask wait` and
// `ask cancel` follow and withdraw any of the three.
import { hostname } from 'node:os';
import {
  CommandSchema,
  DescriptionSchema,
  EnvironmentNameSchema,
  LabelSchema,
  LifetimeSchema,
  OrgSlugSchema,
} from '@baymutt/api';
import {
  generateServiceAccountToken,
  serviceAccountKeyFromToken,
  vouchForServiceAccount,
} from '@baymutt/keys';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { durationMs } from '../about.ts';
import { environmentRequestUrl, settleEnvironmentRequest } from '../environment-requests.ts';
import { findEnvironment, listEnvironments } from '../environments.ts';
import { answerFor, crypto_, describeFailure, isRefusal, report, usage } from '../errors.ts';
import { sealNewName } from '../names.ts';
import { print } from '../output.ts';
import { settlePasteLink } from '../paste-links.ts';
import {
  commandLine,
  forgetDeadKeys,
  forgetRequestKey,
  isId,
  keepRequestKey,
  keyFileOf,
  settleRequest,
} from '../requests.ts';
import { ServiceAccount } from '../service-account.ts';
import { Settings } from '../settings.ts';
import { pasteLinkCommand } from './secrets.ts';

const HOUR_MS = 3600 * 1000;

const isSlug = Schema.is(OrgSlugSchema);
const isEnvironmentName = Schema.is(EnvironmentNameSchema);
const isLifetime = Schema.is(LifetimeSchema);
const isCommand = Schema.is(CommandSchema);

/** "Agent on <this computer's name>", within a name's 60 characters. */
const defaultName = () => `Agent on ${hostname().slice(0, 51).trim() || 'this computer'}`;

type Access = { readonly canRead: boolean; readonly canWrite: boolean };

const accessCommand = Command.make(
  'access',
  {
    read: Flag.String('read').pipe(
      Flag.withDescription('An environment to load (repeatable), as <org>/<name>'),
      Flag.atLeast(0),
    ),
    readWrite: Flag.String('read-write').pipe(
      Flag.withDescription('An environment to load and write (repeatable), as <org>/<name>'),
      Flag.atLeast(0),
    ),
    write: Flag.String('write').pipe(
      Flag.withDescription(
        'An environment to write and not read (repeatable), as <org>/<name>. For both, use --read-write',
      ),
      Flag.atLeast(0),
    ),
    reason: Flag.String('reason').pipe(
      Flag.withDescription(
        'Why, 1 to 140 characters, shown to the owner. Stored readable, like a name: never put a secret in it',
      ),
      Flag.withSchema(DescriptionSchema),
    ),
    expires: Flag.String('expires').pipe(
      Flag.withDescription(
        'How long the key works once approved: minutes, hours or days, such as 15m, 1h or 1d. Default: 1h; with a command after --, no end. The owner may change it',
      ),
      Flag.optional,
    ),
    name: Flag.String('name').pipe(
      Flag.withDescription(
        'What the owner sees the key as, up to 60 characters. Default: "Agent on <this computer’s name>"',
      ),
      Flag.withSchema(LabelSchema),
      Flag.optional,
    ),
    command: Argument.String('command').pipe(
      Argument.withDescription(
        'After --: a command that gets the key on its stdin once the owner approves, such as `gh secret set BAYMUTT_KEY -R owner/repo`. The owner sees it before approving',
      ),
      Argument.variadic({ min: 0 }),
    ),
  },
  Effect.fn('ask.access')(function* ({ reason, expires, name, command, ...asked }) {
    const read = [...asked.read, ...asked.readWrite];
    const write = [...asked.write, ...asked.readWrite];
    const serviceAccount = yield* ServiceAccount;
    const { api, key } = serviceAccount;
    if (!serviceAccount.isLogin) {
      return yield* usage(
        '`baymutt ask access` runs from a CLI login (`baymutt auth login`). A service account holds what its request named and asks for nothing more.',
      );
    }
    // The account key pinned at login: the owner's browser trusts the new key because this login vouches for it to that key.
    const account = yield* serviceAccount.pinnedAccount;
    const addresses = [...new Set([...read, ...write])];
    if (addresses.length === 0) {
      return yield* usage('Name at least one environment with --read, --write or --read-write.');
    }
    const lifetime = yield* Option.match(expires, {
      onNone: () => Effect.succeed(command.length === 0 ? HOUR_MS : null),
      onSome: durationMs,
    });
    if (lifetime !== null && !isLifetime(lifetime)) {
      return yield* usage('--expires is between one minute and ten years.');
    }
    const shownCommand = command.length === 0 ? null : commandLine(command);
    if (shownCommand !== null && !isCommand(shownCommand)) {
      return yield* usage(
        'The command after -- is longer than the owner’s screen takes: 500 characters.',
      );
    }

    yield* forgetDeadKeys();

    const { environments } = yield* listEnvironments();
    // One item per environment, however it was named: by its address, by its id, or both.
    const items = new Map<string, Access>();
    for (const address of addresses) {
      const found = findEnvironment(environments, address);
      if (found === undefined) {
        return yield* usage(
          `None of your orgs has an environment ${address}. See them with \`baymutt env list\`. For a new one, run \`baymutt ask create-environment ${address} --reason "<why>"\` first, and ask for access once the owner has created it.`,
          'notFound',
        );
      }
      const before = items.get(found.id);
      items.set(found.id, {
        canRead: read.includes(address) || (before?.canRead ?? false),
        canWrite: write.includes(address) || (before?.canWrite ?? false),
      });
    }

    // The new key names this login as its maker, so it takes the account key this login vouches for.
    const token = generateServiceAccountToken(key.publicKey);
    const made = yield* crypto_(() => serviceAccountKeyFromToken(token));
    const vouchers = yield* crypto_(() =>
      vouchForServiceAccount({
        makerKey: key.privateKey,
        accountId: account.id,
        accountPublicKey: account.publicKey,
        serviceAccount: { id: made.credentialId, publicKey: made.publicKey },
      }),
    );
    // Kept before anything is sent: an approved request whose key was lost is no use to anyone.
    const keyFile = yield* keepRequestKey({
      id: made.credentialId,
      token,
      command: command.length === 0 ? null : command,
    });
    const [first, ...rest] = [...items].map(([environmentId, access]) => ({
      environmentId,
      ...access,
    }));
    if (first === undefined) return yield* Effect.die('a request was built with no items');
    const request = yield* api.requests
      .create({
        payload: {
          id: made.credentialId,
          name: Option.getOrElse(name, defaultName),
          publicKey: made.publicKey,
          bearerHash: made.bearerHash,
          vouchers,
          reason,
          command: shownCommand,
          lifetime,
          items: [first, ...rest],
        },
      })
      .pipe(
        Effect.catch(
          Effect.fnUntraced(function* (error) {
            // The store said no, so there is no request for the key to wait on.
            if (yield* isRefusal(error)) {
              yield* forgetRequestKey(made.credentialId);
              return yield* error;
            }
            // No answer proves nothing: the request may exist, and the owner may approve it.
            const { message, kind } = yield* describeFailure(error);
            return yield* usage(
              `${message} Request ${made.credentialId} may have been made all the same, so its key stays at ${keyFile}: run \`baymutt ask wait ${made.credentialId}\` to pick it up.`,
              kind,
            );
          }),
        ),
        answerFor(made.credentialId),
      );

    const { origin } = yield* Settings;
    yield* print({
      id: request.id,
      status: request.status,
      url: `${origin}/requests/${request.id}`,
      next: `Give the owner the link: the request waits an hour for them. Then run \`baymutt ask wait ${request.id}\`.`,
    });
  }, report),
).pipe(
  Command.withDescription(
    'Ask the owner for access to environments: a new key that holds nothing until the owner approves, then exactly what was asked for. It prints a link for the owner and returns at once; the request waits an hour for them. `baymutt ask wait <id>` then finishes it: with no command, it prints the key file, to use with BAYMUTT_KEY_FILE=<keyFile> or its content as BAYMUTT_KEY inside a sandbox; with a command after --, the key is piped to it and never kept',
  ),
  Command.provide(ServiceAccount.layer),
);

const createEnvironmentCommand = Command.make(
  'create-environment',
  {
    environment: Argument.String('environment').pipe(
      Argument.withDescription(
        'The new environment, its org first: <org>/<name>, such as acme/app/staging',
      ),
    ),
    reason: Flag.String('reason').pipe(
      Flag.withDescription(
        'Why, 1 to 140 characters, shown to the owner. Stored readable, like a name: never put a secret in it',
      ),
      Flag.withSchema(DescriptionSchema),
    ),
  },
  Effect.fn('ask.createEnvironment')(function* ({ environment: address, reason }) {
    const { api, isLogin } = yield* ServiceAccount;
    if (!isLogin) {
      return yield* usage(
        '`baymutt ask create-environment` runs from a CLI login (`baymutt auth login`). A service account holds what its request named and asks for nothing more.',
      );
    }
    const slash = address.indexOf('/');
    const orgSlug = address.slice(0, slash);
    const name = address.slice(slash + 1);
    if (slash === -1 || !isSlug(orgSlug) || !isEnvironmentName(name)) {
      return yield* usage(
        `${address} is not <org>/<name>: an org slug (lower-case letters, digits, hyphens), then lower-case segments joined by /, such as acme/app/staging.`,
      );
    }
    const { environments, namesKeys } = yield* listEnvironments();
    if (findEnvironment(environments, address) !== undefined) {
      return yield* usage(
        `${address} already exists. Ask for access to it with \`baymutt ask access --read ${address} --reason "<why>"\`.`,
        'conflict',
      );
    }
    const { orgs } = yield* api.orgs.list();
    const org = orgs.find(listed => listed.slug === orgSlug);
    if (org === undefined) {
      return yield* usage(
        `You have no org ${orgSlug}. The owner creates orgs in the dashboard.`,
        'notFound',
      );
    }
    const namesKey = namesKeys.get(org.id) ?? null;
    if (org.areNamesSealed && namesKey === null) {
      return yield* usage(
        `The names in ${orgSlug} are sealed, and the store handed this CLI login no copy of their key. Nothing was sent.`,
        'integrity',
      );
    }
    const sealed = yield* sealNewName(namesKey, { scopeId: org.id, name, orgSlug });
    const id = crypto.randomUUID();
    const request = yield* api.environmentRequests
      .create({ payload: { id, orgId: org.id, ...sealed, reason } })
      .pipe(answerFor(id));
    yield* print({
      id: request.id,
      status: request.status,
      environment: address,
      url: yield* environmentRequestUrl(request.id),
      next: `Give the owner the link: the request waits an hour for them. Then run \`baymutt ask wait ${request.id}\`.`,
    });
  }, report),
).pipe(
  Command.withDescription(
    'Ask the owner for a new environment. Nothing is created until the owner approves, and it gives nobody access: once it exists, `baymutt ask access` asks for that. It prints a link for the owner and returns at once; the request waits an hour for them. `baymutt ask wait <id>` then says whether the owner created it',
  ),
  Command.provide(ServiceAccount.layer),
);

const idArgument = Argument.String('id').pipe(
  Argument.withDescription(
    'The id `baymutt ask access`, `baymutt ask create-environment` or `baymutt ask paste-link` printed',
  ),
);

/** `id` as typed, refused unless it is an id: it reaches the store's paths and this computer's files. */
const checkedId = (id: string) =>
  isId(id)
    ? Effect.succeed(id)
    : Effect.fail(usage(`${id} is not an id that \`baymutt ask\` printed: those are UUIDs.`));

/** Nothing this key asked has `id`. A key kept here for it is a request that never reached the store. */
const notAsked = Effect.fn('ask.notAsked')(function* (id: string) {
  const fs = yield* FileSystem.FileSystem;
  const isKept = yield* fs.exists(yield* keyFileOf(id)).pipe(Effect.orDie);
  if (!isKept) return yield* usage(`Nothing this key asked has the id ${id}.`, 'notFound');
  yield* forgetRequestKey(id);
  return yield* usage(
    `Request ${id} never reached the store, so the owner never saw it. Its key was removed from this computer: run \`baymutt ask access\` again.`,
    'notFound',
  );
});

const waitCommand = Command.make(
  'wait',
  {
    id: idArgument,
    timeout: Flag.Int('timeout').pipe(
      Flag.withDescription('Seconds to wait before giving up (what was asked keeps waiting)'),
      Flag.withDefault(900),
    ),
  },
  Effect.fn('ask.wait')(function* ({ id: typed, timeout }) {
    const id = yield* checkedId(typed);
    const { api } = yield* ServiceAccount;
    const request = yield* api.requests.get({ params: { id } }).pipe(
      answerFor(id),
      Effect.asSome,
      Effect.catchTag('NotFoundError', () => Effect.succeedNone),
    );
    if (Option.isSome(request)) return yield* settleRequest(request.value, timeout);
    const environmentRequest = yield* api.environmentRequests.get({ params: { id } }).pipe(
      answerFor(id),
      Effect.asSome,
      Effect.catchTag('NotFoundError', () => Effect.succeedNone),
    );
    if (Option.isSome(environmentRequest)) {
      return yield* settleEnvironmentRequest(environmentRequest.value, timeout);
    }
    const pasteLink = yield* api.pasteLinks.get({ params: { id } }).pipe(
      answerFor(id),
      Effect.asSome,
      Effect.catchTag('NotFoundError', () => Effect.succeedNone),
    );
    if (Option.isNone(pasteLink)) return yield* notAsked(id);
    return yield* settlePasteLink(id, timeout);
  }, report),
).pipe(
  Command.withDescription(
    'Wait until the owner answers what was asked. Exits 9 on timeout. Access: approved, it prints where the key is, or pipes it to the command it was asked for; rejected, or expired unanswered after an hour, the key is removed and it exits 4. A new environment: created, it prints its address; rejected or expired, it exits 4. A paste link: pasted, it prints `fulfilled`; dismissed, or expired, it exits 4',
  ),
  Command.provide(ServiceAccount.layer),
);

const cancelCommand = Command.make(
  'cancel',
  { id: idArgument },
  Effect.fn('ask.cancel')(function* ({ id: typed }) {
    const id = yield* checkedId(typed);
    const { api } = yield* ServiceAccount;
    const request = yield* api.requests.get({ params: { id } }).pipe(
      answerFor(id),
      Effect.asSome,
      Effect.catchTag('NotFoundError', () => Effect.succeedNone),
    );
    if (Option.isSome(request)) {
      // One the owner rejected or nobody answered cannot be withdrawn, and its key is as dead:
      // it goes too. An approved one's key is a service account's, and stays.
      const forgetIfDead = api.requests.get({ params: { id } }).pipe(
        answerFor(id),
        Effect.flatMap(({ status }) =>
          status === 'rejected' || status === 'expired' ? forgetRequestKey(id) : Effect.void,
        ),
        Effect.ignore,
      );
      yield* api.requests.reject({ params: { id } }).pipe(
        answerFor(id),
        Effect.tapError(() => forgetIfDead),
      );
      yield* forgetRequestKey(id);
      return yield* print({ id, status: 'cancelled' });
    }
    const environmentRequest = yield* api.environmentRequests.get({ params: { id } }).pipe(
      answerFor(id),
      Effect.asSome,
      Effect.catchTag('NotFoundError', () => Effect.succeedNone),
    );
    if (Option.isSome(environmentRequest)) {
      yield* api.environmentRequests.reject({ params: { id } }).pipe(answerFor(id));
      return yield* print({ id, status: 'cancelled' });
    }
    yield* api.pasteLinks.cancel({ params: { id } }).pipe(
      answerFor(id),
      Effect.catchTag('NotFoundError', () => notAsked(id)),
    );
    yield* print({ id, status: 'cancelled' });
  }, report),
).pipe(
  Command.withDescription(
    'Withdraw what this key asked and the owner has not answered: it stops waiting and the owner no longer sees it. A request’s key is removed from this computer, and so is the key of one that never reached the store',
  ),
  Command.provide(ServiceAccount.layer),
);

export const askCommand = Command.make('ask').pipe(
  Command.withDescription(
    'Ask the owner: for access to environments, for a new environment, or for one value through a paste link. Each prints a link for the owner and returns at once; `baymutt ask wait <id>` follows the answer and `baymutt ask cancel <id>` withdraws it',
  ),
  Command.withSubcommands([
    accessCommand,
    createEnvironmentCommand,
    pasteLinkCommand,
    waitCommand,
    cancelCommand,
  ]),
);
