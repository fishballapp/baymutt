// Orgs in the dashboard: the picker that scopes Environments, Activity and the Bin, the form that
// creates one, and the list on the Account page.
import { LabelSchema, type Org, OrgSlugSchema } from '@baymutt/api';
import { useAtom, useAtomValue } from '@effect/atom-react';
import { CaretDownIcon } from '@phosphor-icons/react';
import * as Schema from 'effect/Schema';
import { useState } from 'react';
import {
  createOrgAtom,
  deleteOrgAtom,
  orgsAtom,
  pickedOrg,
  pickedOrgIdAtom,
  rememberPickedOrg,
} from '../lib/data.ts';
import { counted } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';
import { Code, Notice, Row, RowActions, Rows, Time } from './parts.tsx';
import { Button } from './ui/button.tsx';
import { Confirm } from './ui/confirm.tsx';
import { TextField } from './ui/field.tsx';

/** The person's orgs, and the one the picker shows. `null` while they load. */
export const usePickedOrg = (): {
  readonly orgs: ReadonlyArray<Org> | null;
  readonly org: Org | null;
  readonly pick: (id: string) => void;
} => {
  const orgs = latest(useAtomValue(orgsAtom));
  const [pickedId, setPickedId] = useAtom(pickedOrgIdAtom);
  return {
    orgs,
    org: orgs === null ? null : pickedOrg(orgs, pickedId),
    pick: id => {
      rememberPickedOrg(id);
      setPickedId(id);
    },
  };
};

/** In the nav: which org's environments, activity and bin the pages show. */
export const OrgPicker = () => {
  const { orgs, org, pick } = usePickedOrg();
  if (orgs === null || org === null) return null;
  return (
    <div className="relative">
      <label htmlFor="org-picker" className="sr-only">
        Org
      </label>
      <select
        id="org-picker"
        value={org.id}
        onChange={event => pick(event.target.value)}
        className="h-9 w-full cursor-pointer appearance-none truncate rounded-control border border-line bg-background pr-9 pl-3 text-sm font-medium text-foreground transition-colors duration-150 hover:border-muted focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none"
      >
        {orgs.map(listed => (
          <option key={listed.id} value={listed.id}>
            {listed.name}
          </option>
        ))}
      </select>
      <CaretDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted"
      />
    </div>
  );
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

/** Creates an org and shows it in the picker. */
export const NewOrg = ({ className }: { readonly className?: string }) => {
  const [creation, create] = useAtom(createOrgAtom, { mode: 'promiseExit' });
  const { pick } = usePickedOrg();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const shownSlug = slug ?? slugOf(name);
  const isValid = isName(name) && isSlug(shownSlug);
  return (
    <form
      className={className}
      onSubmit={async event => {
        event.preventDefault();
        const exit = await create({ name, slug: shownSlug });
        if (exit._tag === 'Success') {
          pick(exit.value.id);
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
