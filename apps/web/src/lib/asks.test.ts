import type { AskStep } from '@baymutt/api';
import { describe, expect, it } from 'vitest';
import {
  approveLabel,
  type Blocked,
  nextFocus,
  statusWord,
  stepsWords,
  stepTitle,
} from './asks.ts';

const environments = (ops: ReadonlyArray<'create' | 'delete' | 'restore'>) =>
  ({
    type: 'environments',
    items: ops.map((op, at) => ({ op, environmentId: `e${at}` })),
  }) as never as AskStep;

const secrets = (environmentIds: ReadonlyArray<string>) =>
  ({
    type: 'secrets',
    items: environmentIds.map(environmentId => ({ op: 'generate', environmentId })),
  }) as never as AskStep;

describe('stepTitle', () => {
  it('says what each step does', () => {
    expect(stepTitle(environments(['create']))).toBe('Create an environment');
    expect(stepTitle(environments(['delete', 'delete']))).toBe('Delete 2 environments');
    expect(stepTitle(environments(['create', 'restore']))).toBe('Change 2 environments');
    expect(stepTitle({ type: 'access', key: { name: 'Deploy the worker' } } as never)).toBe(
      'New key: Deploy the worker',
    );
    expect(stepTitle({ type: 'change', key: { name: 'agent' } } as never)).toBe(
      'Change key: agent',
    );
    expect(stepTitle(secrets(['a']))).toBe('Change a secret');
    expect(stepTitle(secrets(['a', 'a', 'b', 'b', 'b']))).toBe(
      'Change 5 secrets in 2 environments',
    );
  });
});

describe('approveLabel', () => {
  it('names the action, and a delete is danger', () => {
    expect(approveLabel(environments(['create']))).toEqual({
      label: 'Create environment',
      working: 'Creating…',
      isDanger: false,
    });
    expect(approveLabel(environments(['delete']))).toMatchObject({
      label: 'Delete environment',
      isDanger: true,
    });
    expect(approveLabel(secrets(['a', 'b']))).toEqual({
      label: 'Approve 2 secret changes',
      working: 'Sealing…',
      isDanger: false,
    });
  });
});

describe('statusWord', () => {
  it('says how a step was answered, and nothing while it waits', () => {
    const created = { ...(environments(['create']) as object), status: 'approved' } as AskStep;
    expect(statusWord(created)).toBe('Created');
    expect(statusWord({ ...(secrets(['a']) as object), status: 'cancelled' } as AskStep)).toBe(
      'Withdrawn',
    );
    expect(statusWord({ ...(secrets(['a']) as object), status: 'pending' } as AskStep)).toBe(null);
  });
});

describe('stepsWords', () => {
  it('counts steps from 1', () => {
    expect(stepsWords([0])).toBe('step 1');
    expect(stepsWords([1, 2])).toBe('steps 2 and 3');
    expect(stepsWords([1, 2, 3])).toBe('steps 2, 3 and 4');
  });
});

describe('nextFocus', () => {
  type Step = AskStep & { readonly blocked?: Blocked };
  const step = (
    index: number,
    status: AskStep['status'],
    { waitsFor = [], blocked = null }: { waitsFor?: number[]; blocked?: Blocked } = {},
  ) => ({ index, status, waitsFor, blocked }) as never as Step;
  const blockedOf = (each: Step) => each.blocked ?? null;

  it('opens on the first step that can be answered', () => {
    const steps = [step(0, 'pending'), step(1, 'pending', { waitsFor: [0] })];
    expect(nextFocus(steps, blockedOf, -1)).toBe(0);
  });

  it('passes over a step that waits for an undecided one', () => {
    const steps = [step(0, 'pending'), step(1, 'pending', { waitsFor: [0] }), step(2, 'pending')];
    expect(nextFocus(steps, blockedOf, 0)).toBe(2);
  });

  it('counts a blocked step, as when the step it needed was rejected', () => {
    const steps = [
      step(0, 'rejected'),
      step(1, 'pending', { blocked: 'gone' }),
      step(2, 'pending', { blocked: 'gone' }),
    ];
    expect(nextFocus(steps, blockedOf, 0)).toBe(1);
  });

  it('goes back to an earlier step left undecided, then to one that waits', () => {
    const steps = [step(0, 'pending'), step(1, 'approved'), step(2, 'rejected')];
    expect(nextFocus(steps, blockedOf, 2)).toBe(0);
    const waiting = [step(0, 'approved'), step(1, 'pending', { waitsFor: [5] })];
    expect(nextFocus(waiting, blockedOf, 0)).toBe(1);
  });

  it('is null once nothing waits', () => {
    expect(nextFocus([step(0, 'approved'), step(1, 'expired')], blockedOf, 1)).toBe(null);
  });
});
