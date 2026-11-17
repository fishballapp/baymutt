// Orgs in the dashboard: the org an address names (`/orgs/<slug>/…`) and the scope it gives every
// page under it, the picker that moves between orgs, the form that creates one, and the list on
// the Account page.
import { LabelSchema, type Org, OrgSlugSchema } from '@baymutt/api';
import { useAtom, useAtomValue } from '@effect/atom-react';
import { CaretDownIcon } from '@phosphor-icons/react';
import { Link, Navigate, useNavigate } from '@tanstack/react-router';
import * as Schema from 'effect/Schema';
import { createContext, type ReactNode, use, useEffect, useState } from 'react';
import { createOrgAtom, deleteOrgAtom, orgsAtom } from '../lib/data.ts';
import { counted } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';
import { useOwner } from './gate.tsx';
import { Code, Notice, PageHeader, Row, RowActions, Rows, Skeleton, Time } from './parts.tsx';
import { Button, buttonStyles } from './ui/button.tsx';
import { Confirm } from './ui/confirm.tsx';
import { TextField } from './ui/field.tsx';

/** Holds a slug. A new name: `baymutt.org` held an org's id before 0.10.0. */
const LAST_ORG = 'baymutt.lastOrgSlug';

/**
 * The org the dashboard opens on: the one this browser last showed, else the first. The address
 * decides which org a page shows; this decides only where `/orgs` and the wordmark land.
 */
export const homeOrg = (orgs: ReadonlyArray<Org>): Org | null =>
  orgs.find(org => org.slug === localStorage.getItem(LAST_ORG)) ?? orgs[0] ?? null;

const OrgContext = createContext<Org | null>(null);

/** The org the address names. Only under `OrgScope`, which renders nothing beneath it for any other. */
export const useOrg = (): Org => {
  const org = use(OrgContext);
  if (org === null) throw new Error('useOrg is only available under OrgScope');
  return org;
};

/**
 * Everything under `/orgs/<slug>`: the person's org with that slug, or a page that says there is
 * none, with a way back.
 */
export const OrgScope = ({
  slug,
  children,
}: {
  readonly slug: string;
  readonly children: ReactNode;
}) => {
  const result = useAtomValue(orgsAtom);
  const orgs = latest(result);
  const org = orgs?.find(listed => listed.slug === slug);
  useEffect(() => {
    if (org !== undefined) localStorage.setItem(LAST_ORG, org.slug);
  }, [org]);
  if (orgs === null) {
    const failure = failureMessage(result);
    return failure === null ? <Skeleton /> : <Notice>{failure}</Notice>;
  }
  // An org just created is not in the list until it has been read again.
  if (org === undefined && result.waiting) return <Skeleton />;
  if (org === undefined) {
    return (
      <div className="max-w-[34rem] space-y-4">
        <h1 className="text-xl">No org here</h1>
        <p className="text-muted">
          None of your orgs has the slug <Code className="text-foreground">{slug}</Code>.
        </p>
        <Link to="/orgs" className={buttonStyles()}>
          Go to your orgs
        </Link>
      </div>
    );
  }
  return <OrgContext value={org}>{children}</OrgContext>;
};

/** `/orgs`: the org this browser last showed, or the form for a person with no org yet. */
export const OrgsHome = () => {
  const result = useAtomValue(orgsAtom);
  const orgs = latest(result);
  if (orgs === null) {
    const failure = failureMessage(result);
    return failure === null ? <Skeleton /> : <Notice>{failure}</Notice>;
  }
  const org = homeOrg(orgs);
  if (org !== null) {
    return <Navigate to="/orgs/$slug/environments" params={{ slug: org.slug }} replace />;
  }
  return (
    <>
      <PageHeader
        title="Create your first org"
        lede="Every environment belongs to an org, and is named with the org’s slug first."
      />
      <NewOrg />
    </>
  );
};

/** In the nav: the org the page shows. Picking another opens it at `onPick`'s section. */
export const OrgPicker = ({
  orgs,
  current,
  onPick,
}: {
  readonly orgs: ReadonlyArray<Org>;
  readonly current: Org;
  readonly onPick: (org: Org) => void;
}) => (
  <div className="relative">
    <label htmlFor="org-picker" className="sr-only">
      Org
    </label>
    <select
      id="org-picker"
      value={current.id}
      onChange={event => {
        const picked = orgs.find(org => org.id === event.target.value);
        if (picked !== undefined) onPick(picked);
      }}
      className="h-9 w-full cursor-pointer appearance-none truncate rounded-control border border-line bg-background pr-9 pl-3 text-sm font-medium text-foreground transition-colors duration-150 hover:border-muted focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none"
    >
      {orgs.map(org => (
        <option key={org.id} value={org.id}>
          {org.name}
        </option>
      ))}
    </select>
    <CaretDownIcon
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted"
    />
  </div>
);

const isName = Schema.is(LabelSchema);
const isSlug = Schema.is(OrgSlugSchema);

/** A slug from a name: lower case, runs of anything else as one hyphen. */
const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');

/** Creates an org and opens it. */
export const NewOrg = ({ className }: { readonly className?: string }) => {
  const owner = useOwner();
  const [creation, create] = useAtom(createOrgAtom, { mode: 'promiseExit' });
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const shownSlug = slug ?? slugOf(name);
  const isValid = isName(name) && isSlug(shownSlug);
  return (
    <form
      className={className}
      onSubmit={async event => {
        event.preventDefault();
        const exit = await create({ owner, name, slug: shownSlug });
        if (exit._tag === 'Success') {
          await navigate({ to: '/orgs/$slug/environments', params: { slug: exit.value.slug } });
          setName('');
          setSlug(null);
        }
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Org name"
          placeholder="Acme Ltd"
          value={name}
          onChange={event => setName(event.target.value)}
        />
        <TextField
          label="Slug"
          isCode
          placeholder="acme"
          hint="The first part of every environment’s name in it. It cannot change."
          error={
            shownSlug !== '' && !isSlug(shownSlug)
              ? 'Use lower-case letters, digits and hyphens, up to 40.'
              : failureMessage(creation)
          }
          value={shownSlug}
          onChange={event => setSlug(event.target.value)}
        />
      </div>
      <Button
        type="submit"
        intent="primary"
        className="mt-4"
        disabled={!isValid || creation.waiting}
      >
        {creation.waiting ? 'Creating…' : 'Create org'}
      </Button>
    </form>
  );
};

const OrgRow = ({ org }: { readonly org: Org }) => {
  const [deletion, remove] = useAtom(deleteOrgAtom(org.id), { mode: 'promiseExit' });
  const [isOpen, setOpen] = useState(false);
  return (
    <Row>
      <div className="flex flex-col gap-x-4 gap-y-2 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p>
            <span className="font-medium">{org.name}</span> <Code>{org.slug}</Code>
          </p>
          <p className="mt-0.5 text-sm text-muted">
            {counted(org.environmentCount, 'environment')} · created <Time at={org.createdAt} />
          </p>
        </div>
        <RowActions>
          <Confirm
            open={isOpen}
            onOpenChange={setOpen}
            trigger={
              <Button size="sm" intent="subtleDanger">
                Delete org
              </Button>
            }
            title={`Delete ${org.name}?`}
            keepLabel="Keep it"
            confirmLabel="Delete org"
            pendingLabel="Deleting…"
            isDangerous
            isPending={deletion.waiting}
            error={failureMessage(deletion)}
            onConfirm={async () => {
              if ((await remove(org.id))._tag === 'Success') setOpen(false);
            }}
          >
            <p>
              Only an org that holds no environment, in the bin or not, can be deleted. Its activity
              goes with it. This cannot be undone.
            </p>
          </Confirm>
        </RowActions>
      </div>
    </Row>
  );
};

/** The Account page's list of orgs. */
export const OrgList = () => {
  const result = useAtomValue(orgsAtom);
  const orgs = latest(result);
  return (
    <>
      {failureMessage(result) && <Notice>{failureMessage(result)}</Notice>}
      {orgs !== null && orgs.length > 0 && (
        <Rows className="mb-6">
          {orgs.map(org => (
            <OrgRow key={org.id} org={org} />
          ))}
        </Rows>
      )}
      <NewOrg />
    </>
  );
};
