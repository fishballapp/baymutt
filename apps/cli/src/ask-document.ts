// The ask an agent writes for `baymutt ask`: a reason and ordered steps, as JSON. It names
// environments by their full address and never holds a value: a `set` says where the value is.
// It is decoded a level at a time, each object by the schema its `type`, `op` or source names, so a
// refusal names one path and what is wrong there, not every way a union could have matched.
import {
  DescriptionSchema,
  IdSchema,
  LabelSchema,
  MAX_ASK_ITEMS,
  MAX_ASK_STEPS,
  MAX_STEP_ITEMS,
  ReasonSchema,
  SecretNameSchema,
} from '@baymutt/api';
import * as Predicate from 'effect/Predicate';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import type * as SchemaAST from 'effect/SchemaAST';
import * as SchemaIssue from 'effect/SchemaIssue';

/** `<org>/<name>`: an org slug, then the environment's lower-case segments joined by `/`. */
const address = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?(?:\/[a-z0-9][a-z0-9._-]*)+$/u, {
    message: 'an environment as <org>/<name>, such as acme/app/staging',
  }),
  Schema.isMaxLength(161),
).annotate({
  identifier: 'Address',
  description:
    'An environment as <org>/<name>, such as acme/app/staging: the org’s slug (lower-case letters, digits and hyphens), then the environment’s lower-case name, segments joined by `/`.',
});

const duration = Schema.String.check(
  Schema.isPattern(/^[1-9][0-9]{0,4}[mhd]$/u, {
    message: 'minutes, hours or days, such as 15m, 12h or 90d',
  }),
).annotate({
  identifier: 'Duration',
  description: 'Minutes, hours or days, such as 15m, 12h or 90d.',
});

/** What `expires` says: `never`, or a duration. `whenOmitted` is what leaving it out means. */
const expiry = (whenOmitted: string) =>
  Schema.Union([Schema.Literal('never'), duration]).annotate({
    description: `How long the key works, counted from when the owner approves the step: \`never\`, or a duration. ${whenOmitted}`,
  });

const manyOf = <S extends Schema.Top>(element: S, description: string) =>
  Schema.NonEmptyArray(element).check(Schema.isMaxLength(MAX_STEP_ITEMS)).annotate({ description });

const step = {
  reason: Schema.optionalKey(
    DescriptionSchema.annotate({
      description:
        'Why this step, for the owner to read: 1 to 140 characters with no space at either end. Never a secret.',
    }),
  ),
};

const environmentItem = Schema.Struct({
  op: Schema.Literals(['create', 'delete', 'restore']).annotate({
    description: 'What to do with the environment.',
  }),
  environment: address,
}).annotate({ identifier: 'EnvironmentItem' });

const environmentsStep = Schema.Struct({
  type: Schema.Literal('environments'),
  ...step,
  items: manyOf(environmentItem, 'The environments to create, delete or restore.'),
}).annotate({
  identifier: 'EnvironmentsStep',
  description: 'Create, delete or restore environments.',
});

const accessStep = Schema.Struct({
  type: Schema.Literal('access'),
  ...step,
  read: manyOf(address, 'The environments the new key reads.'),
  expires: Schema.optionalKey(expiry('Omitted: 1h, or with a `command`, no end.')),
  name: Schema.optionalKey(
    LabelSchema.annotate({
      description:
        'What the owner sees the key as: 1 to 60 characters with no space at either end.',
    }),
  ),
  command: Schema.optionalKey(
    Schema.NonEmptyArray(Schema.String).annotate({
      description:
        'An argv the key is piped into once approved: the key is then a service account. Without it the key is kept in a file on this computer.',
    }),
  ),
}).annotate({
  identifier: 'AccessStep',
  description: 'A new key that reads the environments named in `read`.',
});

const changeStep = Schema.Struct({
  type: Schema.Literal('change'),
  ...step,
  key: IdSchema.annotate({ description: 'The id of a key this CLI login asked for.' }),
  read: Schema.optionalKey(manyOf(address, 'Environments the key reads from now on.')),
  giveBack: Schema.optionalKey(manyOf(address, 'Environments the key reads no more.')),
  expires: Schema.optionalKey(
    expiry('It replaces the key’s end, and is not added to it. Omitted: the key keeps its end.'),
  ),
}).annotate({
  identifier: 'ChangeStep',
  description:
    'A key this CLI login asked for reads more, gives some back, or gets a new end. At least one of `read`, `giveBack` and `expires`.',
});

const slot = { environment: address, name: SecretNameSchema };

const nonEmpty = Schema.String.check(Schema.isMinLength(1));

/** Where a value is, read on this computer when the ask is sent. Never the value. */
const SOURCES = {
  file: Schema.Struct({
    file: nonEmpty.annotate({
      description:
        'A file whose whole content is the value. A relative path is from the current directory.',
    }),
  }).annotate({ identifier: 'FileSource' }),
  env: Schema.Struct({
    env: nonEmpty.annotate({ description: 'An environment variable that holds the value.' }),
  }).annotate({ identifier: 'EnvSource' }),
  dotenv: Schema.Struct({
    dotenv: nonEmpty.annotate({
      description: 'A dotenv file. A relative path is from the current directory.',
    }),
    key: Schema.optionalKey(
      nonEmpty.annotate({
        description: 'The variable to take from the file. Omitted, the item’s `name`.',
      }),
    ),
  }).annotate({ identifier: 'DotenvSource' }),
} as const;
const source = Schema.Union([SOURCES.file, SOURCES.env, SOURCES.dotenv]).annotate({
  description:
    'Where the value is on this computer, read when the ask is sent and sealed so only the owner opens it. Exactly one of `file`, `env` or `dotenv`.',
});
export type ValueSource = typeof source.Type;

const setItem = Schema.Struct({
  op: Schema.Literal('set'),
  ...slot,
  from: source,
}).annotate({
  identifier: 'SetItem',
  description: 'Set the secret to a value that is on this computer.',
});
const slotItem = Schema.Struct({
  op: Schema.Literals(['generate', 'delete', 'restore']).annotate({
    description:
      'generate: a random value; delete: the secret goes to the bin; restore: it comes back from the bin.',
  }),
  ...slot,
}).annotate({ identifier: 'SlotItem' });
const ITEMS = {
  set: setItem,
  paste: Schema.Struct({
    op: Schema.Literal('paste'),
    ...slot,
    hint: Schema.optionalKey(
      ReasonSchema.check(Schema.isMinLength(1)).annotate({
        description: 'Where the owner finds the value.',
      }),
    ),
  }).annotate({
    identifier: 'PasteItem',
    description: 'The owner pastes the value: for one only they can fetch.',
  }),
  generate: slotItem,
  delete: slotItem,
  restore: slotItem,
  rollback: Schema.Struct({
    op: Schema.Literal('rollback'),
    ...slot,
    version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
      description: 'The version to roll back to.',
    }),
  }).annotate({
    identifier: 'RollbackItem',
    description: 'Roll the secret back to an earlier version.',
  }),
} as const;

const secretsStep = Schema.Struct({
  type: Schema.Literal('secrets'),
  ...step,
  items: manyOf(
    Schema.Union([ITEMS.set, ITEMS.paste, ITEMS.generate, ITEMS.rollback]),
    'What to do with each secret, one item per secret.',
  ),
}).annotate({
  identifier: 'SecretsStep',
  description: 'Set, paste, generate, delete, restore or roll back secrets.',
});

const STEPS = {
  environments: environmentsStep,
  access: accessStep,
  change: changeStep,
  secrets: secretsStep,
} as const;

export const AskDocumentSchema = Schema.Struct({
  reason: DescriptionSchema.annotate({
    description:
      'The task, shown to the owner: 1 to 140 characters with no space at either end. Never a secret.',
  }),
  steps: Schema.NonEmptyArray(Schema.Union([environmentsStep, accessStep, changeStep, secretsStep]))
    .check(Schema.isMaxLength(MAX_ASK_STEPS))
    .annotate({ description: 'The steps, in the order they are to happen.' }),
}).annotate({
  description: `What \`baymutt ask\` sends: a reason and ordered steps. What this schema cannot say: an ask is for one org, the first segment of every environment it names. A step names each environment once, and in a \`secrets\` step each secret once. An ask names at most ${MAX_ASK_ITEMS} environments and secrets across its steps. A \`change\` step asks for at least one of \`read\`, \`giveBack\` and \`expires\`. A \`set\` item’s \`from\` is exactly one of \`file\`, \`env\` or \`dotenv\`. An ask never holds a value: a \`set\` names where the value is on the computer that sends the ask, and a \`paste\` leaves it to the owner. \`expires\` on an \`access\` step defaults to 1h, or to no end with a \`command\`; on a \`change\` step, omitted keeps the key’s end. A step may name an environment an earlier step creates or restores.`,
});
export type AskDocument = typeof AskDocumentSchema.Type;
export type AskDocumentStep = AskDocument['steps'][number];

/** One step's items, as the ask lists them: what `steps[i]` names, each at its own path. */
export type SecretsItem = Extract<AskDocumentStep, { type: 'secrets' }>['items'][number];

/** The org an address names: what comes before its first `/`. */
const orgOf = (address: string) => address.slice(0, address.indexOf('/'));

/**
 * Each place a step names an environment, at its path within the step, and what may not repeat
 * within the step: the environment, or in a `secrets` step, the secret.
 */
const namedBy = (step: AskDocumentStep) => {
  const at = (field: string, addresses: ReadonlyArray<string>) =>
    addresses.map((address, index) => ({
      path: [field, index] as ReadonlyArray<PropertyKey>,
      address,
      repeatKey: address,
      isSecret: false,
    }));
  switch (step.type) {
    case 'environments':
      return step.items.map(({ environment }, index) => ({
        path: ['items', index, 'environment'] as ReadonlyArray<PropertyKey>,
        address: environment,
        repeatKey: environment,
        isSecret: false,
      }));
    case 'access':
      return at('read', step.read);
    case 'change':
      return [...at('read', step.read ?? []), ...at('giveBack', step.giveBack ?? [])];
    case 'secrets':
      return step.items.map(({ environment, name }, index) => ({
        path: ['items', index] as ReadonlyArray<PropertyKey>,
        address: environment,
        repeatKey: `${name} in ${environment}`,
        isSecret: true,
      }));
  }
};

/** A path into the document as the store and this CLI print it: `steps[0].items[1].from`. */
export const pathOf = (path: ReadonlyArray<PropertyKey>) =>
  path
    .map((key, index) => {
      if (typeof key === 'number') return `[${key}]`;
      return index === 0 ? String(key) : `.${String(key)}`;
    })
    .join('');

/** The fields of a struct, as a list a refusal names: optional ones marked `?`. */
const fieldsOf = (ast: SchemaAST.AST) =>
  ast._tag === 'Objects'
    ? ast.propertySignatures
        .map(({ name, type }) => `${String(name)}${type.context?.isOptional ? '?' : ''}`)
        .join(', ')
    : '';

const formatter = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * What is wrong at the first place `issue` names, as one sentence. A field nobody reads and a
 * missing one say which fields go there; any other says what was expected.
 */
const describe = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey>,
  parent: SchemaAST.AST | undefined,
): string => {
  switch (issue._tag) {
    case 'Pointer':
      return describe(issue.issue, [...path, ...issue.path], parent);
    case 'Composite': {
      const [first] = issue.issues;
      return describe(first, path, issue.ast);
    }
    case 'UnexpectedKey': {
      const field = path.at(-1);
      const where = pathOf(path.slice(0, -1)) || 'the ask';
      const value =
        field === 'value'
          ? ' An ask never holds a value: name where it is with `from` (a file, an env variable or a dotenv file).'
          : '';
      return `${pathOf(path)}: nothing reads this field.${value} The fields of ${where} are: ${fieldsOf(issue.ast)}.`;
    }
    case 'MissingKey': {
      const where = pathOf(path.slice(0, -1)) || 'the ask';
      const fields =
        parent === undefined ? '' : ` The fields of ${where} are: ${fieldsOf(parent)}.`;
      return `${pathOf(path)} is missing.${fields}`;
    }
    default: {
      const expected = [
        ...new Set(
          formatter(issue).issues.map(({ message }) => message.replace(/^Expected /u, '')),
        ),
      ];
      return `${pathOf(path) || 'The ask'}: expected ${expected.join(', or ')}.`;
    }
  }
};

/** `input` decoded strictly by `schema`, or what is wrong with it, at `path`. */
const decodeAt = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  input: unknown,
  path: ReadonlyArray<PropertyKey>,
): Result.Result<S['Type'], string> =>
  Result.mapError(Schema.decodeUnknownResult(schema, { onExcessProperty: 'error' })(input), error =>
    describe(error.issue, path, undefined),
  );

/** The value of `field` on an object, if it names one of `choices`. */
const choiceOf = <const K extends string>(
  input: unknown,
  field: string,
  choices: ReadonlyArray<K>,
): K | undefined => {
  if (!Predicate.isObject(input) || !Predicate.hasProperty(input, field)) return undefined;
  const value = input[field];
  return choices.find(choice => choice === value);
};

const listed = (choices: ReadonlyArray<string>) =>
  `${choices
    .slice(0, -1)
    .map(choice => `"${choice}"`)
    .join(', ')} or "${choices.at(-1)}"`;

/** An array field's elements, each to decode at its own path; refused when it holds more than `max`. */
const elementsOf = (
  input: unknown,
  path: ReadonlyArray<PropertyKey>,
  max: number,
): Result.Result<ReadonlyArray<unknown>, string> => {
  if (!Array.isArray(input) || input.length === 0) {
    return Result.fail(`${pathOf(path)}: expected a list with at least one entry.`);
  }
  if (input.length > max) {
    return Result.fail(
      `${pathOf(path)}: at most ${max} entries, and this has ${input.length}. Ask for the rest in another ask.`,
    );
  }
  return Result.succeed(input);
};

const decodeSource = (input: unknown, path: ReadonlyArray<PropertyKey>) => {
  const kinds = Object.keys(SOURCES) as ReadonlyArray<keyof typeof SOURCES>;
  const named = Predicate.isObject(input)
    ? kinds.filter(kind => Predicate.hasProperty(input, kind))
    : [];
  const [kind, ...others] = named;
  if (kind === undefined || others.length > 0) {
    return Result.fail(
      `${pathOf(path)}: expected exactly one of {"file": <path>}, {"env": <variable>} or {"dotenv": <path>, "key"?: <variable>}: where the value is on this computer.`,
    );
  }
  return decodeAt(SOURCES[kind], input, path);
};

const decodeItem = (input: unknown, path: ReadonlyArray<PropertyKey>) =>
  Result.gen(function* () {
    const ops = Object.keys(ITEMS) as ReadonlyArray<keyof typeof ITEMS>;
    const op = choiceOf(input, 'op', ops);
    if (op === undefined) {
      return yield* Result.fail(`${pathOf([...path, 'op'])}: expected ${listed(ops)}.`);
    }
    if (op !== 'set' || !Predicate.hasProperty(input, 'from')) {
      return yield* decodeAt(ITEMS[op], input, path);
    }
    const { from, ...rest } = input;
    yield* decodeSource(from, [...path, 'from']);
    return yield* decodeAt(ITEMS.set, { ...rest, from }, path);
  });

const decodeStep = (input: unknown, path: ReadonlyArray<PropertyKey>) =>
  Result.gen(function* () {
    const types = Object.keys(STEPS) as ReadonlyArray<keyof typeof STEPS>;
    const type = choiceOf(input, 'type', types);
    if (type === undefined) {
      return yield* Result.fail(`${pathOf([...path, 'type'])}: expected ${listed(types)}.`);
    }
    if (type === 'secrets' && Predicate.hasProperty(input, 'items')) {
      const items = yield* elementsOf(input.items, [...path, 'items'], MAX_STEP_ITEMS);
      for (const [index, item] of items.entries()) {
        yield* decodeItem(item, [...path, 'items', index]);
      }
    }
    // The schema holds the limit too; this says it in a sentence before the schema's check does.
    for (const field of ['items', 'read', 'giveBack'] as const) {
      const list: unknown = Predicate.hasProperty(input, field) ? input[field] : undefined;
      if (Array.isArray(list) && list.length > MAX_STEP_ITEMS) {
        yield* elementsOf(list, [...path, field], MAX_STEP_ITEMS);
      }
    }
    const decoded = yield* decodeAt(STEPS[type], input, path);
    if (
      decoded.type === 'change' &&
      decoded.read === undefined &&
      decoded.giveBack === undefined &&
      decoded.expires === undefined
    ) {
      return yield* Result.fail(
        `${pathOf(path)}: a \`change\` step asks for something: environments to \`read\`, ones to \`giveBack\`, or a new end in \`expires\`.`,
      );
    }
    return decoded;
  });

/**
 * The ask in `text`, decoded strictly: a field nothing reads is refused, not ignored. The
 * refusal is one sentence that names the JSON path and what goes there.
 */
export const decodeAskDocument = (text: string) =>
  Result.gen(function* () {
    const json = yield* Result.mapError(
      Schema.decodeResult(Schema.fromJsonString(Schema.Unknown))(text),
      () => 'The ask is not JSON. Write it as one JSON object: {"reason": …, "steps": […]}.',
    );
    if (!Predicate.isObject(json)) {
      return yield* Result.fail('The ask is a JSON object: {"reason": …, "steps": […]}.');
    }
    const steps = yield* elementsOf(
      Predicate.hasProperty(json, 'steps') ? json.steps : undefined,
      ['steps'],
      MAX_ASK_STEPS,
    );
    for (const [index, each] of steps.entries()) yield* decodeStep(each, ['steps', index]);
    const ask = yield* decodeAt(AskDocumentSchema, json, []);
    const named = ask.steps.flatMap((each, index) =>
      namedBy(each).map(entry => ({
        ...entry,
        step: index,
        path: ['steps', index, ...entry.path],
      })),
    );
    if (named.length > MAX_ASK_ITEMS) {
      return yield* Result.fail(
        `An ask names up to ${MAX_ASK_ITEMS} things across its steps, and this one names ${named.length}. Ask for the rest in another ask.`,
      );
    }
    const [first, ...rest] = named;
    // An ask that names no environment (a new end for a key) is in the org of the key it changes.
    if (first === undefined) return { ask, orgSlug: null };
    const orgSlug = orgOf(first.address);
    const elsewhere = rest.find(entry => orgOf(entry.address) !== orgSlug);
    if (elsewhere !== undefined) {
      return yield* Result.fail(
        `${pathOf(elsewhere.path)}: an ask is for one org, and this one names ${orgSlug} and ${orgOf(elsewhere.address)}. Make one ask per org.`,
      );
    }
    const repeated = named.find((entry, index) =>
      named
        .slice(0, index)
        .some(earlier => earlier.step === entry.step && earlier.repeatKey === entry.repeatKey),
    );
    if (repeated !== undefined) {
      return yield* Result.fail(
        `${pathOf(repeated.path)}: this step already names ${repeated.repeatKey}. A step names each ${repeated.isSecret ? 'secret' : 'environment'} once.`,
      );
    }
    return { ask, orgSlug };
  });
