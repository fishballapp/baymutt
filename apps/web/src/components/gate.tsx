import type { Org } from '@baymutt/api';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { Link, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { cn } from 'cn';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';
import { createContext, type ReactNode, use, useEffect, useState } from 'react';
import {
  orgsAtom,
  pendingEnvironmentRequestsAtom,
  pendingKeyAsksAtom,
  pendingPasteLinksAtom,
  resumeAtom,
  sealOrgsAtom,
  signOutAtom,
} from '../lib/data.ts';
import { type Owner, useOwnerStore } from '../lib/owner.ts';
import { failureMessage, latest } from '../lib/result.ts';
import { Entry, Standalone } from '../pages/entry.tsx';
import { homeOrg, OrgPicker } from './orgs.tsx';
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

/** What the nav lists for the org a page shows, in order. */
const ORG_SECTIONS = [
  { segment: 'environments', to: '/orgs/$slug/environments', label: 'Environments' },
  { segment: 'keys', to: '/orgs/$slug/keys', label: 'Keys' },
  { segment: 'paste-links', to: '/orgs/$slug/paste-links', label: 'Paste links' },
  { segment: 'activity', to: '/orgs/$slug/activity', label: 'Activity' },
  { segment: 'bin', to: '/orgs/$slug/bin', label: 'Bin' },
] as const;

type OrgSection = (typeof ORG_SECTIONS)[number]['segment'];

/**
 * The nav item a page belongs to: an org's section, or the account. An ask for access and a key
 * change are about keys, an ask for an environment is about environments, and a pairing link is
 * about the account's CLI logins.
 */
const sectionOf = (path: string): OrgSection | 'account' | undefined => {
  if (path.startsWith('/account') || path.startsWith('/pair')) return 'account';
  const [, segment, ask] = /^\/orgs\/[^/]+\/([^/]+)(?:\/([^/]+))?/.exec(path) ?? [];
  if (segment === 'ask') return ask === 'create-environment' ? 'environments' : 'keys';
  return ORG_SECTIONS.find(section => section.segment === segment)?.segment;
};

/** What waits on the owner in an org, by the nav item it waits under. */
type Waiting = Readonly<Partial<Record<OrgSection, number>>>;

/**
 * What waits on the owner in the org the nav shows: environment requests under Environments
 * (approving one creates it), requests and key changes under Keys (approving one makes or changes
 * a key), and paste links.
 */
const useWaiting = (org: Org | null): Waiting => {
  const environmentRequests = latest(useAtomValue(pendingEnvironmentRequestsAtom)) ?? [];
  const keyAsks = latest(useAtomValue(pendingKeyAsksAtom)) ?? [];
  const pasteLinks = latest(useAtomValue(pendingPasteLinksAtom)) ?? [];
  if (org === null) return {};
  return {
    environments: environmentRequests.filter(request => request.orgId === org.id).length,
    keys: keyAsks.filter(ask => ask.org.id === org.id).length,
    'paste-links': pasteLinks.filter(link => link.orgId === org.id).length,
  };
};

/** How many things under a nav item wait on the owner. */
const PendingCount = ({ count }: { readonly count: number }) => {
  if (count === 0) return null;
  return (
    <span className="absolute top-0.5 right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-xs leading-none font-medium text-accent-foreground tabular-nums md:static md:ml-auto md:h-5 md:min-w-5 md:px-1.5">
      {count}
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
 * The side nav and one column of content. The org picker heads the org's own items, which all
 * show the org the address names (or, on the account's pages, the one this browser last showed);
 * the account sits at the foot. Under 48rem the nav is a bar across the top: the wordmark and
 * Account on one line, the picker on the next, then the org's five items in three columns, which
 * gives "Environments" room to stay on one line at 390px.
 */
export const Shell = () => {
  const owner = useOwner();
  const signOut = useAtomSet(signOutAtom);
  const navigate = useNavigate();
  const path = useRouterState({ select: state => state.location.pathname });
  const { slug } = useParams({ strict: false });
  const orgs = latest(useAtomValue(orgsAtom)) ?? [];
  // An address naming no org of the person's is no section of the org the nav shows.
  const current =
    slug === undefined || orgs.some(listed => listed.slug === slug) ? sectionOf(path) : undefined;
  const org = orgs.find(listed => listed.slug === slug) ?? homeOrg(orgs);
  const waiting = useWaiting(org);
  const isAccount = current === 'account';
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="border-line border-b bg-surface md:border-r md:border-b-0">
        <div className="flex flex-col md:sticky md:top-0 md:h-dvh">
          <div className="flex items-center justify-between gap-4 px-4 pt-3 md:px-5 md:pt-7">
            <Link to="/orgs" className="-mx-1 shrink-0 rounded-control px-1 py-1">
              <Wordmark />
            </Link>
            <Link
              to="/account"
              aria-current={isAccount ? 'page' : undefined}
              className={cn(navItem(isAccount), 'md:hidden')}
            >
              Account
            </Link>
          </div>
          {org !== null && (
            <div className="px-4 pt-3 md:px-3 md:pt-6">
              <OrgPicker
                orgs={orgs}
                current={org}
                onPick={picked => {
                  const section = ORG_SECTIONS.find(({ segment }) => segment === current);
                  void navigate({
                    to: section?.to ?? '/orgs/$slug/environments',
                    params: { slug: picked.slug },
                  });
                }}
              />
            </div>
          )}
          {org !== null && (
            <nav
              aria-label={org.name}
              className="grid grid-cols-3 gap-1 px-2 py-2 md:flex md:flex-col md:gap-0.5 md:px-3 md:pt-2 md:pb-4"
            >
              {ORG_SECTIONS.map(({ segment, to, label }) => (
                <Link
                  key={segment}
                  to={to}
                  params={{ slug: org.slug }}
                  aria-current={current === segment ? 'page' : undefined}
                  className={navItem(current === segment)}
                >
                  {label}
                  <PendingCount count={waiting[segment] ?? 0} />
                </Link>
              ))}
            </nav>
          )}
          <div className="mt-auto hidden border-line border-t px-3 py-4 md:block">
            <Link
              to="/account"
              aria-current={isAccount ? 'page' : undefined}
              className={cn(
                'block rounded-control px-2.5 py-1.5 transition-colors duration-150 ease-out hover:bg-sunken',
                isAccount && 'bg-accent-soft hover:bg-accent-soft',
              )}
            >
              <span className="block truncate font-medium" title={owner.accountName}>
                {owner.accountName}
              </span>
              <span className="block truncate text-sm text-muted" title={owner.email}>
                {owner.email}
              </span>
            </Link>
            <Button size="sm" intent="quiet" className="mt-1" onClick={() => signOut()}>
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
