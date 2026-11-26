// `baymutt ask`: the one way an agent asks the owner for anything. It reads an ask (a reason and
// ordered steps, as JSON), resolves and seals it here, keeps what it will need, and sends it;
// `ask wait` follows it to the owner's answers and `ask cancel` withdraws it.
import { MAX_ASK_ITEMS, MAX_ASK_STEPS, MAX_STEP_ITEMS } from '@baymutt/api';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Stdio from 'effect/Stdio';
import * as Stream from 'effect/Stream';
import { cancelAsk, followAsk, waitForAsk } from '../ask-answers.ts';
import { checkAsk } from '../ask-check.ts';
import { decodeAskDocument } from '../ask-document.ts';
import { holdingAsk } from '../ask-lock.ts';
import { makeAsk } from '../ask-making.ts';
import { ASK_JSON_SCHEMA } from '../ask-schema.ts';
import { askUrl, checkAnswer, checkedId, forgetAsk, keepAsk, nextAfterSending } from '../asks.ts';
import { answerFor, describeFailure, isRefusal, report, usage } from '../errors.ts';
import { forgetDeadKeys, forgetKey, keepKey } from '../key-files.ts';
import { print, printLine } from '../output.ts';
import { ServiceAccount } from '../service-account.ts';

/** One ask with every step type, laid out one item per line: what `baymutt ask --help` shows. */
export const EXAMPLE_ASK = `{
  "reason": "Set up the preview deploy of the shop",
  "steps": [
    { "type": "environments", "items": [
      { "op": "create", "environment": "acme/shop/preview" },
      { "op": "delete", "environment": "acme/shop/scratch" },
      { "op": "restore", "environment": "acme/shop/archive" }
    ] },
    { "type": "secrets", "items": [
      { "op": "set", "environment": "acme/shop/preview", "name": "DATABASE_URL", "from": { "dotenv": ".env.preview", "key": "DB_URL" } },
      { "op": "set", "environment": "acme/shop/preview", "name": "SIGNING_KEY", "from": { "file": "keys/preview.pem" } },
      { "op": "set", "environment": "acme/shop/preview", "name": "SENTRY_DSN", "from": { "env": "SENTRY_DSN" } },
      { "op": "paste", "environment": "acme/shop/preview", "name": "STRIPE_SECRET_KEY", "hint": "Stripe dashboard, Developers, API keys" },
      { "op": "generate", "environment": "acme/shop/preview", "name": "SESSION_SECRET" },
      { "op": "rollback", "environment": "acme/shop/staging", "name": "API_TOKEN", "version": 3 },
      { "op": "delete", "environment": "acme/shop/staging", "name": "OLD_TOKEN" },
      { "op": "restore", "environment": "acme/shop/staging", "name": "LEGACY_TOKEN" }
    ] },
    { "type": "access", "reason": "Deploy the preview from this session", "read": ["acme/shop/preview"], "expires": "2h" },
    { "type": "access", "read": ["acme/shop/preview"], "name": "Preview CI", "command": ["gh", "secret", "set", "BAYMUTT_KEY", "-R", "acme/shop"] },
    { "type": "change", "key": "0b0e7a52-6f3c-4c58-9a51-3f0f7a0c1d11", "read": ["acme/shop/staging"], "giveBack": ["acme/shop/old"], "expires": "1d" }
  ]
}`;

const DESCRIPTION = [
  'Ask the owner for anything, in one ask: `baymutt ask ask.json`, or the ask on stdin (`baymutt ask < ask.json`). An ask is JSON: a reason, and steps in the order they are to happen, all in one org. Ask for everything the task needs in one ask: the owner decides each step on one page, so one ask costs them one visit.',
  '`baymutt ask` waits for the owner, so run it in the background. It sends the ask, prints the ask id and the link at once, then keeps running, up to an hour for each step, and prints one line per step as the owner answers it, with its key file when it is a key. The owner sees only what you write to them, not this output: show them the link once, alone on the last line of your final reply for this turn. Do not send it in an earlier message, do not block on this command first (a command that blocks hides the link until it ends), and if you already showed it, do not repeat it; after several asks, their links end that reply, one on each line. If it is stopped, `baymutt ask wait <id>` picks up every answer and key: nothing is lost. `--no-wait` sends, prints and returns at once; `baymutt ask wait <id>` does the waiting then, in the background or after your reply.',
  `Steps: \`environments\` (create, delete or restore environments), \`access\` (a new key that reads environments: kept in a file here, or with \`command\`, piped into that command once approved), \`change\` (add reads to a key this login asked for, give some back, or a new end: \`read\`, \`giveBack\` and \`expires\` are each optional, and one is needed) and \`secrets\` (set a value from a file, an env variable or a dotenv file on this computer; ask the owner to paste one, with a hint where to find it; generate a random one; delete, restore or roll one back). Environments are full addresses, <org>/<name>, where the name may have more segments (acme/shop/preview); a step may name one an earlier step creates or restores, and names each environment once (a \`secrets\` step, each secret once): to delete one and make it again, use two \`environments\` steps. A secret’s name is letters, digits and underscores, not starting with a digit. On a \`change\`, \`read\` names only what to add. A \`rollback\` takes a version number: \`baymutt secret history\` lists them. \`reason\` on a step is optional, and so is \`name\` on \`access\`: what the owner sees the key as. At most ${MAX_ASK_STEPS} steps, ${MAX_STEP_ITEMS} items in a step and ${MAX_ASK_ITEMS} across the ask.`,
  '`expires` is a number then `m`, `h` or `d` (`30m`, `12h`, `14d`), or `"never"`, on any key; a lifetime is between one minute and ten years. It is counted from when the owner approves the step, on a `change` too, where it replaces the key’s end rather than adding to it. Omitted, `access` lasts 1h (no end with a `command`) and `change` keeps the end. To end a key now, `baymutt key revoke <id>`.',
  'An ask never holds a value, not even one you were told in chat, and not in a `reason`, which the store can read: ask the owner to `paste` it, or `set` it from where it already is on this computer (`file`, `env`, or `dotenv`, whose variable is the secret’s name unless `key` names another). It is read here and sealed so only the owner opens it. A relative path is from the current directory.',
  'It prints the ask id, a link for the owner and each step’s status first, then what `baymutt ask wait` prints (see `baymutt ask wait --help`): the key file of an approved `access` step, or the command its key is piped into, and an exit code that says how it ended. Each step waits an hour for the owner.',
  '`baymutt ask schema` prints the format of an ask as JSON Schema. `baymutt ask --check ask.json` checks an ask without sending it, with no login and no network.',
  `Example ask, with every step type:\n${EXAMPLE_ASK}`,
  'An ask file named exactly `wait`, `cancel` or `schema` is read as that subcommand: write `./wait`.',
].join('\n\n');

/** The ask as written: from `file`, or from stdin when no file is named. */
const askText = Effect.fnUntraced(function* (file: Option.Option<string>) {
  if (Option.isSome(file)) {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .readFileString(file.value)
      .pipe(
        Effect.catchReason('PlatformError', 'NotFound', () =>
          Effect.fail(usage(`There is no ask at ${file.value}.`, 'notFound')),
        ),
      );
  }
  const stdio = yield* Stdio.Stdio;
  if (yield* stdio.stdinIsTerminal) {
    return yield* usage(
      'Give the ask as a file, `baymutt ask ask.json`, or on stdin, `baymutt ask < ask.json`. See `baymutt ask --help` for one.',
    );
  }
  return yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString, Effect.orDie);
});

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const;

/** `--timeout` as milliseconds: 0, or a count of seconds, minutes or hours. */
const timeoutMs = (text: string) => {
  const { count, unit } = /^(?<count>0|[1-9][0-9]{0,4})(?<unit>[smh])?$/u.exec(text)?.groups ?? {};
  if (count === '0') return Option.some(0);
  if (count === undefined || (unit !== 's' && unit !== 'm' && unit !== 'h')) return Option.none();
  return Option.some(Number(count) * UNIT_MS[unit]);
};

const timeoutFlag = Flag.String('timeout').pipe(
  Flag.withDescription(
    'How long to wait before giving up, such as 30s, 15m or 1h; 1h by default, the life of an ask (the ask keeps waiting for the owner)',
  ),
  Flag.withDefault('1h'),
  Flag.filterMap(timeoutMs, text => `Expected a duration such as 30s, 15m or 1h, not "${text}"`),
);

const idArgument = Argument.String('id').pipe(
  Argument.withDescription('The ask id `baymutt ask` printed'),
);

const waitCommand = Command.make(
  'wait',
  { id: idArgument, timeout: timeoutFlag },
  Effect.fn('ask.wait')(function* ({ id, timeout }) {
    return yield* waitForAsk(yield* checkedId(id), timeout);
  }, report),
).pipe(
  Command.withDescription(
    'The wait `baymutt ask` itself ends with, for picking an ask up after that was stopped, or after `--no-wait`. Wait until the owner has answered every step of an ask, finishing each and printing its JSON line as it is answered: a key is in hand the moment its step is approved. A line has its index, type, status, and the owner’s note when there is one. An approved `access` step prints its key file (use it as BAYMUTT_KEY_FILE=<keyFile>, or its content as BAYMUTT_KEY inside a sandbox), or is piped into its command; an approved `change` prints what the key holds now. Exit 0 when every step was approved or applied; 9 while any still waits at the timeout (wait again: the steps answered so far are done); 4 when one was rejected, withdrawn or expired, after every step has printed so you see which went through. Only one baymutt process waits on an ask at a time: a second one exits 6 and says which',
  ),
  Command.withShortDescription(
    'Wait until the owner has answered every step of an ask, then print each step’s result',
  ),
  Command.provide(ServiceAccount.layer),
);

const cancelCommand = Command.make(
  'cancel',
  { id: idArgument },
  Effect.fn('ask.cancel')(function* ({ id }) {
    return yield* cancelAsk(yield* checkedId(id));
  }, report),
).pipe(
  Command.withDescription(
    'Withdraw an ask: every step the owner has not answered is cancelled, and the keys it would have made are removed from this computer. A step already answered stays answered',
  ),
  Command.provide(ServiceAccount.layer),
);

const schemaCommand = Command.make(
  'schema',
  {},
  Effect.fn('ask.schema')(function* () {
    yield* print(ASK_JSON_SCHEMA);
  }, report),
).pipe(
  Command.withDescription(
    'Print the format of an ask as JSON Schema: every field, what it means, and its limits. Needs no login and no network',
  ),
);

/** The ask sent to the store, for the login it is run from. */
const send = Effect.fn('ask.send')(function* ({
  file,
  shouldWait,
  timeout,
}: {
  readonly file: Option.Option<string>;
  readonly shouldWait: boolean;
  readonly timeout: number;
}) {
  const decoded = decodeAskDocument(yield* askText(file));
  if (Result.isFailure(decoded)) return yield* usage(decoded.failure);
  const { isLogin, api } = yield* ServiceAccount;
  if (!isLogin) {
    return yield* usage(
      '`baymutt ask` runs from a CLI login (`baymutt auth login`), without BAYMUTT_KEY or BAYMUTT_KEY_FILE. A key reads what it was given and asks for nothing itself.',
    );
  }
  yield* forgetDeadKeys();
  const { payload, kept, keys } = yield* makeAsk(decoded.success);
  // Kept before anything is sent: an approved key whose file was lost is no use to anyone.
  yield* Effect.forEach(keys, keepKey, { concurrency: 1, discard: true });
  yield* keepAsk(kept);
  const forgetAll = Effect.andThen(
    Effect.forEach(keys, ({ id }) => forgetKey(id), { concurrency: 1, discard: true }),
    forgetAsk(payload.id),
  );
  const ask = yield* api.asks.create({ payload }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (error) {
        // The store said no, so there is no ask for the keys to wait on.
        if (yield* isRefusal(error)) {
          yield* forgetAll;
          return yield* error;
        }
        // No answer proves nothing: the ask may exist, and the owner may approve it.
        const { message, kind } = yield* describeFailure(error);
        return yield* usage(
          `${message} Ask ${payload.id} may have been made all the same, so what it needs stays on this computer: run \`baymutt ask wait ${payload.id}\` to follow it.`,
          kind,
        );
      }),
    ),
    answerFor(payload.id),
    Effect.flatMap(answer => checkAnswer(kept, answer)),
  );
  const isPending = ask.steps.some(({ status }) => status === 'pending');
  const sent = Effect.gen(function* () {
    // Printed before anything waits: the agent hands the owner the link while this keeps running.
    yield* print({
      id: ask.id,
      status: isPending ? 'pending' : 'answered',
      url: yield* askUrl(ask),
      steps: ask.steps.map(({ index, type, status }) => ({ index, type, status })),
      next: nextAfterSending({ id: ask.id, isPending, shouldWait }),
    });
  });
  if (!shouldWait) return yield* sent;
  // Held before the id is printed, so no `ask wait` the agent runs from habit can take it first.
  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* holdingAsk(ask.id);
      yield* sent;
      yield* followAsk(ask.id, timeout);
    }),
  );
});

export const askCommand = Command.make(
  'ask',
  {
    ask: Argument.String('ask.json').pipe(
      Argument.withDescription('The ask, as a JSON file. Omitted: the ask is read from stdin'),
      Argument.optional,
    ),
    check: Flag.Boolean('check').pipe(
      Flag.withDescription(
        'Check the ask and send nothing: it is well-formed, and each `set` source is on this computer. No login, no network, no value printed',
      ),
      Flag.withDefault(false),
    ),
    isNoWait: Flag.Boolean('no-wait').pipe(
      Flag.withDescription(
        'Send the ask, print its link and return at once, without waiting for the owner: `baymutt ask wait <id>` follows it later',
      ),
      Flag.withDefault(false),
    ),
    timeout: timeoutFlag,
  },
  Effect.fn('ask')(function* ({ ask: file, check, isNoWait, timeout }) {
    if (!check) {
      return yield* send({ file, shouldWait: !isNoWait, timeout }).pipe(
        Effect.provide(ServiceAccount.layerUnreported),
      );
    }
    const decoded = decodeAskDocument(yield* askText(file));
    if (Result.isFailure(decoded)) return yield* usage(decoded.failure);
    const { ask, orgSlug } = decoded.success;
    yield* checkAsk(ask);
    yield* printLine({
      isWellFormed: true,
      isSent: false,
      org: orgSlug,
      steps: ask.steps.map(({ type }, index) => ({ index, type })),
      next: 'Nothing was sent. Run `baymutt ask` with the same ask to send it.',
    });
  }, report),
).pipe(
  Command.withDescription(DESCRIPTION),
  Command.withShortDescription(
    'Ask the owner for anything a task needs, in one ask: environments, keys, values. Waits for the owner: run it in the background',
  ),
  Command.withSubcommands([waitCommand, cancelCommand, schemaCommand]),
);
