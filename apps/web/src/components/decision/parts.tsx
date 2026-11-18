// The parts every decision page is built from: the environments it names, its answer, and the
// line that says who asked. The column and the outcome are the shell's (`DecisionColumn`, `Outcome`).
import { useAtomValue } from '@effect/atom-react';
import { cn } from 'cn';
import type { ReactNode } from 'react';
import { type OpenedRequestItem, serviceAccountsAtom } from '../../lib/data.ts';
import { exactTime } from '../../lib/format.ts';
import { latest } from '../../lib/result.ts';
import { useOwner } from '../gate.tsx';
import { RelativeTime } from '../ui/page.tsx';
import { Address } from '../ui/text.tsx';

/** One environment in `.grants`: its address, then what the line is about in `muted`. */
export const Grant = ({
  item,
  children,
}: {
  readonly item: Pick<OpenedRequestItem, 'orgSlug' | 'openedEnvironmentName'>;
  /** Left out for an environment named alone (an environment request). */
  readonly children?: ReactNode;
}) => (
  <li>
    <Address orgSlug={item.orgSlug} name={item.openedEnvironmentName} />
    {children !== undefined && <span className="muted">{children}</span>}
  </li>
);

/**
 * `.answer`: Reject, then the primary (or one button, `.answer.single`), and under it the store's
 * message when the answer failed. The decision stays on screen.
 */
export const Answer = ({
  isSingle = false,
  error,
  children,
}: {
  readonly isSingle?: boolean;
  readonly error: string | null;
  readonly children: ReactNode;
}) => (
  <>
    <div className={cn('answer', isSingle && 'single')}>{children}</div>
    {error !== null && (
      <p className="error" role="alert">
        {error}
      </p>
    )}
  </>
);

/**
 * `.vouch`: when the CLI login asked, and when the owner approved that login. The approval is
 * left out when the login is no longer listed (revoked since) or its list has not loaded.
 */
export const Vouch = ({
  askedAt,
  maker,
}: {
  readonly askedAt: number;
  readonly maker: { readonly id: string; readonly name: string };
}) => {
  const approvedAt = latest(useAtomValue(serviceAccountsAtom(useOwner())))?.find(
    login => login.id === maker.id,
  )?.createdAt;
  return (
    <p className="vouch">
      Asked <RelativeTime at={askedAt} /> by {maker.name}, a CLI login
      {approvedAt !== undefined && (
        <>
          {' '}
          you approved <RelativeTime at={approvedAt} />
        </>
      )}
      .
    </p>
  );
};

/** An exact moment inside an outcome's sentence. */
export const ExactTime = ({ at }: { readonly at: number }) => (
  <RelativeTime at={at}>{() => exactTime(at)}</RelativeTime>
);
