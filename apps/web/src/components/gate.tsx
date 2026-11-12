import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { cn } from 'cn';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { createContext, type ReactNode, use, useEffect, useState } from 'react';
import {
  accessRequestsAtom,
  isLogin,
  pasteRequestsAtom,
  projectsAtom,
  resumeAtom,
  serviceAccountsAtom,
  signOutAtom,
  topUpLoginsAtom,
} from '../lib/data.ts';
import { type Owner, useOwnerStore } from '../lib/owner.ts';
import { failureMessage, latest } from '../lib/result.ts';
import { Entry, Standalone } from '../pages/entry.tsx';
import { Notice, Wordmark } from './parts.tsx';
import { RecoveryKey } from './recovery-key.tsx';
import { Button } from './ui/button.tsx';

const OwnerContext = createContext<Owner | null>(null);

/** The open vault. Only under `OwnerGate`, which renders nothing beneath it while the vault is locked. */
export const useOwner = (): Owner => {
  const owner = use(OwnerContext);
  if (owner === null) throw new Error('useOwner is only available under OwnerGate');
  return owner;
};

/**
 * Everything beneath it has the open vault. Until then it is the sign-in screen (unless this
 * browser kept the vault open, which a page load opens again by itself), and a vault that
 * was just made shows its recovery key before anything else.
 */
export const OwnerGate = ({ children }: { readonly children: ReactNode }) => {
  const owner = useOwnerStore(state => state.owner);
  const resuming = useAtomValue(resumeAtom);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  if (recoveryKey !== null) {
    return (
      <Standalone>
        <RecoveryKey recoveryKey={recoveryKey} onDone={() => setRecoveryKey(null)} />
      </Standalone>
    );
  }
  if (owner === null) {
    // Nothing until the kept vault is open or known not to be: no flash of the unlock screen.
    if (AsyncResult.isInitial(resuming)) return null;
    return (
      <Standalone hasBetaNote>
        <Entry onRecoveryKey={setRecoveryKey} />
      </Standalone>
    );
  }
  return <OwnerContext value={owner}>{children}</OwnerContext>;
};

const NAV = [
  { to: '/projects', label: 'Projects' },
  { to: '/service-accounts', label: 'Service accounts' },
  { to: '/requests', label: 'Requests' },
  { to: '/activity', label: 'Activity' },
  { to: '/account', label: 'Account' },
] as const;

type NavPath = (typeof NAV)[number]['to'];

/** The nav item a page belongs to: a pairing link is about a service account. */
const sectionOf = (path: string): NavPath | undefined =>
  path.startsWith('/pair') ? '/service-accounts' : NAV.find(({ to }) => path.startsWith(to))?.to;

const PendingCount = () => {
  const pending =
    (latest(useAtomValue(accessRequestsAtom))?.length ?? 0) +
    (latest(useAtomValue(pasteRequestsAtom))?.length ?? 0);
  if (pending === 0) return null;
  return (
    <span className="absolute top-0.5 right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-xs leading-none font-medium text-accent-foreground tabular-nums md:static md:ml-auto md:h-5 md:min-w-5 md:px-1.5">
      {pending}
      <span className="sr-only"> waiting for you</span>
    </span>
  );
};

/**
 * Keeps every login holding every project. A project a service account made reaches the other
 * logins only through the owner's vault, so whenever it is open and a login lacks one, this grants
 * it. Keyed on what is missing: a grant that fails is not retried until the lists change.
 */
const LoginTopUp = () => {
  const owner = useOwner();
  const [toppingUp, topUp] = useAtom(topUpLoginsAtom);
  const serviceAccounts = latest(useAtomValue(serviceAccountsAtom));
  const projects = latest(useAtomValue(projectsAtom));
  const missing =
    serviceAccounts === null || projects === null
      ? ''
      : serviceAccounts
          .filter(isLogin)
          .flatMap(login =>
            projects
              .filter(project => {
                const held = login.grants.find(grant => grant.projectId === project.id);
                return !(held?.canRead && held.canWrite);
              })
              .map(project => `${login.id}/${project.id}`),
          )
          .join(' ');
  useEffect(() => {
    if (missing !== '') topUp(owner);
  }, [missing, owner, topUp]);
  const failure = failureMessage(toppingUp);
  return failure === null ? null : (
    <Notice className="mb-6">
      Could not give every login the projects it lacks: {failure} It is tried again when you next
      open the dashboard.
    </Notice>
  );
};

const navItem = (isCurrent: boolean) =>
  cn(
    'relative flex h-9 items-center justify-center gap-2 rounded-control px-2 text-sm font-medium text-muted transition-colors duration-150 ease-out hover:bg-sunken hover:text-foreground md:justify-start md:px-2.5 md:text-base',
    isCurrent && 'bg-accent-soft text-foreground hover:bg-accent-soft',
  );

/**
 * The side nav and one column of content. Under 48rem the nav is a bar across the top, with
 * Account beside the wordmark so the other four fit a phone's width.
 */
export const Shell = () => {
  const owner = useOwner();
  const signOut = useAtomSet(signOutAtom);
  const current = sectionOf(useRouterState({ select: state => state.location.pathname }));
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="border-line border-b bg-surface md:border-r md:border-b-0">
        <div className="flex flex-col md:sticky md:top-0 md:h-dvh">
          <div className="flex items-center justify-between gap-4 px-4 pt-3 md:px-5 md:pt-7 md:pb-2">
            <Link to="/projects" className="-mx-1 rounded-control px-1 py-1">
              <Wordmark />
            </Link>
            <Link
              to="/account"
              aria-current={current === '/account' ? 'page' : undefined}
              className={cn(navItem(current === '/account'), 'px-2.5 md:hidden')}
            >
              Account
            </Link>
          </div>
          <nav
            aria-label="Main"
            className="grid grid-cols-4 gap-1 px-2 py-2 md:flex md:flex-col md:gap-0.5 md:px-3 md:py-4"
          >
            {NAV.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                aria-current={current === to ? 'page' : undefined}
                className={cn(navItem(current === to), to === '/account' && 'hidden md:flex')}
              >
                {label}
                {to === '/requests' && <PendingCount />}
              </Link>
            ))}
          </nav>
          <div className="mt-auto hidden border-line border-t px-5 py-4 md:block">
            <p className="truncate font-medium" title={owner.accountName}>
              {owner.accountName}
            </p>
            <p className="truncate text-sm text-muted" title={owner.email}>
              {owner.email}
            </p>
            <Button size="sm" intent="quiet" className="mt-2 -ml-2.5" onClick={() => signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 px-5 pt-7 pb-16 md:px-10 md:pt-10 lg:px-14">
        <div className="max-w-[60rem]">
          <LoginTopUp />
          <Outlet />
        </div>
      </main>
    </div>
  );
};
