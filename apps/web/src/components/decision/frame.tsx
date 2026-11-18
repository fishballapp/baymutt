// The column of a decision page under its bar, as a decision, while loading, or as an outcome.
import type { ReactNode } from 'react';
import { Skeleton } from '../ui/list.tsx';

/**
 * `main.decide`: the one column of a decision page, under its bar. `isOutcome` is the column an
 * answered, missing or spent decision leaves: `main.decide.outcome`.
 */
export const DecisionColumn = ({
  isOutcome = false,
  children,
}: {
  readonly isOutcome?: boolean;
  readonly children: ReactNode;
}) => <main className={isOutcome ? 'decide outcome' : 'decide'}>{children}</main>;

/** A decision page while what it decides is on its way: four skeleton rows under the bar. */
export const DecisionLoading = () => (
  <DecisionColumn>
    <Skeleton rows={4} />
  </DecisionColumn>
);

/**
 * An outcome in the column's place: its heading, one sentence (`danger` for a failure, `warn` for
 * a link that cannot be used), and at most one way back, a `buttonClass({ size: 'lg' })` link.
 */
export const Outcome = ({
  title,
  tone,
  action,
  children,
}: {
  readonly title: string;
  readonly tone?: 'danger' | 'warn';
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) => (
  <DecisionColumn isOutcome>
    <h1>{title}</h1>
    <p className={tone}>{children}</p>
    {action}
  </DecisionColumn>
);
