import { SecretNameSchema } from '@baymutt/api';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { Link, useNavigate } from '@tanstack/react-router';
import { cn } from 'cn';
import * as Option from 'effect/Option';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';
import * as Schema from 'effect/Schema';
import { useLayoutEffect, useState } from 'react';
import { useJustWritten } from '../components/environment/just-written.ts';
import { KeysThatReach } from '../components/environment/keys-that-reach.tsx';
import { SecretRow } from '../components/environment/secret-row.tsx';
import { ValueField } from '../components/environment/value-field.tsx';
import { useOwner } from '../components/gate.tsx';
import { useOrg } from '../components/org-scope.tsx';
import { useTitle } from '../components/shell.tsx';
import { Button, buttonClass } from '../components/ui/button.tsx';
import { Confirm } from '../components/ui/dialog.tsx';
import { TextField } from '../components/ui/field.tsx';
import { ActionForm, useInlineForm } from '../components/ui/form.tsx';
import { EmptyState, List, Missing, Notice, Rows, Skeleton } from '../components/ui/list.tsx';
import { PageHead } from '../components/ui/page.tsx';
import { Address } from '../components/ui/text.tsx';
import {
  addressOf,
  deleteEnvironmentAtom,
  environmentAtom,
  NAME_NOT_OPENED,
  type OpenedEnvironment,
  secretsAtom,
  writeSecretAtom,
} from '../lib/data.ts';
import { clearsFailure, failureMessage, latest } from '../lib/result.ts';

const isSecretName = Schema.is(SecretNameSchema);

const ADD_SECRET = 'add-secret';

/** The first row of Secrets: a name and its value, sealed here. It closes once saved. */
const AddSecretForm = ({ environment }: { readonly environment: OpenedEnvironment }) => {
  const owner = useOwner();
  const form = useInlineForm(ADD_SECRET);
  const [writing, write] = useAtom(writeSecretAtom, { mode: 'promiseExit' });
  const forget = useAtomSet(writeSecretAtom);
  // One atom serves Add a secret and every Replace: another form's failure is not this one's.
  useLayoutEffect(() => {
    forget(Atom.Reset);
  }, [forget]);
  const clearing = clearsFailure(writing, forget);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  return (
    <ActionForm
      placement="row"
      label="Add a secret"
      submitLabel="Seal and save"
      pendingLabel="Sealing…"
      isPending={writing.waiting}
      isSubmitDisabled={!isSecretName(name) || value === ''}
      onSubmit={async () => {
        const exit = await write({ owner, environment, name, value });
        if (exit._tag === 'Success') form.close();
      }}
      onCancel={form.close}
    >
      <TextField
        label="Name"
        isCode
        placeholder="STRIPE_SECRET_KEY"
        error={
          name !== '' && !isSecretName(name)
            ? 'Letters, digits and underscores, not starting with a digit.'
            : null
        }
        value={name}
        onValueChange={clearing(setName)}
      />
      <ValueField
        label="Value"
        failure={failureMessage(writing)}
        value={value}
        onValueChange={clearing(setValue)}
      />
    </ActionForm>
  );
};

const Secrets = ({ environment }: { readonly environment: OpenedEnvironment }) => {
  const result = useAtomValue(secretsAtom(useOwner())(environment.id));
  // A deleted secret is in the Bin, not here.
  const secrets =
    latest(result)?.flatMap(secret =>
      secret.currentVersion === null ? [] : [{ secret, version: secret.currentVersion }],
    ) ?? null;
  const adding = useInlineForm(ADD_SECRET);
  const justWritten = useJustWritten(
    secrets?.map(({ secret, version }) => ({ id: secret.name, stamp: String(version) })) ?? null,
  );
  const failure = failureMessage(result);
  return (
    <List
      title="Secrets"
      note={
        secrets !== null &&
        secrets.length > 0 &&
        'Revealing or copying a value opens it in this browser, and Activity records it.'
      }
    >
      {(() => {
        if (secrets === null && failure !== null) return <Notice tone="danger">{failure}</Notice>;
        if (secrets === null) return <Skeleton />;
        if (secrets.length === 0 && !adding.isOpen) {
          return (
            <EmptyState
              example={{
                lead: 'An agent asks you for one in a plan’s `secrets` step:',
                commands: ['baymutt ask plan.json'],
              }}
            >
              Its secrets show here. Add a secret seals the first in this browser.
            </EmptyState>
          );
        }
        return (
          <Rows>
            {adding.isOpen && <AddSecretForm environment={environment} />}
            {secrets.map(({ secret, version }) => (
              <SecretRow
                key={secret.name}
                environment={environment}
                secret={secret}
                version={version}
                flash={justWritten(secret.name)}
              />
            ))}
          </Rows>
        );
      })()}
    </List>
  );
};

const DeleteEnvironment = ({ environment }: { readonly environment: OpenedEnvironment }) => {
  const navigate = useNavigate();
  const [deleting, remove] = useAtom(deleteEnvironmentAtom, { mode: 'promiseExit' });
  const forget = useAtomSet(deleteEnvironmentAtom);
  return (
    <List title="Delete this environment" isDanger>
      <p className="muted">
        It goes to the Bin, and every load and write of it stops. You can restore it for 30 days.
        Its name stays taken until it is removed for good.
      </p>
      <p className="btn-row">
        <Confirm
          trigger={<Button kind="danger">Delete environment</Button>}
          onOpen={() => forget(Atom.Reset)}
          title={
            environment.openedName === null ? (
              'Delete this environment?'
            ) : (
              <>
                Delete <Address orgSlug={environment.orgSlug} name={environment.openedName} />?
              </>
            )
          }
          keepLabel="Keep environment"
          confirmLabel="Delete environment"
          pendingLabel="Deleting…"
          isPending={deleting.waiting}
          error={failureMessage(deleting)}
          onConfirm={async () => {
            const exit = await remove(environment.id);
            if (exit._tag !== 'Success') return;
            await navigate({
              to: '/orgs/$slug/environments',
              params: { slug: environment.orgSlug },
            });
          }}
        >
          <p>
            Anything that loads it will fail on its next run, deploys included. It stays in the Bin
            for 30 days, where you can restore it.
          </p>
        </Confirm>
      </p>
    </List>
  );
};

/** Not found here, or failed to load: in the page's place, with a way back. */
const EnvironmentMissing = ({ failure }: { readonly failure: string | null }) => {
  const org = useOrg();
  const title = failure === null ? 'No environment here' : 'Couldn’t load this environment';
  useTitle(title, org.name);
  return (
    <Missing
      title={title}
      isFailure={failure !== null}
      action={
        failure === null && (
          <Link to="/orgs/$slug/environments" params={{ slug: org.slug }} className={buttonClass()}>
            See environments
          </Link>
        )
      }
    >
      {failure ?? `${org.name} has no environment with this id.`}
    </Missing>
  );
};

const Environment = ({ environment }: { readonly environment: OpenedEnvironment }) => {
  const address = addressOf({ orgSlug: environment.orgSlug, name: environment.openedName });
  useTitle(address);
  const adding = useInlineForm(ADD_SECRET);
  // The head's primary hides while a form is open (Add a secret, a Replace), not while History is.
  const isReplacing = adding.openId?.startsWith('replace:') ?? false;
  return (
    <>
      <PageHead
        title={
          <h1 className={cn('code-title addr', environment.openedName === null && 'unopened')}>
            <span className="org">{environment.orgSlug}/</span>
            {environment.openedName ?? NAME_NOT_OPENED}
          </h1>
        }
        primary={
          !adding.isOpen &&
          !isReplacing && (
            <Button kind="primary" onClick={adding.open}>
              Add a secret
            </Button>
          )
        }
      />
      <Secrets environment={environment} />
      <KeysThatReach environment={environment} />
      <DeleteEnvironment environment={environment} />
    </>
  );
};

export const EnvironmentPage = ({ id }: { readonly id: string }) => {
  const org = useOrg();
  const result = useAtomValue(environmentAtom(useOwner())(id));
  const found = latest(result);
  // Only an environment of the org the address names: one of another org is not found here.
  if (found !== null && found.orgId !== org.id) return <EnvironmentMissing failure={null} />;
  if (found !== null) return <Environment environment={found} />;
  const failure = failureMessage(result);
  if (failure === null) return <Skeleton hasTitle />;
  const isNotFound =
    AsyncResult.isFailure(result) &&
    Option.match(AsyncResult.error(result), {
      onNone: () => false,
      onSome: error => error._tag === 'NotFoundError',
    });
  return <EnvironmentMissing failure={isNotFound ? null : failure} />;
};
