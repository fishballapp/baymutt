import { readFileSync } from 'node:fs';
import * as JsonSchema from 'effect/JsonSchema';
import * as Result from 'effect/Result';
import type * as Schema from 'effect/Schema';
import * as SchemaParser from 'effect/SchemaParser';
import * as SchemaRepresentation from 'effect/SchemaRepresentation';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_PLAN } from './commands/ask.ts';
import { decodePlanDocument } from './plan-document.ts';
import { PLAN_JSON_SCHEMA } from './plan-schema.ts';

// No JSON Schema validator is a dependency anywhere in the monorepo, so the printed schema is read
// back by Effect's own importer (patterns applied, excess properties refused) and compared with
// `decodePlanDocument`. That catches a schema that drifts from what `ask` takes, and the structure
// tests below pin what a reader of the schema relies on.
type Node = {
  description?: string;
  type?: string;
  enum?: string[];
  properties?: Record<string, Node>;
  required?: string[];
  additionalProperties?: boolean;
  maxItems?: number;
  maxLength?: number;
  pattern?: string;
  anyOf?: unknown[];
  $ref?: string;
};
// The printed text, read as a reader reads it.
const printed: Node & { $schema: string; $defs: Record<string, Node> } = JSON.parse(
  JSON.stringify(PLAN_JSON_SCHEMA),
);
const { $schema, $defs, ...root } = printed;
// The importer types its result as needing unknown services; one made of checks needs none.
const imported = SchemaRepresentation.fromJsonSchemaDocument(
  { dialect: 'draft-2020-12', schema: root, definitions: $defs },
  { patterns: 'apply' },
) as unknown as Schema.ConstraintDecoder<unknown>;
const isAccepted = (plan: unknown) =>
  Result.isSuccess(SchemaParser.decodeUnknownResult(imported)(plan, { onExcessProperty: 'error' }));
const isTaken = (plan: unknown) => Result.isSuccess(decodePlanDocument(JSON.stringify(plan)));

const slot = { environment: 'acme/shop/preview', name: 'A' };
const one = (step: unknown) => ({ reason: 'rotate a token', steps: [step] });
const secrets = (item: unknown) => one({ type: 'secrets', items: [item] });
const key = '0b0e7a52-6f3c-4c58-9a51-3f0f7a0c1d11';

const shapeRefusals: ReadonlyArray<readonly [string, unknown]> = [
  ['an unknown field on the plan', { ...one({ type: 'access', read: ['acme/x'] }), org: 'acme' }],
  ['an unknown field on a step', one({ type: 'access', read: ['acme/x'], expiry: '1h' })],
  ['a missing field', one({ type: 'access' })],
  ['a missing reason', { steps: [{ type: 'access', read: ['acme/x'] }] }],
  ['a step of no type', one({ type: 'acces', read: ['acme/x'] })],
  ['an op of no kind', secrets({ op: 'write', ...slot })],
  ['an inline value', secrets({ op: 'set', ...slot, from: { env: 'A' }, value: 'sk_live' })],
  ['a set with no source', secrets({ op: 'set', ...slot })],
  ['two sources', secrets({ op: 'set', ...slot, from: { file: 'a', env: 'B' } })],
  ['a dotenv key on a file', secrets({ op: 'set', ...slot, from: { file: 'a', key: 'B' } })],
  ['a bad address', one({ type: 'access', read: ['app'] })],
  ['a bad duration', one({ type: 'access', read: ['acme/x'], expires: '1w' })],
  ['a rollback to version 0', secrets({ op: 'rollback', ...slot, version: 0 })],
  ['no steps', { reason: 'r', steps: [] }],
  [
    'too many steps',
    {
      reason: 'r',
      steps: Array.from({ length: 21 }, () => ({ type: 'access', read: ['acme/x'] })),
    },
  ],
  [
    'too many items',
    one({
      type: 'environments',
      items: Array.from({ length: 51 }, (_, index) => ({
        op: 'create',
        environment: `acme/e${index}`,
      })),
    }),
  ],
];

describe('the plan JSON Schema', () => {
  it('takes the plan `ask --help` shows, as `ask` does', () => {
    const plan: unknown = JSON.parse(EXAMPLE_PLAN);
    expect(isTaken(plan)).toBe(true);
    expect(isAccepted(plan)).toBe(true);
  });

  it.each([
    ['access', one({ type: 'access', read: ['acme/x'], name: 'CI', expires: 'never' })],
    [
      'change',
      one({ type: 'change', key, read: ['acme/x'], giveBack: ['acme/y'], expires: '90d' }),
    ],
    [
      'a dotenv source with a key',
      secrets({ op: 'set', ...slot, from: { dotenv: '.env', key: 'B' } }),
    ],
    ['a paste with a hint', secrets({ op: 'paste', ...slot, hint: 'the dashboard' })],
  ])('takes %s, as `ask` does', (_, plan) => {
    expect(isTaken(plan)).toBe(true);
    expect(isAccepted(plan)).toBe(true);
  });

  it.each(shapeRefusals)('refuses %s, as `ask` does', (_, plan) => {
    expect(isTaken(plan)).toBe(false);
    expect(isAccepted(plan)).toBe(false);
  });

  it('leaves to its description what a schema cannot say', () => {
    const { description } = printed;
    for (const rule of [
      'one org',
      'each environment once',
      'each secret',
      '200 environments and secrets',
      'at least one of `read`, `giveBack` and `expires`',
      'exactly one of `file`, `env` or `dotenv`',
      'never holds a value',
      'defaults to 1h',
    ]) {
      expect(description, rule).toContain(rule);
    }
    // These pass the schema and are refused by `ask`.
    const twoOrgs = one({ type: 'access', read: ['acme/x', 'globex/y'] });
    const nothingAsked = one({ type: 'change', key });
    const twice = one({ type: 'access', read: ['acme/x', 'acme/x'] });
    for (const plan of [twoOrgs, nothingAsked, twice]) {
      expect(isTaken(plan)).toBe(false);
      expect(isAccepted(plan)).toBe(true);
    }
  });

  it('closes every object, and lists what each requires', () => {
    const objects = Object.entries($defs).filter(([, def]) => def.type === 'object');
    expect(objects.length).toBeGreaterThan(8);
    for (const [name, def] of objects) {
      expect(def.additionalProperties, name).toBe(false);
    }
    expect(printed.additionalProperties).toBe(false);
    expect(printed.required).toEqual(['reason', 'steps']);
    expect($defs.AccessStep?.required).toEqual(['type', 'read']);
    expect($defs.ChangeStep?.required).toEqual(['type', 'key']);
    expect($defs.SetItem?.required).toEqual(['op', 'environment', 'name', 'from']);
    expect($defs.RollbackItem?.required).toEqual(['op', 'environment', 'name', 'version']);
  });

  it('names the kinds a step, an op and an expiry can be', () => {
    const types = Object.values($defs)
      .flatMap(def => def.properties?.type?.enum ?? [])
      .toSorted();
    expect(types).toEqual(['access', 'change', 'environments', 'secrets']);
    expect($defs.EnvironmentItem?.properties?.op?.enum).toEqual(['create', 'delete', 'restore']);
    expect($defs.SlotItem?.properties?.op?.enum).toEqual(['generate', 'delete', 'restore']);
    expect($defs.Duration?.pattern).toBe('^[1-9][0-9]{0,4}[mhd]$');
    expect($defs.AccessStep?.properties?.expires?.anyOf).toEqual([
      { type: 'string', enum: ['never'] },
      { $ref: '#/$defs/Duration' },
    ]);
  });

  it('carries the limits', () => {
    expect(printed.properties?.steps?.maxItems).toBe(20);
    expect($defs.EnvironmentsStep?.properties?.items?.maxItems).toBe(50);
    expect($defs.SecretsStep?.properties?.items?.maxItems).toBe(50);
    expect($defs.AccessStep?.properties?.read?.maxItems).toBe(50);
    expect($defs.ChangeStep?.properties?.giveBack?.maxItems).toBe(50);
    expect($defs.Address?.maxLength).toBe(161);
  });

  it('describes every field and what the patterns mean', () => {
    const undescribed = [...Object.entries({ Plan: root, ...$defs })].flatMap(([name, def]) =>
      Object.entries(def.properties ?? {})
        // `type` and `op` of one kind say it in their value.
        .filter(([, field]) => field.enum?.length !== 1 && field.description === undefined)
        .filter(
          ([, field]) =>
            field.$ref === undefined ||
            $defs[field.$ref.split('/').at(-1) ?? '']?.description === undefined,
        )
        .map(([field]) => `${name}.${field}`),
    );
    expect(undescribed).toEqual([]);
    expect($defs.Address?.description).toContain('<org>/<name>, such as acme/app/staging');
    expect($defs.Duration?.description).toContain('15m, 12h or 90d');
    for (const [name, def] of Object.entries($defs)) {
      if (def.type === 'object') expect(def.description ?? name, name).not.toBe('');
    }
  });

  it('is a draft 2020-12 document', () => {
    expect(printed.$schema).toBe(JsonSchema.META_SCHEMA_URI_DRAFT_2020_12);
  });
});

describe('the README’s plan reference', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const reference = readme.slice(
    readme.indexOf('## The plan'),
    readme.indexOf('## ', readme.indexOf('## The plan') + 3),
  );
  const fields = new Set(
    [root, ...Object.values($defs)].flatMap(def => Object.keys(def.properties ?? {})),
  );

  it.each([...fields])('lists the field %s', field => {
    expect(reference).toContain(`\`${field}\``);
  });
});
