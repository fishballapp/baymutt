// Asks: what an agent asked of the owner and is still waiting on, one waiting row per ask, each
// answered on its own page.
import { useAtomValue } from '@effect/atom-react';
import { Link } from '@tanstack/react-router';
import { AskWords } from '../components/decision/ask-step.tsx';
import { useOrg } from '../components/org-scope.tsx';
import { useTitle } from '../components/shell.tsx';
import { buttonClass } from '../components/ui/button.tsx';
import { EmptyState, Notice, Skeleton } from '../components/ui/list.tsx';
import { PageHead, PageTitle } from '../components/ui/page.tsx';
import { WaitingList, WaitingRow } from '../components/waiting.tsx';
import { stepTitle } from '../lib/asks.ts';
import { pendingAsksAtom } from '../lib/data.ts';
import { failureMessage, latest } from '../lib/result.ts';

export const AsksPage = () => {
  const org = useOrg();
  useTitle('Asks', org.name);
  const result = useAtomValue(pendingAsksAtom);
  const failure = failureMessage(result);
  const asks = latest(result)?.filter(ask => ask.org.id === org.id) ?? null;
  const body = (() => {
    if (failure !== null) return <Notice tone="danger">{failure}</Notice>;
    if (asks === null) return <Skeleton />;
    if (asks.length === 0) {
      return (
        <EmptyState
          example={{
            lead: 'An agent asks from the CLI:',
            commands: ['baymutt ask ask.json'],
          }}
        >
          No asks waiting
        </EmptyState>
      );
    }
    return (
      <WaitingList>
        {asks.map(ask => {
          const waiting = ask.steps.filter(({ status }) => status === 'pending');
          return (
            <WaitingRow
              key={ask.id}
              ask={<AskWords ask={ask} />}
              reason={ask.reason}
              about={
                ask.steps.length === 1
                  ? []
                  : waiting.map(step => (
                      <>
                        <span className="num">{step.index + 1}</span> {stepTitle(step)}
                      </>
                    ))
              }
              askedAt={ask.createdAt}
              action={
                <Link
                  to="/orgs/$slug/ask/$id"
                  params={{ slug: org.slug, id: ask.id }}
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
      <PageHead title={<PageTitle>Asks</PageTitle>} />
      {body}
    </>
  );
};
