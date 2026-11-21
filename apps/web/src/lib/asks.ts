// What the ask page says about a step and where its focus goes, from the step alone: plain
// functions over the API's shapes, so a step reads the same in the outline, its heading, the
// Asks list and an outcome.
import type { AskStep, StepStatus } from '@baymutt/api';

type EnvironmentOp = Extract<AskStep, { type: 'environments' }>['items'][number]['op'];

/** The one op every item of an environments step has, or null when they differ. */
const soleOp = (step: Extract<AskStep, { type: 'environments' }>): EnvironmentOp | null => {
  const ops = new Set(step.items.map(({ op }) => op));
  const [op] = ops;
  return ops.size === 1 && op !== undefined ? op : null;
};

/** Each environment op: its step title and button, one and many, its status word and pending label. */
const ENVIRONMENT_OPS = {
  create: {
    titleOne: () => 'Create an environment',
    titleMany: (count: number) => `Create ${count} environments`,
    buttonOne: () => 'Create environment',
    buttonMany: (count: number) => `Create ${count} environments`,
    done: 'Created',
    working: 'Creating…',
  },
  delete: {
    titleOne: () => 'Delete an environment',
    titleMany: (count: number) => `Delete ${count} environments`,
    buttonOne: () => 'Delete environment',
    buttonMany: (count: number) => `Delete ${count} environments`,
    done: 'Deleted',
    working: 'Deleting…',
  },
  restore: {
    titleOne: () => 'Restore an environment',
    titleMany: (count: number) => `Restore ${count} environments`,
    buttonOne: () => 'Restore environment',
    buttonMany: (count: number) => `Restore ${count} environments`,
    done: 'Restored',
    working: 'Restoring…',
  },
} as const satisfies Record<EnvironmentOp, unknown>;

/** The items of a secrets step that carry a value sealed here on approval. */
export const isValueItem = (item: { readonly op: string }): boolean =>
  item.op === 'set' || item.op === 'paste' || item.op === 'generate';

/**
 * What a step does, in a few words: its heading, its line in the outline and on the Asks list.
 * One placeholder per wording.
 */
export const stepTitle = (step: AskStep): string => {
  if (step.type === 'access') return `New key: ${step.key.name}`;
  if (step.type === 'change') return `Change key: ${step.key.name}`;
  const count = step.items.length;
  if (step.type === 'environments') {
    const op = soleOp(step);
    if (op === null) return `Change ${count} environments`;
    return count === 1 ? ENVIRONMENT_OPS[op].titleOne() : ENVIRONMENT_OPS[op].titleMany(count);
  }
  const environments = new Set(step.items.map(({ environmentId }) => environmentId)).size;
  if (environments > 1) return `Change ${count} secrets in ${environments} environments`;
  return count === 1 ? 'Change a secret' : `Change ${count} secrets`;
};

/** The step's primary button, and what it says while it runs. */
export const approveLabel = (
  step: AskStep,
): { readonly label: string; readonly working: string; readonly isDanger: boolean } => {
  if (step.type === 'access') {
    return { label: 'Approve key', working: 'Approving…', isDanger: false };
  }
  if (step.type === 'change') {
    return { label: 'Approve change', working: 'Approving…', isDanger: false };
  }
  if (step.type === 'secrets') {
    return {
      label:
        step.items.length === 1
          ? 'Approve secret change'
          : `Approve ${step.items.length} secret changes`,
      working: step.items.some(isValueItem) ? 'Sealing…' : 'Approving…',
      isDanger: false,
    };
  }
  const op = soleOp(step);
  const isDanger = step.items.some(({ op: each }) => each === 'delete');
  if (op === null) {
    return {
      label: `Approve ${step.items.length} environment changes`,
      working: 'Approving…',
      isDanger,
    };
  }
  const { buttonOne, buttonMany, working } = ENVIRONMENT_OPS[op];
  return {
    label: step.items.length === 1 ? buttonOne() : buttonMany(step.items.length),
    working,
    isDanger,
  };
};

/** How an answered step reads: "Created", "Approved", "Rejected". Null while it waits. */
export const statusWord = (step: AskStep): string | null => {
  const word: Record<StepStatus, string | null> = {
    pending: null,
    approved: (() => {
      if (step.type !== 'environments') return 'Approved';
      const op = soleOp(step);
      return op === null ? 'Approved' : ENVIRONMENT_OPS[op].done;
    })(),
    applied: 'Applied',
    rejected: 'Rejected',
    expired: 'Expired',
    cancelled: 'Withdrawn',
  };
  return word[step.status];
};

/** "step 2", "steps 2 and 3", "steps 2, 3 and 4": steps by their place, counted from 1. */
export const stepsWords = (indexes: ReadonlyArray<number>): string => {
  const numbers = indexes.map(index => String(index + 1));
  if (numbers.length <= 1) return `step ${numbers.join('')}`;
  return `steps ${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`;
};

/**
 * Why a pending step is blocked (rejecting is all that is left), as the page judges it: the store says something it
 * needs is gone, or what the page must show to approve it does not open here.
 */
export type Blocked = 'gone' | 'unopened' | 'unverified' | null;

/** A step the owner can answer now: pending, and not waiting for an earlier one (or only rejectable). */
export const isDecidable = (step: AskStep, blocked: Blocked): boolean =>
  step.status === 'pending' && (step.waitsFor.length === 0 || blocked !== null);

/**
 * Where focus goes after step `after` is answered: the next step that can be answered now, then
 * the first such step before it; with none, the first still pending; null when none waits.
 * `after` is -1 when the page opens.
 */
export const nextFocus = <S extends AskStep>(
  steps: ReadonlyArray<S>,
  blockedOf: (step: S) => Blocked,
  after: number,
): number | null => {
  const decidable = steps.filter(step => isDecidable(step, blockedOf(step)));
  return (
    (
      decidable.find(({ index }) => index > after) ??
      decidable[0] ??
      steps.find(({ status }) => status === 'pending')
    )?.index ?? null
  );
};
