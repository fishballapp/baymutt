// `baymutt ask`: the one way an agent asks the owner for anything. It reads a plan (a reason and
// ordered steps, as JSON), resolves and seals it here, keeps what it will need, and sends it;
// `ask wait` follows it to the owner's answers and `ask cancel` withdraws it.
import { MAX_PLAN_ITEMS, MAX_PLAN_STEPS, MAX_STEP_ITEMS } from '@baymutt/api';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Stdio from 'effect/Stdio';
import * as Stream from 'effect/Stream';
import { answerFor, describeFailure, isRefusal, report, usage } from '../errors.ts';
import { forgetDeadKeys, forgetKey, keepKey } from '../key-files.ts';
import { print, printLine } from '../output.ts';
import { cancelPlan, waitForPlan } from '../plan-answers.ts';
import { checkPlan } from '../plan-check.ts';
import { decodePlanDocument } from '../plan-document.ts';
import { makePlan } from '../plan-making.ts';
import { PLAN_JSON_SCHEMA } from '../plan-schema.ts';
import { checkAnswer, checkedId, forgetPlan, handOver, keepPlan, planUrl } from '../plans.ts';
import { ServiceAccount } from '../service-account.ts';

/** One plan with every step type, laid out one item per line: what `baymutt ask --help` shows. */
export const EXAMPLE_PLAN = `{
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
  'Ask the owner for anything, in one plan: `baymutt ask plan.json`, or the plan on stdin (`baymutt ask < plan.json`). A plan is JSON: a reason, and steps in the order they are to happen, all in one org. Ask for everything the task needs in one plan: the owner decides each step on one page, so one plan costs them one visit.',
  `Steps: \`environments\` (create, delete or restore environments), \`access\` (a new key that reads environments: kept in a file here, or with \`command\`, piped into that command once approved), \`change\` (add reads to a key this login asked for, give some back, or a new end: \`read\`, \`giveBack\` and \`expires\` are each optional, and one is needed) and \`secrets\` (set a value from a file, an env variable or a dotenv file on this computer; ask the owner to paste one, with a hint where to find it; generate a random one; delete, restore or roll one back). Environments are full addresses, <org>/<name>, where the name may have more segments (acme/shop/preview); a step may name one an earlier step creates or restores, and names each environment once (a \`secrets\` step, each secret once): to delete one and make it again, use two \`environments\` steps. A secret’s name is letters, digits and underscores, not starting with a digit. On a \`change\`, \`read\` names only what to add. A \`rollback\` takes a version number: \`baymutt secret history\` lists them. \`reason\` on a step is optional, and so is \`name\` on \`access\`: what the owner sees the key as. At most ${MAX_PLAN_STEPS} steps, ${MAX_STEP_ITEMS} items in a step and ${MAX_PLAN_ITEMS} across the plan.`,
  '`expires` is a number then `m`, `h` or `d` (`30m`, `12h`, `14d`), or `"never"`, on any key; a lifetime is between one minute and ten years. It is counted from when the owner approves the step, on a `change` too, where it replaces the key’s end rather than adding to it. Omitted, `access` lasts 1h (no end with a `command`) and `change` keeps the end. To end a key now, `baymutt key revoke <id>`.',
  'A plan never holds a value, not even one you were told in chat, and not in a `reason`, which the store can read: ask the owner to `paste` it, or `set` it from where it already is on this computer (`file`, `env`, or `dotenv`, whose variable is the secret’s name unless `key` names another). It is read here and sealed so only the owner opens it. A relative path is from the current directory.',
  'It prints the plan id, a link for the owner and each step’s status, and returns at once. The owner sees only your reply to them: end that reply with the link, alone on its last line. Then run `baymutt ask wait <id>` in the background, or after that reply: a wait that blocks first hides the link. Each step waits an hour.',
  '`baymutt ask schema` prints the format of a plan as JSON Schema. `baymutt ask --check plan.json` checks a plan without sending it, with no login and no network.',
  `Example plan, with every step type:\n${EXAMPLE_PLAN}`,
  'A plan file named exactly `wait`, `cancel` or `schema` is read as that subcommand: write `./wait`.',
].join('\n\n');

/** The plan as written: from `file`, or from stdin when no file is named. */
const planText = Effect.fnUntraced(function* (file: Option.Option<string>) {
  if (Option.isSome(file)) {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs
      .readFileString(file.value)
      .pipe(
        Effect.catchReason('PlatformError', 'NotFound', () =>
          Effect.fail(usage(`There is no plan at ${file.value}.`, 'notFound')),
        ),
      );
  }
  const stdio = yield* Stdio.Stdio;
  if (yield* stdio.stdinIsTerminal) {
    return yield* usage(
      'Give the plan as a file, `baymutt ask plan.json`, or on stdin, `baymutt ask < plan.json`. See `baymutt ask --help` for one.',
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
    'How long to wait before giving up, such as 30s, 15m or 1h (the plan keeps waiting for the owner)',
  ),
  Flag.withDefault('15m'),
  Flag.filterMap(timeoutMs, text => `Expected a duration such as 30s, 15m or 1h, not "${text}"`),
);

const idArgument = Argument.String('id').pipe(
  Argument.withDescription('The plan id `baymutt ask` printed'),
);

const waitCommand = Command.make(
  'wait',
  { id: idArgument, timeout: timeoutFlag },
  Effect.fn('ask.wait')(function* ({ id, timeout }) {
    return yield* waitForPlan(yield* checkedId(id), timeout);
  }, report),
).pipe(
  Command.withDescription(
    'Wait until the owner has answered every step of a plan, finishing each as it is answered, then print one JSON line per step: its index, type, status, and the owner’s note when there is one. An approved `access` step prints its key file (use it as BAYMUTT_KEY_FILE=<keyFile>, or its content as BAYMUTT_KEY inside a sandbox), or is piped into its command; an approved `change` prints what the key holds now. Exit 0 when every step was approved or applied; 9 while any still waits at the timeout (wait again: the steps answered so far are done); 4 when one was rejected, withdrawn or expired, after printing every step so you see which went through',
  ),
  Command.withShortDescription(
    'Wait until the owner has answered every step of a plan, then print each step’s result',
  ),
  Command.provide(ServiceAccount.layer),
);

const cancelCommand = Command.make(
  'cancel',
  { id: idArgument },
  Effect.fn('ask.cancel')(function* ({ id }) {
    return yield* cancelPlan(yield* checkedId(id));
  }, report),
).pipe(
  Command.withDescription(
    'Withdraw a plan: every step the owner has not answered is cancelled, and the keys it would have made are removed from this computer. A step already answered stays answered',
  ),
  Command.provide(ServiceAccount.layer),
);

const schemaCommand = Command.make(
  'schema',
  {},
  Effect.fn('ask.schema')(function* () {
    yield* print(PLAN_JSON_SCHEMA);
  }, report),
).pipe(
  Command.withDescription(
    'Print the format of a plan as JSON Schema: every field, what it means, and its limits. Needs no login and no network',
  ),
);

/** The plan sent to the store, for the login it is run from. */
const send = Effect.fn('ask.send')(function* (file: Option.Option<string>) {
  const decoded = decodePlanDocument(yield* planText(file));
  if (Result.isFailure(decoded)) return yield* usage(decoded.failure);
  const { isLogin, api } = yield* ServiceAccount;
  if (!isLogin) {
    return yield* usage(
      '`baymutt ask` runs from a CLI login (`baymutt auth login`), without BAYMUTT_KEY or BAYMUTT_KEY_FILE. A key reads what it was given and asks for nothing itself.',
    );
  }
  yield* forgetDeadKeys();
  const { payload, kept, keys } = yield* makePlan(decoded.success);
  // Kept before anything is sent: an approved key whose file was lost is no use to anyone.
  yield* Effect.forEach(keys, keepKey, { concurrency: 1, discard: true });
  yield* keepPlan(kept);
  const forgetAll = Effect.andThen(
    Effect.forEach(keys, ({ id }) => forgetKey(id), { concurrency: 1, discard: true }),
    forgetPlan(payload.id),
  );
  const plan = yield* api.plans.create({ payload }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (error) {
        // The store said no, so there is no plan for the keys to wait on.
        if (yield* isRefusal(error)) {
          yield* forgetAll;
          return yield* error;
        }
        // No answer proves nothing: the plan may exist, and the owner may approve it.
        const { message, kind } = yield* describeFailure(error);
        return yield* usage(
          `${message} Plan ${payload.id} may have been made all the same, so what it needs stays on this computer: run \`baymutt ask wait ${payload.id}\` to follow it.`,
          kind,
        );
      }),
    ),
    answerFor(payload.id),
    Effect.flatMap(answer => checkAnswer(kept, answer)),
  );
  const isWaiting = plan.steps.some(({ status }) => status === 'pending');
  yield* print({
    id: plan.id,
    status: isWaiting ? 'pending' : 'answered',
    url: yield* planUrl(plan),
    steps: plan.steps.map(({ index, type, status }) => ({ index, type, status })),
    next: isWaiting
      ? handOver(plan.id)
      : `Nothing waits for the owner. Run \`baymutt ask wait ${plan.id}\` to check what each key holds now.`,
  });
});

export const askCommand = Command.make(
  'ask',
  {
    plan: Argument.String('plan.json').pipe(
      Argument.withDescription('The plan, as a JSON file. Omitted: the plan is read from stdin'),
      Argument.optional,
    ),
    check: Flag.Boolean('check').pipe(
      Flag.withDescription(
        'Check the plan and send nothing: it is well-formed, and each `set` source is on this computer. No login, no network, no value printed',
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fn('ask')(function* ({ plan: file, check }) {
    if (!check) return yield* send(file).pipe(Effect.provide(ServiceAccount.layerUnreported));
    const decoded = decodePlanDocument(yield* planText(file));
    if (Result.isFailure(decoded)) return yield* usage(decoded.failure);
    const { plan, orgSlug } = decoded.success;
    yield* checkPlan(plan);
    yield* printLine({
      isWellFormed: true,
      isSent: false,
      org: orgSlug,
      steps: plan.steps.map(({ type }, index) => ({ index, type })),
      next: 'Nothing was sent. Run `baymutt ask` with the same plan to send it.',
    });
  }, report),
).pipe(
  Command.withDescription(DESCRIPTION),
  Command.withShortDescription(
    'Ask the owner for anything a task needs, in one plan: environments, keys, values',
  ),
  Command.withSubcommands([waitCommand, cancelCommand, schemaCommand]),
);
