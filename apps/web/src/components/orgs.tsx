// Orgs on the Account page and at `/orgs`: the form that creates one, the list, and the first-org
// page. The org an address names is `org-scope.tsx`.
import { LabelSchema, type Org, OrgSlugSchema } from '@baymutt/api';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { Navigate, useLocation, useNavigate } from '@tanstack/react-router';
import * as Atom from 'effect/reactivity/Atom';
import * as Schema from 'effect/Schema';
import { useEffect, useState } from 'react';
import { createOrgAtom, deleteOrgAtom, orgsAtom } from '../lib/data.ts';
import { counted } from '../lib/format.ts';
import { clearsFailure, failureMessage, latest } from '../lib/result.ts';
import { useOwner } from './gate.tsx';
import { homeOrg } from './org-scope.tsx';
import { useTitle } from './shell.tsx';
import { Button } from './ui/button.tsx';
import { Confirm } from './ui/dialog.tsx';
import { TextField } from './ui/field.tsx';
import { ActionForm, useInlineForm } from './ui/form.tsx';
import { EmptyState, List, Missing, Notice, Row, Rows, Skeleton, Status } from './ui/list.tsx';
import { RowMenu } from './ui/menu.tsx';
import { PageHead } from './ui/page.tsx';
import { Code } from './ui/text.tsx';

const FirstOrg = () => {
  useTitle('Create your first org');
  return (
    <>
      <PageHead
        title={<h1>Create your first org</h1>}
        sub="Every environment is named with its org’s slug first."
      />
      <NewOrg placement="page" />
    </>
  );
};

/** `/orgs`: the org this browser last showed, or the form for a person with no org yet. */
export const OrgsHome = () => {
  const result = useAtomValue(orgsAtom);
  const orgs = latest(result);
  if (orgs === null) {
    const failure = failureMessage(result);
    if (failure === null) return <Skeleton />;
    return (
      <Missing title="Couldn't load your orgs" isFailure>
        {failure}
      </Missing>
    );
  }
  const org = homeOrg(orgs);
  if (org !== null) {
    return <Navigate to="/orgs/$slug/environments" params={{ slug: org.slug }} replace />;
  }
  return <FirstOrg />;
};

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

/**
 * Creates an org and opens its Environments: the first row of Orgs on Account (`row`, with
 * Cancel), or the form of "Create your first org" (`page`).
 */
const NewOrg = ({
  placement,
  onCancel,
}: {
  readonly placement: 'row' | 'page';
  readonly onCancel?: () => void;
}) => {
  const owner = useOwner();
  const [creation, create] = useAtom(createOrgAtom, { mode: 'promiseExit' });
  const clearing = clearsFailure(creation, useAtomSet(createOrgAtom));
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const shownSlug = slug ?? slugOf(name);
  return (
    <ActionForm
      placement={placement}
      submitLabel="Create org"
      pendingLabel="Creating…"
      isPending={creation.waiting}
      isSubmitDisabled={!isName(name) || !isSlug(shownSlug)}
      onCancel={onCancel}
      onSubmit={async () => {
        const exit = await create({ owner, name, slug: shownSlug });
        if (exit._tag !== 'Success') return;
        await navigate({ to: '/orgs/$slug/environments', params: { slug: exit.value.slug } });
      }}
    >
      <TextField
        label="Org name"
        placeholder="Acme Ltd"
        value={name}
        onValueChange={clearing(setName)}
      />
      <TextField
        label="Slug"
        isCode
        placeholder="acme"
        hint="The first part of every environment’s name in it. It cannot change."
        error={
          shownSlug !== '' && !isSlug(shownSlug)
            ? 'Use lower-case letters, digits and hyphens, up to 40.'
            : null
        }
        failure={failureMessage(creation)}
        value={shownSlug}
        onValueChange={clearing(setSlug)}
      />
    </ActionForm>
  );
};

const OrgRow = ({ org }: { readonly org: Org }) => {
  const [deletion, remove] = useAtom(deleteOrgAtom(org.id), { mode: 'promiseExit' });
  const forget = useAtomSet(deleteOrgAtom(org.id));
  const [isConfirming, setIsConfirming] = useState(false);
  return (
    <Row variant="row-acct">
      <b>{org.name}</b>
      <Code>{org.slug}</Code>
      <Status
        fact={
          org.environmentCount === 0 ? (
            'no environments'
          ) : (
            <span className="num">{counted(org.environmentCount, 'environment')}</span>
          )
        }
      />
      <RowMenu
        label={`${org.name}: delete org`}
        items={[{ label: 'Delete org', isDanger: true, onClick: () => setIsConfirming(true) }]}
      />
      <Confirm
        open={isConfirming}
        onOpenChange={setIsConfirming}
        onOpen={() => forget(Atom.Reset)}
        title={`Delete ${org.name}?`}
        keepLabel="Keep it"
        confirmLabel="Delete org"
        pendingLabel="Deleting…"
        isPending={deletion.waiting}
        error={failureMessage(deletion)}
        onConfirm={async () => {
          if ((await remove(org.id))._tag === 'Success') setIsConfirming(false);
        }}
      >
        <p>
          Only an org that holds no environment, in the bin or not, can be deleted. Its activity
          goes with it. This cannot be undone.
        </p>
      </Confirm>
    </Row>
  );
};

/**
 * Account's "Orgs", A to Z. The org menu's "New org" opens Account at `#new-org`, which opens the
 * form, and "All orgs" at `#orgs`, the heading the router scrolls to.
 */
export const OrgList = () => {
  const result = useAtomValue(orgsAtom);
  const orgs = latest(result);
  const form = useInlineForm('new-org');
  const hash = useLocation({ select: location => location.hash });
  const visit = useLocation({ select: location => location.state.__TSR_key });
  // Each visit to `#new-org` opens it, a second pick from the org menu included.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new visit is the reason to open it.
  useEffect(() => {
    if (hash === 'new-org') form.open();
  }, [hash, visit]);
  const rows = (() => {
    if (orgs === null) {
      const failure = failureMessage(result);
      return failure === null ? <Skeleton /> : <Notice tone="danger">{failure}</Notice>;
    }
    if (orgs.length === 0 && !form.isOpen) {
      return <EmptyState>Your orgs show here. New org makes the first.</EmptyState>;
    }
    return (
      <Rows>
        {form.isOpen && <NewOrg placement="row" onCancel={form.close} />}
        {orgs
          .toSorted((a, b) => a.name.localeCompare(b.name))
          .map(org => (
            <OrgRow key={org.id} org={org} />
          ))}
      </Rows>
    );
  })();
  return (
    <List
      title={<span id="orgs">Orgs</span>}
      label="Orgs"
      actions={!form.isOpen && <Button onClick={form.open}>New org</Button>}
    >
      {rows}
    </List>
  );
};
