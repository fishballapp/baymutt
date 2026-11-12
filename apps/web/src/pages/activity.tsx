import type { AuditAction, AuditEvent } from '@baymutt/api';
import { useAtomValue } from '@effect/atom-react';
import type { ReactNode } from 'react';
import { Code, Empty, Notice, PageHeader, Skeleton } from '../components/parts.tsx';
import { auditAtom } from '../lib/data.ts';
import { clockTime, dayLabel, dayOf, exactTime } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

const project = ({ projectName }: AuditEvent) => <Code>{projectName}</Code>;
const secret = ({ secretName, version }: AuditEvent) => (
  <>
    <Code>{secretName}</Code>
    {version !== null && ` (v${version})`}
  </>
);

/**
 * A grant's detail is "<service account>: <read + write>": as a sentence, "<read + write> for <service account>".
 * Anything else is shown as it came.
 */
const grantDetail = ({ detail }: AuditEvent) => {
  const split = detail?.lastIndexOf(': ') ?? -1;
  if (detail === null || split === -1) return detail;
  return `${detail.slice(split + 2)} for ${detail.slice(0, split)}`;
};

/** What happened, as the rest of a sentence that starts with who did it. */
const DEEDS: Record<AuditAction, (event: AuditEvent) => ReactNode> = {
  'account.create': () => 'created the account',
  'passkey.add': () => 'added a passkey that opens the vault',
  'passkey.remove': () => 'removed a passkey',
  'password.set': () => 'set a new password',
  'password.remove': () => 'removed the password',
  'recovery.rotate': () => 'made a new recovery key',
  'credential.pair': ({ detail }) => <>approved the CLI login {detail}</>,
  'credential.create': ({ detail }) => <>made the service account {detail}</>,
  'credential.revoke': ({ detail }) => <>revoked the service account {detail}</>,
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
  'project.create': event => <>created {project(event)}</>,
  'project.archive': event => <>archived {project(event)}</>,
  'project.load': event => <>loaded {project(event)}</>,
  'secret.write': event => (
    <>
      wrote {secret(event)} in {project(event)}
    </>
  ),
  'secret.delete': event => (
    <>
      deleted {secret(event)} in {project(event)}
    </>
  ),
  'secret.rollback': event => (
    <>
      rolled {secret(event)} back in {project(event)}
    </>
  ),
  'grant.set': event => (
    <>
      set {grantDetail(event)} on {project(event)}
    </>
  ),
  'grant.remove': event => (
    <>
      removed {event.detail}’s access to {project(event)}
    </>
  ),
  'access.request': event => <>asked for access to {project(event)}</>,
  'access.approve': event => (
    <>
      approved {grantDetail(event)} on {project(event)}
    </>
  ),
  'access.deny': event => (
    <>
      denied {event.detail} access to {project(event)}
    </>
  ),
  'paste.request': event => (
    <>
      asked for {secret(event)} in {project(event)}
    </>
  ),
  'paste.fulfil': event => (
    <>
      pasted {secret(event)} into {project(event)}
    </>
  ),
  'paste.cancel': event => (
    <>
      dismissed the request for {secret(event)} in {project(event)}
    </>
  ),
};

export const ActivityPage = () => {
  const result = useAtomValue(auditAtom(null));
  const events = latest(result);
  const now = Date.now();
  // Newest first, so each day's entries stay in the order they came.
  const days = Map.groupBy(events ?? [], event => dayOf(event.at));
  return (
    <>
      <PageHeader
        title="Activity"
        lede="Who loaded, wrote or granted what, newest first. The last 100 entries."
      />
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
                    {DEEDS[event.action](event)}
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
