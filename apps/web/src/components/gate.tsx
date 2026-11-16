import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { cn } from 'cn';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';
import { createContext, type ReactNode, use, useEffect, useState } from 'react';
import {
  orgsAtom,
  pendingEnvironmentRequestsAtom,
  pendingPasteLinksAtom,
  pendingRequestsAtom,
  resumeAtom,
  sealOrgsAtom,
  signOutAtom,
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
  // Environment requests wait under Environments: approving one creates it.
  { to: '/environments', label: 'Environments', pending: pendingEnvironmentRequestsAtom },
  // Requests wait under Service accounts: approving one makes its key a service account.
  { to: '/service-accounts', label: 'Service accounts', pending: pendingRequestsAtom },
  { to: '/paste-links', label: 'Paste links', pending: pendingPasteLinksAtom },
  { to: '/activity', label: 'Activity', pending: null },
  { to: '/bin', label: 'Bin', pending: null },
  { to: '/account', label: 'Account', pending: null },
] as const;

type NavPath = (typeof NAV)[number]['to'];

/**
 * The nav item a page belongs to: a pairing link and a request are about service accounts, an
 * environment request about environments.
 */
const sectionOf = (path: string): NavPath | undefined => {
  if (path.startsWith('/pair') || path.startsWith('/requests')) return '/service-accounts';
  if (path.startsWith('/environment-requests')) return '/environments';
  return NAV.find(({ to }) => path.startsWith(to))?.to;
};

/** How many things under a nav item wait on the owner. */
const PendingCount = ({
  atom,
}: {
  readonly atom: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<unknown>, unknown>>;
}) => {
  const pending = latest(useAtomValue(atom))?.length ?? 0;
  if (pending === 0) return null;
  return (
    <span className="absolute top-0.5 right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-xs leading-none font-medium text-accent-foreground tabular-nums md:static md:ml-auto md:h-5 md:min-w-5 md:px-1.5">
      {pending}
      <span className="sr-only"> waiting for you</span>
    </span>
  );
};

/**
 * Seals the names of every org that has not sealed them yet, once the vault is open: the store
 * keeps an org's names as written until then, and nothing with a new name can be made in it.
 * Keyed on which orgs are unsealed, so a failure is not retried until that changes. A CLI login
 * or service account whose key cannot be verified is left out, and the owner is told which.
 */
const NamesSealing = () => {
  const owner = useOwner();
  const [sealing, seal] = useAtom(sealOrgsAtom);
  const unsealed =
    latest(useAtomValue(orgsAtom))
      ?.filter(org => !org.areNamesSealed)
      .map(org => org.id)
      .join(' ') ?? '';
  useEffect(() => {
    if (unsealed !== '') seal(owner);
  }, [unsealed, owner, seal]);
  const failure = failureMessage(sealing);
  if (failure !== null) {
    return (
      <Notice className="mb-6">
        Could not seal the names in your orgs: {failure} It is tried again when you next open the
        dashboard.
      </Notice>
    );
  }
  const leftOut = AsyncResult.isSuccess(sealing) ? sealing.value : [];
  if (leftOut.length === 0) return null;
  return (
    <Notice tone="warn" className="mb-6">
      {leftOut.map(({ org, leftOut: names }) => (
        <span key={org} className="block">
          The names in {org} are sealed. {names.join(', ')} {names.length === 1 ? 'was' : 'were'}{' '}
          left out: {names.length === 1 ? 'its' : 'their'} key cannot be verified, so{' '}
          {names.length === 1 ? 'it' : 'they'} cannot list the names there until replaced.
        </span>
      ))}
      <Button size="sm" intent="quiet" className="mt-1 -ml-2.5" onClick={() => seal(Atom.Reset)}>
        Dismiss
      </Button>
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
            {NAV.map(({ to, label, pending }) => (
              <Link
                key={to}
                to={to}
                aria-current={current === to ? 'page' : undefined}
                className={navItem(current === to)}
              >
                {label}
                {pending !== null && <PendingCount atom={pending} />}
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
          <NamesSealing />
          <Outlet />
        </div>
      </main>
    </div>
  );
};
