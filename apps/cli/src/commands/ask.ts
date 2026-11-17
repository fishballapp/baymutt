// `baymutt ask`: everything an agent asks of the owner. A CLI login holds no environment, so
// `ask access` makes a key that holds nothing, keeps it in a file here, and sends a request naming
// whole environments, why, and for how long; approved, the key holds exactly that. `ask change`
// adds to or gives back from a key this login asked for, on the same key. `ask create-environment`
// asks for a new environment, `ask paste-link` for one value; `ask wait` and `ask cancel` follow
// and withdraw any of them (`ask wait` several at once).
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
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { durationMs } from '../about.ts';
import { checkedId, handOver, notAsked, waitForAsks } from '../asks.ts';
import { environmentRequestUrl } from '../environment-requests.ts';
import { findEnvironment, listEnvironments } from '../environments.ts';
import { answerFor, crypto_, describeFailure, isRefusal, report, usage } from '../errors.ts';
import { forgetAsked, keepAsked, keyChangeUrl, settleKeyChange } from '../key-changes.ts';
import { sealNewName } from '../names.ts';
import { print } from '../output.ts';
import {
  commandLine,
  forgetDeadKeys,
  forgetRequestKey,
  keepRequestKey,
  requestUrl,
} from '../requests.ts';
import { ServiceAccount } from '../service-account.ts';
import { pasteLinkCommand } from './secrets.ts';

const HOUR_MS = 3600 * 1000;

/** What `ask access` tells an agent about the key it will hold: change it, rather than ask for another. */
const withinTask = (id: string) =>
  `Once approved, if this task needs more or less, change this key rather than asking for another: \`baymutt ask change ${id} --read <org>/<name> --reason "<why>"\` (or --give-back <org>/<name>). Ask for a new key only for a different job.`;

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
      Flag.withDescription(
        'An environment to load and write (repeatable), as <org>/<name>. Asks for both in one approval; --read and --write on separate asks cost the owner two',
      ),
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
        '`baymutt ask access` runs from a CLI login (`baymutt auth login`), without BAYMUTT_KEY or BAYMUTT_KEY_FILE. A key holds what its request named and asks for nothing itself; its CLI login asks to change it with `baymutt ask change`.',
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

    // A key belongs to one org; the store refuses one across orgs too, after the key is made.
    const orgSlugs = new Set(
      environments.filter(({ id }) => items.has(id)).map(({ orgSlug }) => orgSlug),
    );
    if (orgSlugs.size > 1) {
      return yield* usage(
        `A key belongs to one org, and these environments are in ${orgSlugs.size}: ${[...orgSlugs].toSorted().join(', ')}. Ask once per org: one \`baymutt ask access\` for each, naming only that org's environments.`,
      );
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

    yield* print({
      id: request.id,
      status: request.status,
      url: yield* requestUrl(request),
      next: `${handOver(request.id)} ${withinTask(request.id)}`,
    });
  }, report),
).pipe(
  Command.withDescription(
    'Ask the owner for access to environments: a new key that holds nothing until the owner approves, then exactly what was asked for. Ask for everything the task needs in one request, and use --read-write for both: each request is one approval for the owner, so two separate asks cost two. Once this task holds a key, change that key with `baymutt ask change <id>` when it needs more or less; ask for a new key only for a different job. It prints a link for the owner and returns at once, and the request waits an hour for them: end your reply to the owner with the link, alone on its last line, since they see only that reply. Run `baymutt ask wait <id>` in the background, or after that reply, never before it: a wait that blocks first hides the link. It finishes the request: with no command, it prints the key file, to use with BAYMUTT_KEY_FILE=<keyFile> or its content as BAYMUTT_KEY inside a sandbox; with a command after --, the key is piped to it and never kept',
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
        '`baymutt ask create-environment` runs from a CLI login (`baymutt auth login`), without BAYMUTT_KEY or BAYMUTT_KEY_FILE. A key holds what its request named and asks for nothing itself.',
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
      url: yield* environmentRequestUrl(request),
      next: handOver(request.id),
    });
  }, report),
).pipe(
  Command.withDescription(
    'Ask the owner for a new environment. Nothing is created until the owner approves, and it gives nobody access: once it exists, `baymutt ask access` asks for that. It prints a link for the owner and returns at once, and the request waits an hour for them: end your reply to the owner with the link, alone on its last line, since they see only that reply. Run `baymutt ask wait <id>` in the background, or after that reply, never before it: a wait that blocks first hides the link. It says whether the owner created it',
  ),
  Command.provide(ServiceAccount.layer),
);

const changeCommand = Command.make(
  'change',
  {
    key: Argument.String('key').pipe(
      Argument.withDescription(
        'The id of the key to change: the one `baymutt ask access` printed (for an agent key, its key file’s name; see `baymutt key list`)',
      ),
    ),
    read: Flag.String('read').pipe(
      Flag.withDescription('An environment to add, to load (repeatable), as <org>/<name>'),
      Flag.atLeast(0),
    ),
    readWrite: Flag.String('read-write').pipe(
      Flag.withDescription(
        'An environment to add, to load and write (repeatable), as <org>/<name>',
      ),
      Flag.atLeast(0),
    ),
    write: Flag.String('write').pipe(
      Flag.withDescription(
        'An environment to add, to write and not read (repeatable), as <org>/<name>',
      ),
      Flag.atLeast(0),
    ),
    giveBack: Flag.String('give-back').pipe(
      Flag.withDescription(
        'An environment the key holds and no longer needs (repeatable), as <org>/<name>: all its access there goes',
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
        'A new end, counted from the owner’s approval: minutes, hours or days, such as 15m, 1h or 1d. Default: the key keeps its end. The owner may change it',
      ),
      Flag.optional,
    ),
  },
  Effect.fn('ask.change')(function* ({ key: typed, reason, expires, giveBack, ...asked }) {
    const { api, isLogin } = yield* ServiceAccount;
    if (!isLogin) {
      return yield* usage(
        '`baymutt ask change` runs from the CLI login that asked for the key (`baymutt auth login`), without BAYMUTT_KEY or BAYMUTT_KEY_FILE. A key asks for nothing itself.',
      );
    }
    const keyId = yield* checkedId(typed);
    const read = [...asked.read, ...asked.readWrite];
    const write = [...asked.write, ...asked.readWrite];
    const lifetime = yield* Option.match(expires, {
      onNone: () => Effect.succeed(null),
      onSome: durationMs,
    });
    if (lifetime !== null && !isLifetime(lifetime)) {
      return yield* usage('--expires is between one minute and ten years.');
    }
    if (read.length + write.length + giveBack.length === 0 && lifetime === null) {
      return yield* usage(
        'Name what changes: --read, --write or --read-write to add, --give-back to give back, or --expires for a new end.',
      );
    }
    const [{ credentials }, { environments }] = yield* Effect.all(
      [api.credentials.list(), listEnvironments()],
      { concurrency: 2 },
    );
    const key = credentials.find(({ id, parentId }) => id === keyId && parentId !== null);
    if (key === undefined) {
      return yield* usage(
        `No key this CLI login asked for has the id ${keyId}: it was revoked, or its request is still waiting or was not approved. See them with \`baymutt key list\`.`,
        'notFound',
      );
    }
    // Whether its file is here decides, at \`ask wait\`, whether it is checked with the key or only
    // against the store's listing; what the store calls the key decides nothing.
    const resolve = (address: string) =>
      Effect.fromNullishOr(findEnvironment(environments, address)).pipe(
        Effect.mapError(() =>
          usage(
            `None of your orgs has an environment ${address}. See them with \`baymutt env list\`. For a new one, run \`baymutt ask create-environment ${address} --reason "<why>"\` first.`,
            'notFound',
          ),
        ),
      );
    const add = new Map<string, Access>();
    for (const address of new Set([...read, ...write])) {
      const found = yield* resolve(address);
      if (key.org !== null && found.orgId !== key.org.id) {
        return yield* usage(
          `Key ${keyId} belongs to ${key.org.slug}, and a key holds environments of its own org only: ${address} is not one. Ask for a key in its org with \`baymutt ask access\`.`,
        );
      }
      const before = add.get(found.id);
      add.set(found.id, {
        canRead: read.includes(address) || (before?.canRead ?? false),
        canWrite: write.includes(address) || (before?.canWrite ?? false),
      });
    }
    for (const [environmentId, access] of add) {
      const held = key.grants.find(grant => grant.environmentId === environmentId);
      // Asking for what it holds already is dropped; asking only for that is refused below.
      add.set(environmentId, {
        canRead: access.canRead && !(held?.canRead ?? false),
        canWrite: access.canWrite && !(held?.canWrite ?? false),
      });
      if (!add.get(environmentId)?.canRead && !add.get(environmentId)?.canWrite) {
        add.delete(environmentId);
      }
    }
    const back = new Set<string>();
    for (const address of giveBack) {
      const found = yield* resolve(address);
      if (!key.grants.some(grant => grant.environmentId === found.id)) {
        return yield* usage(
          `Key ${keyId} holds nothing on ${address}, so there is nothing to give back. See what it holds with \`baymutt key list\`.`,
        );
      }
      if (add.has(found.id)) {
        return yield* usage(`${address} is both added and given back: name it once.`);
      }
      back.add(found.id);
    }
    if (add.size === 0 && back.size === 0 && lifetime === null) {
      return yield* usage(
        `Key ${keyId} already holds everything named, so nothing would change. See what it holds with \`baymutt key list\`.`,
        'conflict',
      );
    }

    const id = crypto.randomUUID();
    const record = {
      keyId,
      add: [...add].map(([environmentId, access]) => ({ environmentId, ...access })),
      giveBack: [...back],
      asksNewEnd: lifetime !== null,
    };
    // Kept before it is sent: `ask wait` checks the key against what was asked here.
    yield* keepAsked(id, record);
    const change = yield* api.keyChanges
      .create({
        payload: { id, keyId, reason, lifetime, add: record.add, giveBack: record.giveBack },
      })
      .pipe(
        Effect.tapError(
          Effect.fnUntraced(function* (error) {
            // The store said no, so nothing will be answered; with no answer, it may have been made.
            if (yield* isRefusal(error)) yield* forgetAsked(id);
          }),
        ),
        answerFor(id),
      );
    if (change.status !== 'pending') {
      // Giving back alone took effect: nothing waits for the owner.
      const outcome = yield* settleKeyChange(id, change, 0);
      if (outcome.kind !== 'granted') return yield* outcome.failure;
      return yield* print(outcome.result);
    }
    yield* print({
      id: change.id,
      status: change.status,
      key: keyId,
      url: yield* keyChangeUrl(change),
      next: `${handOver(change.id)} Until the owner answers, the key keeps working with what it holds; approved, the same key holds the new set.`,
    });
  }, report),
).pipe(
  Command.withDescription(
    'Ask the owner to change a key this task already holds, instead of asking for another: add environments or access with --read, --write or --read-write, give back what it no longer needs with --give-back, and ask for a new end with --expires. The key file keeps working throughout, and holds the new set once the change takes effect. Giving back alone needs no approval and takes effect at once. Anything else prints a link for the owner, who approves it all or none, and returns at once; it waits an hour for them. End your reply to the owner with the link, alone on its last line, since they see only that reply, and run `baymutt ask wait <id>` in the background or after that reply. Rejected or expired, the key holds what it held. A service account this CLI login asked for (one piped into a command) is changed the same way; its key is not on this computer, so `ask wait` checks only the store’s account of what it holds against what was asked, and says what it could not check. Ask for a new key with `baymutt ask access` only for a different job',
  ),
  Command.provide(ServiceAccount.layer),
);

const idArgument = Argument.String('id').pipe(
  Argument.withDescription(
    'The id `baymutt ask access`, `baymutt ask change`, `baymutt ask create-environment` or `baymutt ask paste-link` printed',
  ),
);

const waitCommand = Command.make(
  'wait',
  {
    ids: idArgument.pipe(
      Argument.withDescription(
        'The id or ids `baymutt ask access`, `baymutt ask change`, `baymutt ask create-environment` or `baymutt ask paste-link` printed, of any kind, to wait for together',
      ),
      Argument.variadic({ min: 1 }),
    ),
    timeout: Flag.Int('timeout').pipe(
      Flag.withDescription(
        'Seconds to wait before giving up, for all of them together (what was asked keeps waiting)',
      ),
      Flag.withDefault(900),
    ),
  },
  Effect.fn('ask.wait')(function* ({ ids, timeout }) {
    return yield* waitForAsks(ids, timeout);
  }, report),
).pipe(
  Command.withDescription(
    'Wait until the owner answers what was asked: one id, or several, of any kind, together. Run it in the background, or after the reply that gives the owner the link: a wait that blocks first hides the link. One id: an object, and exit 9 on timeout. Access: approved, it prints where the key is, or pipes it to the command it was asked for; rejected, or expired unanswered after an hour, the key is removed and it exits 4. A key change: approved, it checks the key holds what was added and prints what it holds now; rejected or expired, the key holds what it held, keeps working, and it exits 4. A new environment: created, it prints its address; rejected or expired, it exits 4. A paste link: pasted, it prints `fulfilled`; dismissed, or expired, it exits 4. Several ids: one JSON line each, as it is answered (the same object, or `{id, status, error}` when it was not granted); exit 0 when every one was granted, else 9 if any is still open (wait again for those), else the code of the first, in the order given, that was not',
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
    const keyChange = yield* api.keyChanges.get({ params: { id } }).pipe(
      answerFor(id),
      Effect.asSome,
      Effect.catchTag('NotFoundError', () => Effect.succeedNone),
    );
    if (Option.isSome(keyChange)) {
      // The key it would have changed stays as it is, and so does its file.
      yield* api.keyChanges.reject({ params: { id } }).pipe(answerFor(id));
      return yield* print({ id, status: 'cancelled', key: keyChange.value.key.id });
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
    'Withdraw what this key asked and the owner has not answered: it stops waiting and the owner no longer sees it. A request’s key is removed from this computer, and so is the key of one that never reached the store; a key change’s key stays as it was',
  ),
  Command.provide(ServiceAccount.layer),
);

export const askCommand = Command.make('ask').pipe(
  Command.withDescription(
    'Ask the owner: for access to environments, to change a key this task holds, for a new environment, or for one value through a paste link. Within a task, change the key you hold (`baymutt ask change`) rather than asking for another; ask for a new key only for a different job. Each prints a link for the owner and returns at once. The owner sees only your reply to them, so end that reply with the link, alone on its last line, and run `baymutt ask wait <id> [<id>…]` in the background or after that reply: a wait that blocks first hides the link. One wait follows any number of asks together; `baymutt ask cancel <id>` withdraws one',
  ),
  Command.withSubcommands([
    accessCommand,
    changeCommand,
    createEnvironmentCommand,
    pasteLinkCommand,
    waitCommand,
    cancelCommand,
  ]),
);
