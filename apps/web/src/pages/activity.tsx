import type { ActivityAction, ActivityEvent, Org } from '@baymutt/api';
import { useAtomValue } from '@effect/atom-react';
import type { ReactNode } from 'react';
import { usePickedOrg } from '../components/orgs.tsx';
import { Code, Empty, Notice, PageHeader, Skeleton } from '../components/parts.tsx';
import { activityAtom } from '../lib/data.ts';
import { clockTime, dayLabel, dayOf, exactTime } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

const environment = ({ environmentName }: ActivityEvent) => <Code>{environmentName}</Code>;
const secret = ({ secretName, version }: ActivityEvent) => (
  <>
    <Code>{secretName}</Code>
    {version !== null && ` (v${version})`}
  </>
);

/**
 * A grant's detail is "<service account>: <read + write>": as a sentence, "<read + write> for <service account>".
 * Anything else is shown as it came.
 */
const grantDetail = ({ detail }: ActivityEvent) => {
  const split = detail?.lastIndexOf(': ') ?? -1;
  if (detail === null || split === -1) return detail;
  return `${detail.slice(split + 2)} for ${detail.slice(0, split)}`;
};

/** What happened, as the rest of a sentence that starts with who did it. */
const DEEDS: Record<ActivityAction, (event: ActivityEvent) => ReactNode> = {
  'account.create': () => 'created the account',
  'passkey.add': () => 'added a passkey that opens the vault',
  'passkey.remove': () => 'removed a passkey',
  'password.set': () => 'set a new password',
  'password.remove': () => 'removed the password',
  'recovery.rotate': () => 'made a new recovery key',
  'credential.pair': ({ detail }) => <>approved the CLI login {detail}</>,
  'credential.create': ({ detail }) => <>made the service account {detail}</>,
  'credential.revoke': ({ detail }) => <>revoked {detail}</>,
  'credential.expiry': ({ detail }) => {
    const split = detail?.lastIndexOf(': ') ?? -1;
    if (detail === null || split === -1) return <>changed when {detail} expires</>;
    const when = detail.slice(split + 2);
    return (
      <>
        set {detail.slice(0, split)} to {when === 'never' ? 'never expire' : `expire on ${when}`}
      </>
    );
  },
  'org.create': ({ detail }) => (
    <>
      created the org <Code>{detail}</Code>
    </>
  ),
  'org.delete': ({ detail }) => <>deleted the org {detail}</>,
  'environment.create': event => <>created {environment(event)}</>,
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

/** An org's entries, each environment named by its address; the account's own name none. */
const OrgActivity = ({ org }: { readonly org: Org }) => {
  const result = useAtomValue(activityAtom(org.id));
  const events = latest(result);
  const now = Date.now();
  // Newest first, so each day's entries stay in the order they came.
  const days = Map.groupBy(events ?? [], event => dayOf(event.at));
  return (
    <>
      {failureMessage(result) && <Notice>{failureMessage(result)}</Notice>}
      {events === null && !failureMessage(result) && <Skeleton rows={6} />}
      {events?.length === 0 && (
        <Empty title="Nothing has happened yet">
          <p>Every load, write and grant is listed here once there is one.</p>
        </Empty>
      )}
      <div className="space-y-8">
        {[...days].map(([day, entries]) => (
          <section key={day} aria-labelledby={`day-${day}`}>
            <h2 id={`day-${day}`} className="mb-2 text-sm font-medium text-muted tracking-normal">
              {dayLabel(day, now)}
            </h2>
            <ol className="divide-y divide-line overflow-hidden rounded-panel border border-line bg-surface">
              {entries.map(event => (
                <li
                  key={event.id}
                  className="flex flex-col gap-x-6 gap-y-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline"
                >
                  <p className="min-w-0 flex-1">
                    <span className="font-medium">{event.actor.name}</span>{' '}
                    {DEEDS[event.action]({
                      ...event,
                      environmentName:
                        event.environmentName === null
                          ? null
                          : `${org.slug}/${event.environmentName}`,
                    })}
                  </p>
                  <time
                    dateTime={Temporal.Instant.fromEpochMilliseconds(event.at).toString({
                      fractionalSecondDigits: 3,
                    })}
                    title={exactTime(event.at)}
                    className="shrink-0 text-sm whitespace-nowrap text-muted sm:text-right"
                  >
                    {clockTime(event.at)}
                  </time>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </>
  );
};

export const ActivityPage = () => {
  const { orgs, org } = usePickedOrg();
  return (
    <>
      <PageHeader
        title="Activity"
        lede={`Who loaded, wrote or granted what${org === null ? '' : ` in ${org.name}`}, and what was done to your account, newest first. The last 100 entries.`}
      />
      {org !== null && <OrgActivity org={org} />}
      {orgs === null && <Skeleton rows={6} />}
      {orgs?.length === 0 && (
        <Empty title="No org yet">
          <p>Activity is kept per org. Create one under Environments.</p>
        </Empty>
      )}
    </>
  );
};
