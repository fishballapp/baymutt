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
  Empty,
  Notice,
  PageHeader,
  Row,
  Rows,
  Section,
  Skeleton,
  Time,
} from '../components/parts.tsx';
import { Button, buttonStyles } from '../components/ui/button.tsx';
import { TextField } from '../components/ui/field.tsx';
import {
  addressOf,
  createEnvironmentAtom,
  environmentRequestsAtom,
  environmentsAtom,
} from '../lib/data.ts';
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

/**
 * Environment requests waiting for the owner, in every org: each as a sentence, its decision on
 * its own page.
 */
const EnvironmentRequests = () => {
  const requests = latest(useAtomValue(environmentRequestsAtom(useOwner())));
  if (requests === null || requests.length === 0) return null;
  return (
    <Section
      title="Requests"
      lede="Each waits for you. Approving one creates the environment."
      className="mb-10"
    >
      <Rows>
        {requests.map(request => (
          <Row key={request.id}>
            <div className="flex flex-col gap-x-4 gap-y-2 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <p>
                  <span className="font-medium">{request.createdBy.name}</span> asks for a new
                  environment,{' '}
                  <Code>{addressOf({ orgSlug: request.orgSlug, name: request.openedName })}</Code>
                </p>
                <p className="mt-1.5 max-w-[65ch] border-line border-l pl-3 text-sm text-muted [overflow-wrap:anywhere]">
                  {request.reason}
                </p>
                <p className="mt-1.5 text-sm text-muted">
                  asked <Time at={request.createdAt} />
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5 sm:shrink-0">
                <Link
                  to="/environment-requests/$id"
                  params={{ id: request.id }}
                  className={buttonStyles()}
                >
                  Review
                </Link>
              </div>
            </div>
          </Row>
        ))}
      </Rows>
    </Section>
  );
};

export const EnvironmentsPage = () => {
  const result = useAtomValue(environmentsAtom(useOwner()));
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
        lede="An environment is the unit of access. A CLI login lists it and opens nothing in it; a service account reaches it when a request you approved named it."
      />
      <EnvironmentRequests />
      {org !== null && <NewEnvironment org={org} />}
      {failureMessage(result) && <Notice>{failureMessage(result)}</Notice>}
      {(environments === null || org === null) && !failureMessage(result) && <Skeleton />}
      {org !== null && environments?.length === 0 && (
        <Empty title={`No environments in ${org.name} yet`}>
          <p>
            Create one above. A CLI login asks for one with{' '}
            <Code>baymutt ask create-environment</Code>.
          </p>
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
                  <Code className="text-base font-medium">
                    {addressOf({ orgSlug: environment.orgSlug, name: environment.openedName })}
                  </Code>
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
