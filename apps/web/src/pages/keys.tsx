import { useAtomValue } from '@effect/atom-react';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useOwner } from '../components/gate.tsx';
import { KeyRow, keyWords } from '../components/keys.tsx';
import { useOrg } from '../components/org-scope.tsx';
import { useTitle } from '../components/shell.tsx';
import { buttonClass } from '../components/ui/button.tsx';
import { Filter, NoMatch, useFilter } from '../components/ui/filter.tsx';
import { EmptyState, Ended, List, Notice, Rows, Skeleton } from '../components/ui/list.tsx';
import { PageHead, PageTitle } from '../components/ui/page.tsx';
import { AccessWords, Address, accessText, Code } from '../components/ui/text.tsx';
import { WaitingList, WaitingRow } from '../components/waiting.tsx';
import {
  hasEnded,
  keyChangesAtom,
  kindOf,
  type OpenedKeyChange,
  type OpenedRequest,
  type OpenedRequestItem,
  type OpenedServiceAccount,
  requestsAtom,
  serviceAccountsAtom,
} from '../lib/data.ts';
import { counted } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

/** An environment a request or key change names, by its address. */
const ItemAddress = ({ item }: { readonly item: OpenedRequestItem }) => (
  <Address orgSlug={item.orgSlug} name={item.openedEnvironmentName} />
);

const RequestRow = ({ request }: { readonly request: OpenedRequest }) => (
  <WaitingRow
    ask={
      <>
        <b>{request.maker.name}</b> asks for a key it calls <b>{request.name}</b>
      </>
    }
    reason={request.reason}
    about={[
      ...request.items.map(item => (
        <>
          <ItemAddress item={item} />{' '}
          <AccessWords canRead={item.canRead} canWrite={item.canWrite} />
        </>
      )),
      ...(request.command === null
        ? []
        : [
            <>
              Its key goes into <Code>{request.command}</Code>
            </>,
          ]),
    ]}
    askedAt={request.createdAt}
    action={
      <Link
        to="/orgs/$slug/ask/access/$id"
        params={{ slug: request.org.slug, id: request.id }}
        className={buttonClass()}
      >
        Review
      </Link>
    }
  />
);

/** A key change waiting: what it adds (what it holds there in brackets) and what it gives back. */
const KeyChangeRow = ({ change }: { readonly change: OpenedKeyChange }) => (
  <WaitingRow
    ask={
      <>
        <b>{change.maker.name}</b> asks to change <b>{change.key.name}</b>
      </>
    }
    reason={change.reason}
    about={[
      ...change.add.map(item => {
        const held = change.holds.find(({ environmentId }) => environmentId === item.environmentId);
        return (
          <>
            adds <ItemAddress item={item} />{' '}
            <AccessWords canRead={item.canRead} canWrite={item.canWrite} />
            {held !== undefined && ` (holds ${accessText(held)})`}
          </>
        );
      }),
      ...change.giveBack.map(item => (
        <>
          gives back <ItemAddress item={item} />{' '}
          <AccessWords canRead={item.canRead} canWrite={item.canWrite} />
        </>
      )),
      ...(change.lifetime === null ? [] : ['asks for a new end']),
    ]}
    askedAt={change.createdAt}
    action={
      <Link
        to="/orgs/$slug/ask/change/$id"
        params={{ slug: change.org.slug, id: change.id }}
        className={buttonClass()}
      >
        Review
      </Link>
    }
  />
);

/** Requests for a new key and changes to one, newest first: what waits on the owner under Keys. */
const useWaitingRows = (): ReadonlyArray<ReactNode> => {
  const owner = useOwner();
  const org = useOrg();
  const requests = latest(useAtomValue(requestsAtom(owner))) ?? [];
  const changes = latest(useAtomValue(keyChangesAtom(owner))) ?? [];
  return [
    ...requests
      .filter(request => request.org.id === org.id)
      .map(request => ({
        at: request.createdAt,
        row: <RequestRow key={request.id} request={request} />,
      })),
    ...changes
      .filter(change => change.org.id === org.id)
      .map(change => ({
        at: change.createdAt,
        row: <KeyChangeRow key={change.id} change={change} />,
      })),
  ]
    .toSorted((a, b) => b.at - a.at)
    .map(({ row }) => row);
};

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
  const waiting = useWaitingRows();
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
        {active.length === 0 && waiting.length === 0 && !filter.isFiltering && (
          <EmptyState
            example={{
              lead: 'An agent asks for one like this:',
              commands: [
                `baymutt ask access --read ${org.slug}/app/production --reason "run the migration"`,
              ],
            }}
          >
            {org.name}’s keys show here once you approve an agent’s request.
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
      {waiting.length > 0 && <WaitingList>{waiting}</WaitingList>}
      {body}
    </>
  );
};
