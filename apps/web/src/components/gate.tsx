import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { cn } from 'cn';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { createContext, type ReactNode, use, useEffect, useState } from 'react';
import {
  environmentsAtom,
  isLogin,
  pasteLinksAtom,
  resumeAtom,
  serviceAccountsAtom,
  signOutAtom,
  topUpLoginsAtom,
} from '../lib/data.ts';
import { type Owner, useOwnerStore } from '../lib/owner.ts';
import { failureMessage, latest } from '../lib/result.ts';
import { Entry, Standalone } from '../pages/entry.tsx';
import { OrgPicker } from './orgs.tsx';
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
  { to: '/environments', label: 'Environments' },
  { to: '/service-accounts', label: 'Service accounts' },
  { to: '/paste-links', label: 'Paste links' },
  { to: '/activity', label: 'Activity' },
  { to: '/bin', label: 'Bin' },
  { to: '/account', label: 'Account' },
] as const;

type NavPath = (typeof NAV)[number]['to'];

/** The nav item a page belongs to: a pairing link is about a service account. */
const sectionOf = (path: string): NavPath | undefined =>
  path.startsWith('/pair') ? '/service-accounts' : NAV.find(({ to }) => path.startsWith(to))?.to;

const PendingCount = () => {
  const pending = latest(useAtomValue(pasteLinksAtom))?.length ?? 0;
  if (pending === 0) return null;
  return (
    <span className="absolute top-0.5 right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-xs leading-none font-medium text-accent-foreground tabular-nums md:static md:ml-auto md:h-5 md:min-w-5 md:px-1.5">
      {pending}
      <span className="sr-only"> waiting for you</span>
    </span>
  );
};

/**
 * Keeps every CLI login holding every environment of every org. An environment another login made
 * reaches the others only through the owner's vault, so whenever it is open and a login lacks one,
 * this grants it. Keyed on what is missing: a grant that fails is not retried until the lists
 * change.
 */
const LoginTopUp = () => {
  const owner = useOwner();
  const [toppingUp, topUp] = useAtom(topUpLoginsAtom);
  const serviceAccounts = latest(useAtomValue(serviceAccountsAtom));
  const environments = latest(useAtomValue(environmentsAtom));
  const missing =
    serviceAccounts === null || environments === null
      ? ''
      : serviceAccounts
          .filter(isLogin)
          .flatMap(login =>
            environments
              .filter(environment => {
                const held = login.grants.find(grant => grant.environmentId === environment.id);
                return !(held?.canRead && held.canWrite);
              })
              .map(environment => `${login.id}/${environment.id}`),
          )
          .join(' ');
  useEffect(() => {
    if (missing !== '') topUp(owner);
  }, [missing, owner, topUp]);
  const failure = failureMessage(toppingUp);
  return failure === null ? null : (
    <Notice className="mb-6">
      Could not give every CLI login the environments it lacks: {failure} It is tried again when you
      next open the dashboard.
    </Notice>
  );
};

const navItem = (isCurrent: boolean) =>
  cn(
    'relative flex h-9 items-center justify-center gap-2 rounded-control px-2 text-sm font-medium text-muted transition-colors duration-150 ease-out hover:bg-sunken hover:text-foreground md:justify-start md:px-2.5 md:text-base',
    isCurrent && 'bg-accent-soft text-foreground hover:bg-accent-soft',
  );

/**
 * The side nav and one column of content. The org picker sits under the wordmark and scopes
 * Environments, Activity and the Bin. Under 48rem the nav is a bar across the top: the wordmark
 * and the picker on one line, then the six items in three columns over two rows, which gives
 * "Service accounts" and "Environments" room to stay on one line at 390px.
 */
export const Shell = () => {
  const owner = useOwner();
  const signOut = useAtomSet(signOutAtom);
  const current = sectionOf(useRouterState({ select: state => state.location.pathname }));
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="border-line border-b bg-surface md:border-r md:border-b-0">
        <div className="flex flex-col md:sticky md:top-0 md:h-dvh">
          <div className="flex items-center justify-between gap-4 px-4 pt-3 md:flex-col md:items-stretch md:gap-4 md:px-5 md:pt-7 md:pb-2">
            <Link
              to="/environments"
              className="-mx-1 shrink-0 rounded-control px-1 py-1 md:self-start"
            >
              <Wordmark />
            </Link>
            <div className="w-44 min-w-0 md:-mx-2 md:w-auto">
              <OrgPicker />
            </div>
          </div>
          <nav
            aria-label="Main"
            className="grid grid-cols-3 gap-1 px-2 py-2 md:flex md:flex-col md:gap-0.5 md:px-3 md:py-4"
          >
            {NAV.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                aria-current={current === to ? 'page' : undefined}
                className={navItem(current === to)}
              >
                {label}
                {to === '/paste-links' && <PendingCount />}
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
