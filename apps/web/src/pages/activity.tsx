import type { ActivityAction } from '@baymutt/api';
import { useAtomValue } from '@effect/atom-react';
import { Children, isValidElement, type ReactNode } from 'react';
import { useOwner } from '../components/gate.tsx';
import { useOrg } from '../components/org-scope.tsx';
import { useTitle } from '../components/shell.tsx';
import { Filter, NoMatch, useFilter } from '../components/ui/filter.tsx';
import { EmptyState, List, Notice, Row, Rows, Skeleton } from '../components/ui/list.tsx';
import { PageHead, PageTitle, RelativeTime } from '../components/ui/page.tsx';
import { AccessWords, Address, accessText, Code, SealedName } from '../components/ui/text.tsx';
import { activityAtom, addressOf, NAME_NOT_OPENED, type OpenedActivityEvent } from '../lib/data.ts';
import { clockTime, dayLabel, dayOf } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

/** The store returns at most this many entries. */
const ACTIVITY_LIMIT = 100;

/** An entry with the slug of the org it happened in, which its environment's address starts with. */
type Entry = OpenedActivityEvent & { readonly orgSlug: string };

const environment = ({ orgSlug, openedEnvironmentName }: Entry) => (
  <Address orgSlug={orgSlug} name={openedEnvironmentName} />
);
const secret = ({ openedSecretName, version }: Entry) => (
  <>
    <SealedName name={openedSecretName} />
    {version !== null && ` (v${version})`}
  </>
);

/** The access words a grant's detail ends with, as the Worker writes them. */
const GRANTED: Readonly<
  Record<string, { readonly canRead: boolean; readonly canWrite: boolean } | undefined>
> = {
  read: { canRead: true, canWrite: false },
  write: { canRead: false, canWrite: true },
  'read + write': { canRead: true, canWrite: true },
};

/**
 * A grant's detail is "<key>: <read + write>": as a sentence, "read and write for <key>".
 * Anything else is shown as it came.
 */
const grantDetail = ({ detail }: Entry) => {
  const split = detail?.lastIndexOf(': ') ?? -1;
  if (detail === null || split === -1) return detail;
  const granted = GRANTED[detail.slice(split + 2)];
  if (granted === undefined) return detail;
  return (
    <>
      <AccessWords {...granted} /> for {detail.slice(0, split)}
    </>
  );
};

/**
 * A day as the Worker writes it into a detail (`2026-12-01`, the UTC day of the moment), in the
 * dashboard's words: "Dec 1, 2026". Every stored row has the day alone, so no time is shown. Words
 * that are not a day stay as they are.
 */
const dayWords = (words: string): string =>
  /^\d{4}-\d{2}-\d{2}$/.test(words)
    ? Temporal.PlainDate.from(words).toLocaleString('en', { dateStyle: 'medium' })
    : words;

/** "until 2026-12-01" as "until Dec 1, 2026". */
const untilWords = (end: string): string =>
  end.startsWith('until ') ? `until ${dayWords(end.slice('until '.length))}` : end;

/** How a key change's detail names the end it left the key with; any other is `until <day>`. */
const CHANGED_ENDS: Record<string, string> = { 'same end': '', 'no end': ', with no end' };

/** What happened, as the rest of a sentence that starts with who did it. */
const DEEDS: Record<ActivityAction, (event: Entry) => ReactNode> = {
  'account.create': () => 'created the account',
  'passkey.add': () => 'added a passkey that unlocks the vault',
  'passkey.remove': () => 'removed a passkey',
  'password.set': () => 'set a new password',
  'password.remove': () => 'removed the password',
  'recovery.rotate': () => 'made a new recovery key',
  'credential.pair': ({ detail }) => <>approved the CLI login {detail}</>,
  'credential.create': ({ detail }) => <>made the key {detail}</>,
  'request.create': ({ detail }) => <>asked for a key, {detail}</>,
  'request.approve': ({ detail }) => {
    // "<key>: <until …, or no end>", as `credential.expiry` writes its detail.
    const split = detail?.lastIndexOf(': ') ?? -1;
    if (detail === null || split === -1) return <>approved the request {detail}</>;
    const end = detail.slice(split + 2);
    return (
      <>
        approved the request {detail.slice(0, split)},{' '}
        {end === 'no end' ? 'with no end' : untilWords(end)}
      </>
    );
  },
  'request.reject': ({ detail }) => <>rejected the request {detail}</>,
  'request.expire': ({ detail }) => <>expired the request {detail}, unanswered for an hour</>,
  'key-change.create': ({ detail }) => <>asked to change the key {detail}</>,
  'key-change.approve': ({ detail }) => {
    // "<key>: <until …, no end, or same end>".
    const split = detail?.lastIndexOf(': ') ?? -1;
    if (detail === null || split === -1) return <>approved a change to {detail}</>;
    const end = detail.slice(split + 2);
    return (
      <>
        approved a change to {detail.slice(0, split)}
        {CHANGED_ENDS[end] ?? `, ${untilWords(end)}`}
      </>
    );
  },
  'key-change.reject': ({ detail }) => <>rejected a change to {detail}</>,
  'key-change.expire': ({ detail }) => <>expired a change to {detail}, unanswered for an hour</>,
  'credential.revoke': ({ detail }) => {
    // The nightly sweep writes "<key>: ended on <day>"; the owner's revoke writes the name alone.
    const [name, ended] = detail?.split(': ended on ') ?? [];
    if (ended === undefined) return <>revoked {detail}</>;
    return (
      <>
        revoked {name}, which ended on {dayWords(ended)}
      </>
    );
  },
  'credential.expiry': ({ detail }) => {
    const split = detail?.lastIndexOf(': ') ?? -1;
    if (detail === null || split === -1) return <>changed when {detail} expires</>;
    const when = detail.slice(split + 2);
    return (
      <>
        set {detail.slice(0, split)} to{' '}
        {when === 'never' ? 'never expire' : `expire on ${dayWords(when)}`}
      </>
    );
  },
  'org.create': ({ detail }) => (
    <>
      created the org <Code>{detail}</Code>
    </>
  ),
  'org.delete': ({ detail }) => <>deleted the org {detail}</>,
  'names.seal': () => 'sealed the names of the org’s environments and secrets',
  'environment.create': event => <>created {environment(event)}</>,
  'environment-request.create': event => (
    <>
      asked for a new environment, {environment(event)}
      {event.detail !== null && `: “${event.detail}”`}
    </>
  ),
  'environment-request.reject': event => (
    <>rejected the request for a new environment, {environment(event)}</>
  ),
  'environment.delete': event => <>deleted {environment(event)}</>,
  'environment.restore': event => <>restored {environment(event)} from the bin</>,
  'environment.purge': event => (
    <>
      removed {environment(event)} for good{event.detail !== null && `, ${event.detail}`}
    </>
  ),
  'environment.load': event => <>loaded {environment(event)}</>,
  'secret.write': event => (
    <>
      wrote {secret(event)} in {environment(event)}
    </>
  ),
  'secret.delete': event => (
    <>
      deleted {secret(event)} in {environment(event)}
    </>
  ),
  'secret.rollback': event =>
    event.detail === 'from the bin' ? (
      <>
        restored {secret(event)} in {environment(event)} from the bin
      </>
    ) : (
      <>
        rolled {secret(event)} back in {environment(event)}
      </>
    ),
  'secret.purge': event => (
    <>
      removed {secret(event)} in {environment(event)} for good
      {event.detail !== null && `, ${event.detail}`}
    </>
  ),
  'secret.reveal': event => (
    <>
      revealed or copied {secret(event)} in {environment(event)}
    </>
  ),
  'grant.set': event => (
    <>
      set {grantDetail(event)} on {environment(event)}
    </>
  ),
  'grant.remove': event => (
    <>
      removed {event.detail}’s access to {environment(event)}
    </>
  ),
  'paste-link.create': event => (
    <>
      made a paste link for {secret(event)} in {environment(event)}
    </>
  ),
  'paste-link.fulfil': event => (
    <>
      pasted {secret(event)} into {environment(event)}
    </>
  ),
  'paste-link.cancel': event => (
    <>
      dismissed the paste link for {secret(event)} in {environment(event)}
    </>
  ),
};

/**
 * A sentence's words, for the filter: the text in it, the access words `AccessWords` draws from
 * its props, then (passed beside it) its address and secret name, which `Address` and
 * `SealedName` draw from props too.
 */
const textOf = (node: ReactNode): string =>
  Children.toArray(node)
    .map(child => {
      if (typeof child === 'string' || typeof child === 'number') return String(child);
      if (isValidElement<Parameters<typeof AccessWords>[0]>(child) && child.type === AccessWords) {
        return accessText(child.props);
      }
      if (!isValidElement<{ readonly children?: ReactNode }>(child)) return '';
      return textOf(child.props.children);
    })
    .join('');

/** One day's entries, newest first, each the actor's name, what they did and the clock time. */
const Day = ({
  day,
  entries,
  note,
}: {
  readonly day: number;
  readonly entries: ReadonlyArray<{ readonly event: Entry; readonly sentence: ReactNode }>;
  readonly note?: string;
}) => (
  <List title={dayLabel(day, Date.now())} note={note}>
    <Rows>
      {entries.map(({ event, sentence }) => (
        <Row key={event.id} variant="row-activity">
          <p>
            <b>{event.actor.name}</b> {sentence}
          </p>
          <RelativeTime at={event.at}>{() => clockTime(event.at)}</RelativeTime>
        </Row>
      ))}
    </Rows>
  </List>
);

export const ActivityPage = () => {
  const org = useOrg();
  useTitle('Activity', org.name);
  const result = useAtomValue(activityAtom(useOwner())(org.id));
  const failure = failureMessage(result);
  const events = latest(result);
  const filter = useFilter(events?.length ?? 0);
  const entries = (events ?? [])
    .map(event => {
      const entry = { ...event, orgSlug: org.slug };
      return { event: entry, sentence: DEEDS[event.action](entry) };
    })
    .filter(({ event, sentence }) =>
      filter.matches(
        `${event.actor.name} ${textOf(sentence)}`,
        event.environmentName === null
          ? ''
          : addressOf({ orgSlug: org.slug, name: event.openedEnvironmentName }),
        event.secretName === null ? '' : (event.openedSecretName ?? NAME_NOT_OPENED),
      ),
    );
  // Newest first, so each day's entries stay in the order they came.
  const days = [...Map.groupBy(entries, ({ event }) => dayOf(event.at))];
  const body = (() => {
    if (failure !== null) return <Notice tone="danger">{failure}</Notice>;
    if (events === null) return <Skeleton />;
    if (events.length === 0) {
      return (
        <EmptyState>
          Every load, write and approval in {org.name} shows here as it happens.
        </EmptyState>
      );
    }
    if (days.length === 0) {
      return (
        <NoMatch filter={filter}>
          Nothing in {org.name}’s activity matches “{filter.query.trim()}”.
        </NoMatch>
      );
    }
    return days.map(([day, dayEntries], index) => (
      <Day
        key={day}
        day={day}
        entries={dayEntries}
        note={
          index === days.length - 1 && events.length >= ACTIVITY_LIMIT
            ? 'The last 100 entries.'
            : undefined
        }
      />
    ));
  })();
  return (
    <>
      <PageHead
        title={<PageTitle>Activity</PageTitle>}
        filter={filter.isShown && <Filter filter={filter} placeholder="who or what" />}
      />
      {body}
    </>
  );
};
