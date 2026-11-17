import { useAtomValue } from '@effect/atom-react';
import { Link } from '@tanstack/react-router';
import { useOwner } from '../components/gate.tsx';
import { EndedKeys, KeyRows } from '../components/keys.tsx';
import { useOrg } from '../components/orgs.tsx';
import {
  Code,
  CommandLine,
  Empty,
  grantWords,
  Notice,
  PageHeader,
  Row,
  Rows,
  Section,
  Skeleton,
  Time,
} from '../components/parts.tsx';
import { buttonStyles } from '../components/ui/button.tsx';
import {
  addressOf,
  hasEnded,
  keyChangesAtom,
  kindOf,
  type OpenedKeyChange,
  type OpenedRequest,
  requestsAtom,
  serviceAccountsAtom,
} from '../lib/data.ts';
import { failureMessage, latest } from '../lib/result.ts';

/** One request waiting for the owner, as a sentence: who asks for what. Its decision is on its own page. */
const RequestRow = ({ request }: { readonly request: OpenedRequest }) => (
  <Row>
    <div className="flex flex-col gap-x-4 gap-y-2 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <p>
          <span className="font-medium">{request.maker.name}</span> asks for{' '}
          {request.items.map((item, index) => (
            <span key={item.environmentId}>
              {index > 0 && ', '}
              <Code>{addressOf({ orgSlug: item.orgSlug, name: item.openedEnvironmentName })}</Code>{' '}
              <span className="text-muted">({grantWords(item)})</span>
            </span>
          ))}
        </p>
        <p className="mt-1.5 max-w-[65ch] border-line border-l pl-3 text-sm text-muted [overflow-wrap:anywhere]">
          {request.reason}
        </p>
        <p className="mt-1.5 text-sm text-muted">
          asked <Time at={request.createdAt} />
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5 sm:shrink-0">
        <Link
          to="/orgs/$slug/ask/access/$id"
          params={{ slug: request.org.slug, id: request.id }}
          className={buttonStyles()}
        >
          Review
        </Link>
      </div>
    </div>
  </Row>
);

/** An environment of a change, by its address, with what the line says of it. */
const Changed = ({
  items,
  sign,
}: {
  readonly items: OpenedKeyChange['add'];
  readonly sign: string;
}) =>
  items.map((item, index) => (
    <span key={item.environmentId}>
      {index > 0 && ', '}
      <Code>{addressOf({ orgSlug: item.orgSlug, name: item.openedEnvironmentName })}</Code>{' '}
      <span className="text-muted">
        ({sign} {grantWords(item)})
      </span>
    </span>
  ));

/** One change to a key, waiting for the owner, as a sentence: who asks to change which key, and how. */
const KeyChangeRow = ({ change }: { readonly change: OpenedKeyChange }) => (
  <Row>
    <div className="flex flex-col gap-x-4 gap-y-2 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <p>
          <span className="font-medium">{change.maker.name}</span> asks to change{' '}
          <span className="font-medium">{change.key.name}</span>
          {change.add.length > 0 && (
            <>
              : adds <Changed items={change.add} sign="+" />
            </>
          )}
          {change.giveBack.length > 0 && (
            <>
              {change.add.length > 0 ? '; gives back ' : ': gives back '}
              <Changed items={change.giveBack} sign="−" />
            </>
          )}
          {change.lifetime !== null && (
            <span className="text-muted">
              {change.add.length + change.giveBack.length > 0 ? '; ' : ': '}a new end
            </span>
          )}
        </p>
        <p className="mt-1.5 max-w-[65ch] border-line border-l pl-3 text-sm text-muted [overflow-wrap:anywhere]">
          {change.reason}
        </p>
        <p className="mt-1.5 text-sm text-muted">
          asked <Time at={change.createdAt} />
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5 sm:shrink-0">
        <Link
          to="/orgs/$slug/ask/change/$id"
          params={{ slug: change.org.slug, id: change.id }}
          className={buttonStyles()}
        >
          Review
        </Link>
      </div>
    </div>
  </Row>
);

/** What waits for the owner in the org: requests for a new key, and changes to one. */
const Requests = () => {
  const owner = useOwner();
  const org = useOrg();
  const requests = (latest(useAtomValue(requestsAtom(owner))) ?? []).filter(
    request => request.org.id === org.id,
  );
  const changes = (latest(useAtomValue(keyChangesAtom(owner))) ?? []).filter(
    change => change.org.id === org.id,
  );
  if (requests.length === 0 && changes.length === 0) return null;
  return (
    <Section title="Requests" lede="Each waits for you: a new key, or a change to one.">
      <Rows>
        {[
          ...requests.map(request => ({
            at: request.createdAt,
            row: <RequestRow key={request.id} request={request} />,
          })),
          ...changes.map(change => ({
            at: change.createdAt,
            row: <KeyChangeRow key={change.id} change={change} />,
          })),
        ]
          .toSorted((a, b) => b.at - a.at)
          .map(({ row }) => row)}
      </Rows>
    </Section>
  );
};

export const KeysPage = () => {
  const org = useOrg();
  const result = useAtomValue(serviceAccountsAtom(useOwner()));
  const all = latest(result);
  const ofOrg = all?.filter(key => key.org?.id === org.id) ?? null;
  const shown = ofOrg?.filter(key => !hasEnded(key, Date.now())) ?? [];
  const sections = [
    {
      title: 'Service accounts',
      lede: 'Keys made for another system, such as CI.',
      keys: shown.filter(key => kindOf(key) === 'service-account'),
    },
    {
      title: 'Agent keys',
      lede: 'Keys an agent asked for, for its own work.',
      keys: shown.filter(key => kindOf(key) === 'agent'),
    },
  ];
  return (
    <>
      <PageHeader
        title="Keys"
        lede={`A key of ${org.name} reaches what you approved for it, in ${org.name} alone. CLI logins are your account’s, under Account.`}
      />
      <Requests />
      {failureMessage(result) && <Notice>{failureMessage(result)}</Notice>}
      {ofOrg === null && !failureMessage(result) && <Skeleton />}
      {ofOrg?.length === 0 && (
        <Empty title={`No keys in ${org.name} yet`}>
          <p>A CLI login asks you for one:</p>
          <CommandLine>{`baymutt ask access --read ${org.slug}/<environment> --reason "<why>"`}</CommandLine>
          <p>The request waits here until you approve or reject it.</p>
        </Empty>
      )}
      {sections.map(
        ({ title, lede, keys }) =>
          keys.length > 0 && (
            <Section key={title} title={title} lede={lede}>
              <KeyRows keys={keys} all={all ?? []} />
            </Section>
          ),
      )}
      {ofOrg !== null && <EndedKeys keys={ofOrg} all={all ?? []} />}
    </>
  );
};
