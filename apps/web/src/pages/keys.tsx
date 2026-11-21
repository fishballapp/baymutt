import { useAtomValue } from '@effect/atom-react';
import { useState } from 'react';
import { useOwner } from '../components/gate.tsx';
import { KeyRow, keyWords } from '../components/keys.tsx';
import { useOrg } from '../components/org-scope.tsx';
import { useTitle } from '../components/shell.tsx';
import { Filter, NoMatch, useFilter } from '../components/ui/filter.tsx';
import { EmptyState, Ended, List, Notice, Rows, Skeleton } from '../components/ui/list.tsx';
import { PageHead, PageTitle } from '../components/ui/page.tsx';
import { hasEnded, kindOf, type OpenedServiceAccount, serviceAccountsAtom } from '../lib/data.ts';
import { counted } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

const LISTS = [
  { kind: 'service-account', title: 'Service accounts' },
  { kind: 'agent', title: 'Agent keys' },
] as const;

export const KeysPage = () => {
  const org = useOrg();
  useTitle('Keys', org.name);
  const result = useAtomValue(serviceAccountsAtom(useOwner()));
  const all = latest(result);
  const failure = failureMessage(result);
  const ofOrg = all?.filter(key => key.org?.id === org.id) ?? null;
  const filter = useFilter(ofOrg?.length ?? 0);
  // Here, not in the section: a filter that matches no key takes the section off the page, and
  // clearing it brings the section back open or closed as it was.
  const [isEndedOpen, setEndedOpen] = useState(false);
  const now = Date.now();
  const shown = (ofOrg ?? []).filter(key => filter.matches(...keyWords(key)));
  const active = shown.filter(key => !hasEnded(key, now));
  const ended = shown
    .filter(key => hasEnded(key, now))
    .toSorted((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0));
  const allEnded = (ofOrg ?? []).filter(key => hasEnded(key, now)).length;
  const row = (key: OpenedServiceAccount) => (
    <KeyRow key={key.id} keyToShow={key} maker={all?.find(({ id }) => id === key.parentId)} />
  );
  const body = (() => {
    if (failure !== null) return <Notice tone="danger">{failure}</Notice>;
    if (ofOrg === null) return <Skeleton />;
    if (filter.isFiltering && shown.length === 0) {
      return (
        <NoMatch filter={filter}>
          No key in {org.name} matches “{filter.query.trim()}”.
        </NoMatch>
      );
    }
    return (
      <>
        {LISTS.map(({ kind, title }) => {
          const keys = active
            .filter(key => kindOf(key) === kind)
            .toSorted((a, b) => b.createdAt - a.createdAt);
          if (keys.length === 0) return null;
          return (
            <List key={kind} title={title} count={filter.isFiltering ? undefined : keys.length}>
              <Rows>{keys.map(row)}</Rows>
            </List>
          );
        })}
        {active.length === 0 && !filter.isFiltering && (
          <EmptyState
            example={{
              lead: 'An agent asks for one with an `access` step:',
              commands: ['baymutt ask ask.json'],
            }}
          >
            {org.name}’s keys show here once you approve an agent’s ask.
          </EmptyState>
        )}
        {ended.length > 0 && (
          <Ended
            showLabel={`Show ${counted(allEnded, 'ended key')}`}
            hideLabel="Hide ended keys"
            isForcedOpen={filter.isFiltering}
            open={isEndedOpen}
            onOpenChange={setEndedOpen}
          >
            {ended.map(row)}
          </Ended>
        )}
      </>
    );
  })();
  return (
    <>
      <PageHead
        title={<PageTitle>Keys</PageTitle>}
        filter={filter.isShown && <Filter filter={filter} placeholder="name or environment" />}
      />
      {body}
    </>
  );
};
