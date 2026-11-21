import { EnvironmentNameSchema, type Org } from '@baymutt/api';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { Link } from '@tanstack/react-router';
import * as Atom from 'effect/reactivity/Atom';
import * as Schema from 'effect/Schema';
import { useState } from 'react';
import { useJustWritten } from '../components/environment/just-written.ts';
import { useOwner } from '../components/gate.tsx';
import { useOrg } from '../components/org-scope.tsx';
import { useTitle } from '../components/shell.tsx';
import { Button } from '../components/ui/button.tsx';
import { Field, PrefixedInput } from '../components/ui/field.tsx';
import { Filter, NoMatch, useFilter } from '../components/ui/filter.tsx';
import { ActionForm, useInlineForm } from '../components/ui/form.tsx';
import { EmptyState, List, Notice, Row, Rows, Skeleton } from '../components/ui/list.tsx';
import { PageHead } from '../components/ui/page.tsx';
import { Address } from '../components/ui/text.tsx';
import {
  addressOf,
  createEnvironmentAtom,
  environmentsAtom,
  hasEnded,
  isLogin,
  serviceAccountsAtom,
} from '../lib/data.ts';
import { counted } from '../lib/format.ts';
import { clearsFailure, failureMessage, latest } from '../lib/result.ts';

const isEnvironmentName = Schema.is(EnvironmentNameSchema);

const NEW_ENVIRONMENT = 'new-environment';

/** The first row of "All environments": a name under the org's fixed slug. It stays open after a create. */
const NewEnvironmentForm = ({ org }: { readonly org: Org }) => {
  const owner = useOwner();
  const form = useInlineForm(NEW_ENVIRONMENT);
  const [creation, create] = useAtom(createEnvironmentAtom, { mode: 'promiseExit' });
  const clearing = clearsFailure(creation, useAtomSet(createEnvironmentAtom));
  const [name, setName] = useState('');
  const isValid = isEnvironmentName(name);
  return (
    <ActionForm
      placement="row"
      label="New environment"
      submitLabel="Create environment"
      pendingLabel="Creating…"
      isPending={creation.waiting}
      isSubmitDisabled={!isValid}
      onSubmit={async () => {
        const exit = await create({ owner, orgId: org.id, name });
        if (exit._tag === 'Success') setName('');
      }}
      onCancel={form.close}
    >
      <Field
        label="Name"
        hint="Lower-case segments joined by /."
        error={
          name !== '' && !isValid
            ? 'Use lower-case letters, digits, dots and dashes, in segments joined by /.'
            : null
        }
        failure={failureMessage(creation)}
      >
        <PrefixedInput
          prefix={`${org.slug}/`}
          placeholder="app/production"
          value={name}
          onValueChange={clearing(setName)}
        />
      </Field>
    </ActionForm>
  );
};

export const EnvironmentsPage = () => {
  const owner = useOwner();
  const org = useOrg();
  useTitle('Environments', org.name);
  const result = useAtomValue(environmentsAtom(owner));
  const environments = latest(result)?.filter(environment => environment.orgId === org.id) ?? null;
  const keys = latest(useAtomValue(serviceAccountsAtom(owner))) ?? [];
  const form = useInlineForm(NEW_ENVIRONMENT);
  const filter = useFilter(environments?.length ?? 0);
  const justWritten = useJustWritten(
    environments?.map(environment => ({ id: environment.id, stamp: environment.id })) ?? null,
  );
  // A failure from an earlier visit is not this form's.
  const forgetCreation = useAtomSet(createEnvironmentAtom);
  const now = Date.now();
  const keyCount = (environmentId: string) =>
    keys.filter(
      key =>
        !isLogin(key) &&
        !hasEnded(key, now) &&
        key.grants.some(grant => grant.environmentId === environmentId),
    ).length;
  const shown =
    environments?.filter(environment =>
      filter.matches(addressOf({ orgSlug: environment.orgSlug, name: environment.openedName })),
    ) ?? null;
  const isNoMatch = filter.isFiltering && shown?.length === 0 && !form.isOpen;
  const failure = failureMessage(result);

  return (
    <>
      <PageHead
        title={<h1>Environments</h1>}
        filter={filter.isShown && <Filter filter={filter} placeholder="name" />}
        primary={
          !form.isAnyOpen && (
            <Button
              kind="primary"
              onClick={() => {
                filter.clear();
                forgetCreation(Atom.Reset);
                form.open();
              }}
            >
              New environment
            </Button>
          )
        }
      />
      {isNoMatch ? (
        <NoMatch filter={filter}>
          No environment in {org.name} matches “{filter.query.trim()}”.
        </NoMatch>
      ) : (
        <List
          title="All environments"
          count={filter.isFiltering ? undefined : environments?.length}
        >
          {(() => {
            if (failure !== null && environments === null) {
              return <Notice tone="danger">{failure}</Notice>;
            }
            if (shown === null) return <Skeleton />;
            if (shown.length === 0 && !form.isOpen) {
              return (
                <EmptyState
                  example={{
                    lead: 'An agent can also ask you for one with an `environments` step:',
                    commands: ['baymutt ask ask.json'],
                  }}
                >
                  {org.name}’s environments show here. New environment makes the first.
                </EmptyState>
              );
            }
            return (
              <Rows>
                {form.isOpen && <NewEnvironmentForm org={org} />}
                {shown.map(environment => {
                  const keysReaching = keyCount(environment.id);
                  return (
                    <Row key={environment.id} variant="" {...justWritten(environment.id)}>
                      <Link
                        to="/orgs/$slug/environments/$id"
                        params={{ slug: org.slug, id: environment.id }}
                        className="row-env"
                      >
                        <Address orgSlug={environment.orgSlug} name={environment.openedName} />
                        <span className="count">{counted(environment.secretCount, 'secret')}</span>
                        <span className="count">
                          {keysReaching === 0 ? 'no keys' : counted(keysReaching, 'key')}
                        </span>
                      </Link>
                    </Row>
                  );
                })}
              </Rows>
            );
          })()}
        </List>
      )}
    </>
  );
};
