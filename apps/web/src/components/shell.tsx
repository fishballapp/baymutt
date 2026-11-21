// The app's frames: the shell around an org's five items and Account (a side nav on desktop, a top
// bar and tab bar on a phone), and the decision bar above a page that answers one thing that waits.
import type { Org } from '@baymutt/api';
import { useAtomValue } from '@effect/atom-react';
import {
  CaretUpDownIcon,
  KeyIcon,
  ListChecksIcon,
  PulseIcon,
  StackIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { Link, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import mark from '../assets/mark.svg';
import { orgsAtom, pendingPlansAtom } from '../lib/data.ts';
import { latest } from '../lib/result.ts';
import { useNamesSealing, useOwner } from './gate.tsx';
import { homeOrg } from './org-scope.tsx';
import { InlineFormScope } from './ui/form.tsx';
import { Menu } from './ui/menu.tsx';
import { Tooltip } from './ui/tooltip.tsx';

/** An org's five items, in nav order. */
const ORG_ITEMS = [
  { item: 'environments', to: '/orgs/$slug/environments', label: 'Environments', Glyph: StackIcon },
  { item: 'keys', to: '/orgs/$slug/keys', label: 'Keys', Glyph: KeyIcon },
  { item: 'plans', to: '/orgs/$slug/plans', label: 'Plans', Glyph: ListChecksIcon },
  { item: 'activity', to: '/orgs/$slug/activity', label: 'Activity', Glyph: PulseIcon },
  { item: 'bin', to: '/orgs/$slug/bin', label: 'Bin', Glyph: TrashIcon },
] as const;

type OrgItem = (typeof ORG_ITEMS)[number]['item'];

type DecisionPlace = 'plans' | 'account';

/**
 * Where a path sits: an org's item, Account, or a decision page and the item it waits under. A
 * plan (`ask/<id>`) waits under Plans, and a pairing link under Account.
 */
const placeOf = (
  path: string,
):
  | { readonly kind: 'item'; readonly item: OrgItem | null }
  | { readonly kind: 'account' }
  | { readonly kind: 'decision'; readonly waitsUnder: DecisionPlace } => {
  if (path.startsWith('/account')) return { kind: 'account' };
  if (path.startsWith('/pair')) return { kind: 'decision', waitsUnder: 'account' };
  const [, segment, id, rest] = /^\/orgs\/[^/]+\/([^/]+)(?:\/([^/]+))?(\/.*)?/.exec(path) ?? [];
  if (segment === 'ask' && id !== undefined && rest === undefined) {
    return { kind: 'decision', waitsUnder: 'plans' };
  }
  return { kind: 'item', item: ORG_ITEMS.find(({ item }) => item === segment)?.item ?? null };
};

/** Whether a path is a decision page's: by the address's segment, so an org whose slug is "ask" is not. */
export const isDecisionPath = (path: string) => placeOf(path).kind === 'decision';

type Waiting = Readonly<Partial<Record<OrgItem, number>>>;

/**
 * What waits on the owner in one org, by the item it waits under: every ask is a plan, under
 * Plans. Nothing hints that another org has something waiting.
 */
const useWaiting = (org: Org | null): Waiting => {
  const plans = latest(useAtomValue(pendingPlansAtom)) ?? [];
  if (org === null) return {};
  return { plans: plans.filter(plan => plan.org.id === org.id).length };
};

/** `<title>`: the screen's subject, then its org when it has one, then "baymutt". */
export const useTitle = (...parts: ReadonlyArray<string | null | undefined>) => {
  const title = [...parts, 'baymutt']
    .filter(part => part !== null && part !== undefined)
    .join(' · ');
  useEffect(() => {
    document.title = title;
  }, [title]);
};

/** Whether an element's text is cut by its ellipsis now, rechecked as it resizes. */
const useIsTruncated = (ref: RefObject<HTMLElement | null>, text: string) => {
  const [isTruncated, setTruncated] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new text is a reason to measure again.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = () => setTruncated(element.scrollWidth > element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, text]);
  return isTruncated;
};

/** A waiting count, named "N waiting"; nothing at zero. */
const NavCount = ({ count }: { readonly count: number | undefined }) => {
  if (count === undefined || count === 0) return null;
  return (
    <span className="nav-count">
      {count}
      <span className="visually-hidden"> waiting</span>
    </span>
  );
};

/**
 * The org switcher and its menu: the person's orgs A to Z as radio items, then New org and All
 * orgs. Picking an org opens the same item of that org, or its Environments from anywhere else.
 */
const OrgSwitcher = ({
  orgs,
  current,
  item,
}: {
  readonly orgs: ReadonlyArray<Org>;
  readonly current: Org;
  readonly item: OrgItem | null;
}) => {
  const navigate = useNavigate();
  const nameRef = useRef<HTMLSpanElement>(null);
  const isTruncated = useIsTruncated(nameRef, current.name);
  const sorted = orgs.toSorted((a, b) => a.name.localeCompare(b.name));
  const to = ORG_ITEMS.find(entry => entry.item === item)?.to ?? '/orgs/$slug/environments';
  return (
    <div className="org-wrap">
      <Menu.Root>
        <Tooltip content={isTruncated ? current.name : null}>
          <Menu.Trigger className="org-btn" aria-label={`Org: ${current.name}`}>
            <img src={mark} alt="" />
            <span ref={nameRef} className="name">
              {current.name}
            </span>
            <CaretUpDownIcon aria-hidden="true" className="gl" />
          </Menu.Trigger>
        </Tooltip>
        <Menu.Popup align="start" isOrgs>
          <Menu.RadioGroup
            value={current.id}
            onValueChange={id => {
              const picked = orgs.find(org => org.id === id);
              if (picked !== undefined) void navigate({ to, params: { slug: picked.slug } });
            }}
          >
            {sorted.map(org => (
              <Menu.RadioItem key={org.id} value={org.id}>
                {org.name}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
          <Menu.Separator />
          <Menu.Item onClick={() => void navigate({ to: '/account', hash: 'new-org' })}>
            New org
          </Menu.Item>
          <Menu.Item onClick={() => void navigate({ to: '/account', hash: 'orgs' })}>
            All orgs
          </Menu.Item>
        </Menu.Popup>
      </Menu.Root>
    </div>
  );
};

/** The account at the nav's foot: its name over its email, one tooltip for both while either is cut. */
const NavMe = ({ isCurrent }: { readonly isCurrent: boolean }) => {
  const { accountName, email } = useOwner();
  const nameRef = useRef<HTMLElement>(null);
  const emailRef = useRef<HTMLSpanElement>(null);
  const isNameCut = useIsTruncated(nameRef, accountName);
  const isEmailCut = useIsTruncated(emailRef, email);
  return (
    <Tooltip content={isNameCut || isEmailCut ? `${accountName}, ${email}` : null}>
      <Link to="/account" className="nav-me" aria-current={isCurrent ? 'page' : undefined}>
        <b ref={nameRef}>{accountName}</b>
        <span ref={emailRef}>{email}</span>
      </Link>
    </Tooltip>
  );
};

/** `.brand-plain`, in the switcher's place while the person has no org. */
const BrandPlain = () => (
  <Link to="/orgs" className="brand-plain">
    <img src={mark} alt="" />
    baymutt
  </Link>
);

/**
 * The shell of every shell page: the org the address names (on Account, the one this browser
 * last showed), its items with their waiting counts, and the account. A decision page has no app
 * nav: it gets `DecisionFrame` instead.
 */
export const AppShell = () => {
  const path = useRouterState({ select: state => state.location.pathname });
  // Here, above both frames, so moving between a shell page and a decision page does not seal twice.
  const namesNotice = useNamesSealing();
  const place = placeOf(path);
  if (place.kind === 'decision') return <DecisionFrame waitsUnder={place.waitsUnder} />;
  return (
    <ShellFrame
      current={place.kind === 'account' ? 'account' : place.item}
      path={path}
      namesNotice={namesNotice}
    />
  );
};

const ShellFrame = ({
  current,
  path,
  namesNotice,
}: {
  readonly current: OrgItem | 'account' | null;
  readonly path: string;
  /** The names notice, shown above the page: `.notice-above`. */
  readonly namesNotice: ReactNode;
}) => {
  const { slug } = useParams({ strict: false });
  const orgs = latest(useAtomValue(orgsAtom)) ?? [];
  const named = orgs.find(org => org.slug === slug);
  // An address naming no org of the person's shows the last org, with no item current.
  const org = named ?? homeOrg(orgs);
  const item = (() => {
    if (current === 'account') return null;
    if (slug !== undefined && named === undefined) return null;
    return current;
  })();
  const waiting = useWaiting(org);
  const isAccount = current === 'account';
  const items = (className: 'nav-item' | 'tab', hasGlyph: boolean) =>
    org !== null &&
    ORG_ITEMS.map(({ item: each, to, label, Glyph }) => (
      <Link
        key={each}
        to={to}
        params={{ slug: org.slug }}
        className={className}
        aria-current={item === each ? 'page' : undefined}
      >
        {hasGlyph && <Glyph aria-hidden="true" className="gl gl-22" />}
        <span>{label}</span>
        <NavCount count={waiting[each]} />
      </Link>
    ));
  const switcher =
    org === null ? <BrandPlain /> : <OrgSwitcher orgs={orgs} current={org} item={item} />;
  return (
    <div className="app">
      <aside className="nav">
        {switcher}
        {org !== null && (
          <nav className="nav-items" aria-label={org.name}>
            {items('nav-item', false)}
          </nav>
        )}
        <NavMe isCurrent={isAccount} />
      </aside>
      <header className="top">
        {switcher}
        <Link to="/account" className="top-acct" aria-current={isAccount ? 'page' : undefined}>
          Account
        </Link>
      </header>
      <main className="content">
        <div className="col">
          {namesNotice}
          <InlineFormScope key={path}>
            <Outlet />
          </InlineFormScope>
        </div>
      </main>
      {org !== null && (
        <nav className="tabbar" aria-label={org.name}>
          {items('tab', true)}
        </nav>
      )}
    </div>
  );
};

const BACK = {
  environments: { label: 'Environments', to: '/orgs/$slug/environments' },
  keys: { label: 'Keys', to: '/orgs/$slug/keys' },
  plans: { label: 'Plans', to: '/orgs/$slug/plans' },
} as const;

/**
 * `.dbar`: the mark (to `/orgs`) and the org's name, or "baymutt" while there is no org to name;
 * at the right, the way back to the item the page waits under, with that item's waiting count
 * (which includes the page's own thing while it waits).
 */
export const DecisionBar = ({
  org,
  waitsUnder,
}: {
  /** Null while the orgs load, and on a page that belongs to no org yet. */
  readonly org: Org | null;
  /** Null shows no way back. */
  readonly waitsUnder: keyof typeof BACK | 'account' | null;
}) => {
  const waiting = useWaiting(org);
  const back = (() => {
    if (waitsUnder === null) return null;
    if (waitsUnder === 'account') {
      return (
        <Link to="/account" className="dbar-back">
          Account
        </Link>
      );
    }
    if (org === null) return null;
    const { label, to } = BACK[waitsUnder];
    const count = waiting[waitsUnder] ?? 0;
    return (
      <Link to={to} params={{ slug: org.slug }} className="dbar-back">
        {label}
        {count > 0 && <span className="muted"> {count} waiting</span>}
      </Link>
    );
  })();
  return (
    <header className="dbar">
      <span className="dbar-org">
        <Link to="/orgs">
          <img src={mark} alt="baymutt" />
        </Link>
        <span>{org?.name ?? 'baymutt'}</span>
      </span>
      {back}
    </header>
  );
};

/** A decision page under the app: its bar, then `main.decide` with the page. */
const DecisionFrame = ({ waitsUnder }: { readonly waitsUnder: DecisionPlace }) => {
  const { slug } = useParams({ strict: false });
  const orgs = latest(useAtomValue(orgsAtom));
  const org = orgs?.find(listed => listed.slug === slug) ?? null;
  return (
    <>
      {/* While the orgs load there is no org to name, and no way back to it. */}
      <DecisionBar
        org={org}
        waitsUnder={org === null && waitsUnder !== 'account' ? null : waitsUnder}
      />
      <Outlet />
    </>
  );
};
