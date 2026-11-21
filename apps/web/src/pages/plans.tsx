// Plans: what an agent asked of the owner and is still waiting on, one waiting row per plan, each
// answered on its own page.
import { useAtomValue } from '@effect/atom-react';
import { Link } from '@tanstack/react-router';
import { AskWords } from '../components/decision/plan-step.tsx';
import { useOrg } from '../components/org-scope.tsx';
import { useTitle } from '../components/shell.tsx';
import { buttonClass } from '../components/ui/button.tsx';
import { EmptyState, Notice, Skeleton } from '../components/ui/list.tsx';
import { PageHead, PageTitle } from '../components/ui/page.tsx';
import { WaitingList, WaitingRow } from '../components/waiting.tsx';
import { pendingPlansAtom } from '../lib/data.ts';
import { stepTitle } from '../lib/plans.ts';
import { failureMessage, latest } from '../lib/result.ts';

export const PlansPage = () => {
  const org = useOrg();
  useTitle('Plans', org.name);
  const result = useAtomValue(pendingPlansAtom);
  const failure = failureMessage(result);
  const plans = latest(result)?.filter(plan => plan.org.id === org.id) ?? null;
  const body = (() => {
    if (failure !== null) return <Notice tone="danger">{failure}</Notice>;
    if (plans === null) return <Skeleton />;
    if (plans.length === 0) {
      return (
        <EmptyState
          example={{
            lead: 'An agent can send a plan from the CLI:',
            commands: ['baymutt ask plan.json'],
          }}
        >
          No plans waiting
        </EmptyState>
      );
    }
    return (
      <WaitingList>
        {plans.map(plan => {
          const waiting = plan.steps.filter(({ status }) => status === 'pending');
          return (
            <WaitingRow
              key={plan.id}
              ask={<AskWords plan={plan} />}
              reason={plan.reason}
              about={
                plan.steps.length === 1
                  ? []
                  : waiting.map(step => (
                      <>
                        <span className="num">{step.index + 1}</span> {stepTitle(step)}
                      </>
                    ))
              }
              askedAt={plan.createdAt}
              action={
                <Link
                  to="/orgs/$slug/ask/$id"
                  params={{ slug: org.slug, id: plan.id }}
                  className={buttonClass()}
                >
                  Review
                </Link>
              }
            />
          );
        })}
      </WaitingList>
    );
  })();
  return (
    <>
      <PageHead title={<PageTitle>Plans</PageTitle>} />
      {body}
    </>
  );
};
