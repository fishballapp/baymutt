import { Collapsible } from '@base-ui/react/collapsible';
import { cn } from 'cn';
import { type ComponentProps, type ReactNode, useState } from 'react';
import { buttonClass } from './button.tsx';
import { CommandLine } from './command-line.tsx';

/** A list's count shows once it holds more than this many rows, and a page's filter too. */
export const FILTER_THRESHOLD = 10;

/**
 * `.list`: the `.list-head` (its `h2`, the count when over the threshold and unfiltered, its own
 * actions at the right), an optional `.list-lede`, its rows (`children`: `Rows`, `EmptyState` or
 * a form), then a `.list-note` or a `.list-error`.
 */
export const List = ({
  title,
  count,
  actions,
  lede,
  note,
  error,
  isDanger = false,
  label,
  children,
}: {
  readonly title: ReactNode;
  /** How many rows it holds. Shown when above the threshold; leave out while a filter is typed. */
  readonly count?: number;
  /** One `.btn`, or two in `.list-acts`. Hidden while a form under this heading is open. */
  readonly actions?: ReactNode;
  /** One sentence, only on CLI logins, Password and Recovery key. */
  readonly lede?: ReactNode;
  readonly note?: ReactNode;
  /** An error that belongs to the whole list (Add a passkey, the last way to unlock). */
  readonly error?: string | null;
  /** "Delete this environment". */
  readonly isDanger?: boolean;
  /** The section's accessible name, when its heading is not plain words. */
  readonly label?: string;
  readonly children: ReactNode;
}) => (
  <section className={cn('list', isDanger && 'list-danger')} aria-label={label}>
    <div className="list-head">
      <h2>
        {title}
        {count !== undefined && count > FILTER_THRESHOLD && (
          <>
            {' '}
            <span className="n num">{count}</span>
          </>
        )}
      </h2>
      {actions}
    </div>
    {lede && <p className="list-lede">{lede}</p>}
    {children}
    {note && <p className="list-note">{note}</p>}
    {error && (
      <p role="alert" className="list-error">
        {error}
      </p>
    )}
  </section>
);

/** Two actions at a list heading's right. */
export const ListActions = ({ children }: { readonly children: ReactNode }) => (
  <div className="list-acts">{children}</div>
);

/** `.rows`: one `Row` per row, a rule between siblings only. */
export const Rows = ({ className, ...props }: ComponentProps<'ul'>) => (
  <ul className={cn('rows', className)} {...props} />
);

/**
 * One row, a `li` laid out by its variant's class (`row-key`, `row-secret`, `row-bin`, …), its
 * cells in its variant's order. `isJustWritten` flashes it once; `working` disables nothing by
 * itself but says what runs, at the row's end, with `aria-busy`; `error` is the last child.
 */
export const Row = ({
  variant,
  isJustWritten = false,
  working,
  error,
  className,
  children,
  ...props
}: Omit<ComponentProps<'li'>, 'children'> & {
  readonly variant: string;
  readonly isJustWritten?: boolean;
  /** "Dismissing…", "Removing…", while an action picked from `⋯` runs. */
  readonly working?: string | null;
  /** An action of this row failed; it stays until the next attempt. */
  readonly error?: string | null;
  readonly children: ReactNode;
}) => (
  <li
    className={cn(variant, isJustWritten && 'just-written', className)}
    aria-busy={working ? true : undefined}
    {...props}
  >
    {children}
    {working && <p className="row-working">{working}</p>}
    {error && (
      <p role="alert" className="row-error">
        {error}
      </p>
    )}
  </li>
);

/**
 * `.status`: its first line the status itself (`warn` when it needs attention), its `.fact` the
 * one fact that matters next ("used 3 hours ago"). Either may be left out.
 */
export const Status = ({
  status,
  isWarn = false,
  fact,
}: {
  readonly status?: ReactNode;
  readonly isWarn?: boolean;
  readonly fact?: ReactNode;
}) => (
  <div className="status">
    {status && <span className={cn(isWarn && 'warn')}>{status}</span>}
    {fact && <span className="fact">{fact}</span>}
  </div>
);

/**
 * `.empty`, where an empty list's first row would be: one sentence saying what will show, then at
 * most one example an agent would run (a lead-in and its command lines, in the org's own slug).
 */
export const EmptyState = ({
  children,
  example,
}: {
  readonly children: ReactNode;
  readonly example?: { readonly lead: string; readonly commands: ReadonlyArray<string> };
}) => (
  <div className="empty">
    <p className="empty-say">{children}</p>
    {example && (
      <div className="empty-eg">
        <p>{example.lead}</p>
        {example.commands.map(command => (
          <CommandLine key={command} command={command} />
        ))}
      </div>
    )}
  </div>
);

/**
 * Ended keys or ended CLI logins: one `.ended` after the last list shown. Closed, a quiet
 * "Show 3 ended keys"; open, "Hide ended keys" over a bare `Rows` of `children`. While a filter is
 * typed the caller passes `isForcedOpen`: the panel shows and its button hides.
 */
export const Ended = ({
  showLabel,
  hideLabel,
  isForcedOpen = false,
  open,
  onOpenChange,
  children,
}: {
  /** Closed: "Show 3 ended keys", "Show 1 ended key". */
  readonly showLabel: string;
  /** Open: "Hide ended keys", whatever the count. */
  readonly hideLabel: string;
  readonly isForcedOpen?: boolean;
  /**
   * Held by the page when the section can leave the page and come back (Keys, while a filter
   * matches none of them), so it comes back as the owner left it.
   */
  readonly open?: boolean;
  readonly onOpenChange?: (isOpen: boolean) => void;
  readonly children: ReactNode;
}) => {
  const [ownIsOpen, setOwnOpen] = useState(false);
  const isOpen = open ?? ownIsOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  return (
    <Collapsible.Root className="ended" open={isForcedOpen || isOpen} onOpenChange={setOpen}>
      {!isForcedOpen && (
        <div className="list-after">
          <Collapsible.Trigger className={buttonClass({ kind: 'quiet' })}>
            {isOpen ? hideLabel : showLabel}
          </Collapsible.Trigger>
        </div>
      )}
      <Collapsible.Panel render={<ul className="rows" />}>{children}</Collapsible.Panel>
    </Collapsible.Root>
  );
};

/**
 * `.skeleton`: rows of two bars while a list loads (three; a decision page shows four); `hasTitle`
 * adds the bar of a page title that needs data.
 */
export const Skeleton = ({
  rows = 3,
  hasTitle = false,
}: {
  readonly rows?: number;
  readonly hasTitle?: boolean;
}) => (
  <div role="status" aria-busy="true" aria-label="Loading">
    {hasTitle && <i className="skeleton-title" />}
    <ul className="skeleton">
      {Array.from({ length: rows }, (_, row) => (
        <li key={row}>
          <i />
          <i />
        </li>
      ))}
    </ul>
  </div>
);

/** A shell page whose subject is missing or failed to load: heading, sentence, way back. */
export const Missing = ({
  title,
  children,
  isFailure = false,
  action,
}: {
  readonly title: string;
  readonly children: ReactNode;
  /** The sentence is the store's message, in `danger`. */
  readonly isFailure?: boolean;
  readonly action?: ReactNode;
}) => (
  <div className="missing">
    <h1>{title}</h1>
    <p className={cn(isFailure && 'danger')}>{children}</p>
    {action}
  </div>
);

/** `.notice`: a line above a page or in a list's place, in `danger` or `warn`. */
export const Notice = ({
  tone,
  className,
  children,
}: {
  readonly tone: 'danger' | 'warn';
  readonly className?: string;
  readonly children: ReactNode;
}) => (
  <p role={tone === 'danger' ? 'alert' : undefined} className={cn('notice', tone, className)}>
    {children}
  </p>
);
