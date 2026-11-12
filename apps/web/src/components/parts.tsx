// The small pieces every page is made of.
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { cn } from 'cn';
import { type ComponentProps, Fragment, type ReactNode } from 'react';
import { useCopy } from '../lib/clipboard.ts';
import { ago, exactTime } from '../lib/format.ts';
import { Button } from './ui/button.tsx';

/** A dog tag: baymutt's mark. */
export const Mark = ({ className }: { readonly className?: string }) => (
  <svg viewBox="0 0 32 32" aria-hidden="true" className={cn('size-5 text-mutt', className)}>
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M10 3h12a5 5 0 0 1 5 5v13a8 8 0 0 1-8 8h-6a8 8 0 0 1-8-8V8a5 5 0 0 1 5-5Zm6 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"
    />
  </svg>
);

export const Wordmark = () => (
  <span className="flex items-center gap-2 text-md font-[650] tracking-tight">
    <Mark />
    baymutt
  </span>
);

/** A page's name and, on the same line, its one primary action. */
export const PageHeader = ({
  title,
  lede,
  action,
}: {
  readonly title: ReactNode;
  readonly lede?: ReactNode;
  readonly action?: ReactNode;
}) => (
  <header className="mb-8 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
    <div className="min-w-0">
      <h1 className="text-xl leading-tight">{title}</h1>
      {lede && <p className="mt-2 max-w-[65ch] text-muted">{lede}</p>}
    </div>
    {action}
  </header>
);

/** A group with its own heading. The first one under the page's header sits right beneath it. */
export const Section = ({
  title,
  lede,
  action,
  className,
  children,
}: {
  readonly title: string;
  readonly lede?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly children?: ReactNode;
}) => (
  <section className={cn('mt-12 first:mt-0 [header+&]:mt-0', className)}>
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h2 className="text-md">{title}</h2>
        {lede && <p className="mt-1 max-w-[65ch] text-sm text-muted">{lede}</p>}
      </div>
      {action}
    </div>
    {children && <div className="mt-4">{children}</div>}
  </section>
);

/** Rows with hairlines between them. */
export const Rows = ({ className, ...props }: ComponentProps<'ul'>) => (
  <ul
    className={cn(
      'divide-y divide-line overflow-hidden rounded-panel border border-line bg-surface',
      className,
    )}
    {...props}
  />
);

export const Row = ({ className, ...props }: ComponentProps<'li'>) => (
  <li className={cn('px-4 py-3', className)} {...props} />
);

/** A row's own actions: on a phone they sit under the row, their text in line with the row's. */
export const RowActions = ({ children }: { readonly children: ReactNode }) => (
  <div className="-mx-2.5 flex flex-wrap gap-0.5 sm:mx-0 sm:shrink-0">{children}</div>
);

/** A long name may break after a slash, never inside a segment while a slash is left. */
const breakAfterSlashes = (text: string) =>
  text.split('/').map((segment, index) => (
    <Fragment key={index}>
      {index > 0 && (
        <>
          /<wbr />
        </>
      )}
      {segment}
    </Fragment>
  ));

/** What a machine reads and a person compares: a name, an id, a code. */
export const Code = ({ className, children, ...props }: ComponentProps<'code'>) => (
  <code className={cn('font-mono text-sm [overflow-wrap:anywhere]', className)} {...props}>
    {typeof children === 'string' ? breakAfterSlashes(children) : children}
  </code>
);

/** A command to run in a terminal, to copy whole. */
export const CommandLine = ({ children }: { readonly children: string }) => {
  const [copied, copy] = useCopy(children);
  return (
    <div className="flex items-start gap-2 rounded-control border border-line bg-sunken py-1 pr-1 pl-3 text-foreground">
      <span aria-hidden="true" className="py-1 font-mono text-sm text-muted select-none">
        $
      </span>
      <Code className="min-w-0 flex-1 py-1">{children}</Code>
      <Button
        size="sm"
        intent="subtle"
        className="px-2"
        aria-label={copied === 'copied' ? 'Copied' : 'Copy the command'}
        onClick={copy}
      >
        {copied === 'copied' ? (
          <CheckIcon aria-hidden="true" className="size-4 text-accent" />
        ) : (
          <CopyIcon aria-hidden="true" className="size-4 text-muted" />
        )}
      </Button>
    </div>
  );
};

/** "3 hours ago", with the exact time on hover and for assistive tech. */
export const Time = ({ at, className }: { readonly at: number; readonly className?: string }) => (
  <time dateTime={new Date(at).toISOString()} title={exactTime(at)} className={className}>
    {ago(at, Date.now())}
  </time>
);

const TONES = {
  plain: 'border-line text-muted',
  accent: 'border-transparent bg-accent-soft text-foreground',
  warn: 'border-transparent bg-warn-soft text-foreground',
} as const;

/** A status in a word. */
export const Tag = ({
  tone = 'plain',
  children,
}: {
  readonly tone?: keyof typeof TONES;
  readonly children: ReactNode;
}) => (
  <span
    className={cn(
      'inline-flex h-5 items-center rounded-full border px-2 text-xs font-medium whitespace-nowrap',
      TONES[tone],
    )}
  >
    {children}
  </span>
);

/** "read + write", in words: a grant never rests on colour. */
export const grantWords = ({
  canRead,
  canWrite,
}: {
  readonly canRead: boolean;
  readonly canWrite: boolean;
}): string => [canRead && 'read', canWrite && 'write'].filter(Boolean).join(' + ') || 'no access';

export const Notice = ({
  tone = 'danger',
  className,
  children,
}: {
  readonly tone?: 'danger' | 'warn' | 'plain';
  readonly className?: string;
  readonly children: ReactNode;
}) => (
  <p
    role={tone === 'danger' ? 'alert' : undefined}
    className={cn(
      'rounded-control border px-3 py-2 text-sm',
      tone === 'danger' && 'border-danger/40 bg-danger-soft',
      tone === 'warn' && 'border-warn/40 bg-warn-soft',
      tone === 'plain' && 'border-line bg-sunken text-muted',
      className,
    )}
  >
    {children}
  </p>
);

/** An empty list says what belongs in it and the next step that puts it there. */
export const Empty = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) => (
  <div className="rounded-panel border border-dashed border-line px-5 py-6 sm:px-6">
    <p className="font-medium">{title}</p>
    <div className="mt-1.5 max-w-[62ch] space-y-3 text-muted">{children}</div>
  </div>
);

const SKELETON_WIDTHS = ['w-2/5', 'w-1/4', 'w-1/3', 'w-2/5', 'w-1/5', 'w-1/3'] as const;

/** Rows that are on their way, in the list's own shape. */
export const Skeleton = ({ rows = 3 }: { readonly rows?: number }) => (
  <Rows aria-busy="true" aria-label="Loading">
    {Array.from({ length: rows }, (_, index) => (
      <Row key={index} className="space-y-2 py-3.5">
        <div
          className={cn(
            'h-3.5 animate-pulse rounded bg-sunken',
            SKELETON_WIDTHS[index % SKELETON_WIDTHS.length],
          )}
        />
        <div className="h-3 w-1/2 animate-pulse rounded bg-sunken/70" />
      </Row>
    ))}
  </Rows>
);
