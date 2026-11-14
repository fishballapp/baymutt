import { EnvironmentNameSchema, type Org } from '@baymutt/api';
import { useAtom, useAtomValue } from '@effect/atom-react';
import { CaretRightIcon } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import * as Schema from 'effect/Schema';
import { useState } from 'react';
import { useOwner } from '../components/gate.tsx';
import { NewOrg, usePickedOrg } from '../components/orgs.tsx';
import {
  Code,
  CommandLine,
  Empty,
  Notice,
  PageHeader,
  Row,
  Rows,
  Skeleton,
  Time,
} from '../components/parts.tsx';
import { Button } from '../components/ui/button.tsx';
import { TextField } from '../components/ui/field.tsx';
import { addressOf, createEnvironmentAtom, environmentsAtom } from '../lib/data.ts';
import { counted } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

const isEnvironmentName = Schema.is(EnvironmentNameSchema);

const NewEnvironment = ({ org }: { readonly org: Org }) => {
  const owner = useOwner();
  const [creation, create] = useAtom(createEnvironmentAtom, { mode: 'promiseExit' });
  const [name, setName] = useState('');
  const isValid = isEnvironmentName(name);
  return (
    <form
      className="mb-8"
      onSubmit={async event => {
        event.preventDefault();
        const exit = await create({ owner, orgId: org.id, name });
        if (exit._tag === 'Success') setName('');
      }}
    >
      <TextField
        label="New environment"
        isCode
        placeholder="app/production"
        hint={
          <>
            Lower-case segments joined by /. Its full name is{' '}
            <Code>
              {org.slug}/{name === '' ? 'app/production' : name}
            </Code>
            .
          </>
        }
        error={
          name !== '' && !isValid
            ? 'Use lower-case letters, digits, dots and dashes, in segments joined by /.'
            : failureMessage(creation)
        }
        value={name}
        onChange={event => setName(event.target.value)}
        action={
          <Button type="submit" intent="primary" disabled={!isValid || creation.waiting}>
            {creation.waiting ? 'Creating…' : 'Create environment'}
          </Button>
        }
      />
    </form>
  );
};

export const EnvironmentsPage = () => {
  const result = useAtomValue(environmentsAtom);
  const { orgs, org } = usePickedOrg();
  const environments = latest(result)?.filter(environment => environment.orgId === org?.id) ?? null;
  if (orgs !== null && org === null) {
    return (
      <>
        <PageHeader
          title="Environments"
          lede="Every environment belongs to an org, and is named with the org’s slug first."
        />
        <NewOrg />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Environments"
        lede="An environment is the unit of access. Every CLI login reads and writes each one; a service account holds only the ones it was handed."
      />
      {org !== null && <NewEnvironment org={org} />}
      {failureMessage(result) && <Notice>{failureMessage(result)}</Notice>}
      {(environments === null || org === null) && !failureMessage(result) && <Skeleton />}
      {org !== null && environments?.length === 0 && (
        <Empty title={`No environments in ${org.name} yet`}>
          <p>
            Create one above, or from a CLI login. An environment a CLI login creates shows up here,
            and you can read it.
          </p>
          <CommandLine>{`baymutt environments create ${org.slug}/app/production`}</CommandLine>
        </Empty>
      )}
      {environments !== null && environments.length > 0 && (
        <Rows>
          {environments.map(environment => (
            <Row key={environment.id} className="p-0">
              <Link
                to="/environments/$id"
                params={{ id: environment.id }}
                className="group flex items-center gap-4 px-4 py-3 transition-colors duration-150 ease-out hover:bg-sunken focus-visible:-outline-offset-2"
              >
                <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5">
                  <Code className="text-base font-medium">{addressOf(environment)}</Code>
                  <span className="text-sm text-muted">
                    {counted(environment.secretCount, 'secret')} · made by{' '}
                    {environment.createdBy.name} <Time at={environment.createdAt} />
                  </span>
                </span>
                <CaretRightIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted transition-colors duration-150 ease-out group-hover:text-foreground"
                />
              </Link>
            </Row>
          ))}
        </Rows>
      )}
    </>
  );
};
