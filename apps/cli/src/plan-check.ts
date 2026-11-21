// `baymutt ask --check`: what `ask` refuses about a plan before it talks to the store, and nothing
// else. Each `set` source is read as `ask` reads it, to see that it is there, and dropped: no value
// is kept, printed or named in a message.
import * as Effect from 'effect/Effect';
import type { PlanDocument } from './plan-document.ts';
import { checkCommand, endOf } from './plan-making.ts';
import { readProposedValue } from './proposed-values.ts';

const HOUR_MS = 3600 * 1000;

export const checkPlan = Effect.fn('plan.check')(function* (plan: PlanDocument) {
  for (const [index, step] of plan.steps.entries()) {
    const path = `steps[${index}]`;
    if (step.type === 'access') {
      if (step.command !== undefined) yield* checkCommand(step.command, path);
      yield* endOf(step.expires, step.command === undefined ? HOUR_MS : 'never', path);
    }
    if (step.type === 'change') yield* endOf(step.expires, 'keep', path);
    if (step.type !== 'secrets') continue;
    for (const [position, item] of step.items.entries()) {
      if (item.op !== 'set') continue;
      yield* readProposedValue({
        from: item.from,
        name: item.name,
        path: `${path}.items[${position}]`,
      });
    }
  }
});
