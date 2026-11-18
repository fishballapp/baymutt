// Things that wait on the owner, as rows at the top of the page they wait under: requests and key
// changes on Keys, environment requests on Environments, paste links on Paste links.
import type { ReactNode } from 'react';
import { List, Rows } from './ui/list.tsx';
import { RelativeTime } from './ui/page.tsx';

/**
 * "Waiting for you": the first list of its page, newest first, shown only while something waits.
 * A filter never narrows it.
 */
export const WaitingList = ({ children }: { readonly children: ReactNode }) => (
  <List title="Waiting for you">
    <Rows>{children}</Rows>
  </List>
);

/**
 * `.row-wait`: who asks and for what (`ask`, names `b`, exact strings `Code` or `Address`), the
 * reason quoted, the `about` lines, then its age and its way to the decision page. It is never
 * answered in place.
 */
export const WaitingRow = ({
  ask,
  reason,
  about = [],
  askedAt,
  action,
  menu,
  working,
  error,
}: {
  readonly ask: ReactNode;
  /** The claim, shown in quotes; null when the terminal gave none. */
  readonly reason: string | null;
  /** One line each: an environment and its access, "asks for a new end", a paste link's hint. */
  readonly about?: ReadonlyArray<ReactNode>;
  readonly askedAt: number;
  /** "Review", or "Paste value": a link styled with `buttonClass()` to its decision page. */
  readonly action: ReactNode;
  /** A paste link's `RowMenu` with Dismiss. */
  readonly menu?: ReactNode;
  readonly working?: string | null;
  readonly error?: string | null;
}) => (
  <li className="row-wait" aria-busy={working ? true : undefined}>
    <div>
      <p className="ask">{ask}</p>
      {reason !== null && <p className="why">“{reason}”</p>}
      {about.map((line, index) => (
        <p key={index} className="about">
          {line}
        </p>
      ))}
    </div>
    <div className="side">
      <RelativeTime at={askedAt} className="age" />
      <span className="side-acts">
        {action}
        {menu}
      </span>
    </div>
    {working && <p className="row-working">{working}</p>}
    {error && (
      <p role="alert" className="row-error">
        {error}
      </p>
    )}
  </li>
);
