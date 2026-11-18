import { type ReactNode, useEffect, useState } from 'react';
import { ago, exactTime, MINUTE_MS } from '../../lib/format.ts';

/**
 * `.head`: the page's `h1` (or `title` as given, for an address `.code-title.addr`), its `.head-sub`
 * on Account and "Create your first org", then `.head-act` with the filter and the primary, left
 * out when it has neither. No lede on a shell page.
 */
export const PageHead = ({
  title,
  sub,
  filter,
  primary,
}: {
  readonly title: ReactNode;
  readonly sub?: ReactNode;
  /** A `Filter`, shown above 10 rows. */
  readonly filter?: ReactNode;
  /** The page's one primary button; hidden while an inline form is open. */
  readonly primary?: ReactNode;
}) => (
  <header className="head">
    {sub ? (
      <div className="head-title">
        {title}
        <p className="head-sub">{sub}</p>
      </div>
    ) : (
      title
    )}
    {(filter || primary) && (
      <div className="head-act">
        {filter}
        {primary}
      </div>
    )}
  </header>
);

/** The page title as a plain `h1`. */
export const PageTitle = ({ children }: { readonly children: ReactNode }) => (
  <h1 className="head-title">{children}</h1>
);

/** The time now, refreshed every minute, so a relative time stays true while the page is open. */
const useMinuteClock = () => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
};

/**
 * A moment as `<time datetime>` with its exact time in `title`. By default the words are relative
 * ("2 minutes ago"); `children` gives the whole phrase instead ("used 3 hours ago", "8:22 PM").
 */
export const RelativeTime = ({
  at,
  children,
  className,
}: {
  readonly at: number;
  readonly children?: (agoWords: string) => ReactNode;
  readonly className?: string;
}) => {
  const now = useMinuteClock();
  const words = ago(at, now);
  return (
    <time
      dateTime={Temporal.Instant.fromEpochMilliseconds(at).toString({ fractionalSecondDigits: 3 })}
      title={exactTime(at)}
      className={className}
    >
      {children ? children(words) : words}
    </time>
  );
};
