import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import { AskDocumentSchema, decodeAskDocument } from './ask-document.ts';

const decode = Schema.decodeUnknownOption(AskDocumentSchema, { onExcessProperty: 'error' });

const setUp = {
  reason: 'set up the new worker',
  steps: [
    { type: 'environments', items: [{ op: 'create', environment: 'fishball/x' }] },
    {
      type: 'access',
      reason: 'deploy from this session',
      read: ['fishball/x', 'fishball/y'],
      expires: '1h',
    },
    {
      type: 'secrets',
      items: [
        { op: 'set', environment: 'fishball/x', name: 'A', from: { file: 'a.txt' } },
        { op: 'set', environment: 'fishball/x', name: 'B', from: { env: 'B_VALUE' } },
        { op: 'set', environment: 'fishball/x', name: 'C', from: { dotenv: '.env', key: 'OLD_C' } },
        { op: 'paste', environment: 'fishball/y', name: 'D', hint: 'from the Stripe dashboard' },
        { op: 'paste', environment: 'fishball/y', name: 'E' },
      ],
    },
  ],
};

const cleanUp = {
  reason: 'hand CI its key and clean up',
  steps: [
    {
      type: 'change',
      key: '0b0e7a52-6f3c-4c58-9a51-3f0f7a0c1d11',
      read: ['fishball/staging'],
      giveBack: ['fishball/old'],
      expires: '1d',
    },
    {
      type: 'access',
      read: ['fishball/ci/production'],
      expires: 'never',
      name: 'CI deploy',
      command: ['gh', 'secret', 'set', 'BAYMUTT_KEY', '-R', 'acme/app'],
    },
    {
      type: 'secrets',
      reason: 'the new token was rejected',
      items: [
        { op: 'rollback', environment: 'fishball/ci/production', name: 'TOKEN', version: 3 },
        { op: 'delete', environment: 'fishball/ci/production', name: 'OLD' },
        { op: 'restore', environment: 'fishball/ci/production', name: 'LEGACY' },
        { op: 'generate', environment: 'fishball/ci/production', name: 'SESSION_SECRET' },
      ],
    },
    { type: 'environments', items: [{ op: 'delete', environment: 'fishball/scratch' }] },
  ],
};

const one = (step: unknown) => ({ reason: 'rotate a token', steps: [step] });
const slot = { environment: 'fishball/x', name: 'A' };

describe('AskDocumentSchema', () => {
  it.each([
    ['every kind of step', setUp],
    ['a change, a service account, every secret op', cleanUp],
  ])('takes %s', (_, ask) => {
    expect(Option.getOrThrow(decode(ask))).toEqual(ask);
  });

  it.each<[string, unknown]>([
    [
      'an inline value',
      one({ type: 'secrets', items: [{ op: 'set', ...slot, value: 'sk_live' }] }),
    ],
    [
      'a value beside its source',
      one({
        type: 'secrets',
        items: [{ op: 'set', ...slot, from: { file: 'a.txt' }, value: 'sk_live' }],
      }),
    ],
    ['a field nobody reads', { ...setUp, org: 'fishball' }],
    ['an environment without its org', one({ type: 'access', read: ['x'] })],
    ['a null hint', one({ type: 'secrets', items: [{ op: 'paste', ...slot, hint: null }] })],
    [
      'a command as one string',
      one({ type: 'access', read: ['fishball/x'], command: 'gh secret set BAYMUTT_KEY' }),
    ],
    ['a null expiry', one({ type: 'access', read: ['fishball/x'], expires: null })],
    ['a rollback with no version', one({ type: 'secrets', items: [{ op: 'rollback', ...slot }] })],
    [
      'a field of another op',
      one({ type: 'secrets', items: [{ op: 'delete', ...slot, version: 3 }] }),
    ],
    [
      'a step of no known type',
      one({ type: 'environment', items: [{ op: 'create', environment: 'fishball/x' }] }),
    ],
    ['a step with no items', one({ type: 'environments', items: [] })],
    ['no steps', { reason: 'rotate a token', steps: [] }],
    ['no reason', { steps: setUp.steps }],
  ])('refuses %s', (_, ask) => {
    expect(Option.isNone(decode(ask))).toBe(true);
  });
});

describe('decodeAskDocument', () => {
  const refusal = (ask: unknown) => {
    const decoded = decodeAskDocument(JSON.stringify(ask));
    if (Result.isSuccess(decoded)) throw new Error('the ask was taken');
    return decoded.failure;
  };

  it('takes an ask, with the one org its addresses name', () => {
    expect(decodeAskDocument(JSON.stringify(setUp))).toEqual(
      Result.succeed({ ask: setUp, orgSlug: 'fishball' }),
    );
  });

  it('takes an ask that names no environment, and leaves its org to the key it changes', () => {
    const ask = one({ type: 'change', key: cleanUp.steps[0]?.key, expires: '1d' });
    expect(decodeAskDocument(JSON.stringify(ask))).toEqual(Result.succeed({ ask, orgSlug: null }));
  });

  it.each<[string, unknown, string]>([
    [
      'a change that asks for nothing',
      one({ type: 'change', key: cleanUp.steps[0]?.key }),
      'steps[0]: a `change` step asks for something',
    ],
    [
      'a field nobody reads, with the fields that go there',
      one({ type: 'access', read: ['fishball/x'], expiry: '1h' }),
      'steps[0].expiry: nothing reads this field. The fields of steps[0] are: type, reason?, read, expires?, name?, command?.',
    ],
    [
      'an inline value, saying where a value goes instead',
      one({ type: 'secrets', items: [{ op: 'set', ...slot, from: { env: 'A' }, value: 'x' }] }),
      'steps[0].items[0].value: nothing reads this field. An ask never holds a value',
    ],
    [
      'a source that names none, or two',
      one({ type: 'secrets', items: [{ op: 'set', ...slot, from: { file: 'a', env: 'B' } }] }),
      'steps[0].items[0].from: expected exactly one of',
    ],
    [
      'an op of no kind',
      one({ type: 'secrets', items: [{ op: 'write', ...slot }] }),
      'steps[0].items[0].op: expected "set", "paste", "generate", "delete", "restore" or "rollback".',
    ],
    [
      'more items than a step takes',
      one({
        type: 'secrets',
        items: Array.from({ length: 51 }, (_, index) => ({
          op: 'generate',
          ...slot,
          name: `S${index}`,
        })),
      }),
      'steps[0].items: at most 50 entries, and this has 51.',
    ],
    [
      'more reads than a step takes',
      one({
        type: 'access',
        read: Array.from({ length: 51 }, (_, index) => `fishball/e${index}`),
      }),
      'steps[0].read: at most 50 entries, and this has 51.',
    ],
    [
      'more steps than an ask takes',
      {
        reason: 'r',
        steps: Array.from({ length: 21 }, () => ({ type: 'access', read: ['fishball/x'] })),
      },
      'steps: at most 20 entries, and this has 21.',
    ],
    [
      'two orgs',
      { reason: 'r', steps: [{ type: 'access', read: ['fishball/x', 'acme/x'] }] },
      'steps[0].read[1]: an ask is for one org, and this one names fishball and acme.',
    ],
    [
      'an environment twice in a step',
      one({
        type: 'change',
        key: cleanUp.steps[0]?.key,
        read: ['fishball/x'],
        giveBack: ['fishball/x'],
      }),
      'steps[0].giveBack[0]: this step already names fishball/x.',
    ],
    ['no JSON object', [], 'The ask is a JSON object'],
  ])('refuses %s, naming the path', (_, ask, message) => {
    expect(refusal(ask)).toContain(message);
  });

  it('refuses text that is not JSON', () => {
    expect(decodeAskDocument('{"reason": ')).toEqual(
      Result.fail('The ask is not JSON. Write it as one JSON object: {"reason": …, "steps": […]}.'),
    );
  });
});
