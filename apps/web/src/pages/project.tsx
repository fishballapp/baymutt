import { type Grant, type Project, type Secret, SecretNameSchema } from '@baymutt/api';
import { useAtom, useAtomValue } from '@effect/atom-react';
import { CaretLeftIcon } from '@phosphor-icons/react';
import { Link, useNavigate } from '@tanstack/react-router';
import * as Schema from 'effect/Schema';
import { useState } from 'react';
import { useOwner } from '../components/gate.tsx';
import {
  Code,
  CommandLine,
  Empty,
  grantWords,
  Notice,
  PageHeader,
  Row,
  RowActions,
  Rows,
  Section,
  Skeleton,
  Tag,
  Time,
} from '../components/parts.tsx';
import { Button } from '../components/ui/button.tsx';
import { Confirm } from '../components/ui/confirm.tsx';
import { SelectField, TextArea, TextField } from '../components/ui/field.tsx';
import {
  archiveProjectAtom,
  grantsAtom,
  machinesAtom,
  projectAtom,
  removeGrantAtom,
  removeSecretAtom,
  rollbackSecretAtom,
  secretsAtom,
  setGrantAtom,
  versionsAtom,
  writeSecretAtom,
} from '../lib/data.ts';
import { bytes, counted, exactTime } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

const isSecretName = Schema.is(SecretNameSchema);

const SEALED_NOTE =
  'Sealed in this browser to the project’s key. baymutt cannot read it, and this page will not show it again.';

/** Name and value in; a sealed version out. `name` fixed means replacing that secret. */
const ValueForm = ({
  project,
  name: fixedName,
  onDone,
}: {
  readonly project: Project;
  readonly name?: string;
  readonly onDone?: () => void;
}) => {
  const owner = useOwner();
  const [writing, write] = useAtom(writeSecretAtom, { mode: 'promiseExit' });
  const [name, setName] = useState(fixedName ?? '');
  const [value, setValue] = useState('');
  const isValid = isSecretName(name) && value !== '';
  return (
    <form
      className="space-y-3"
      onSubmit={async event => {
        event.preventDefault();
        const exit = await write({ owner, project, name, value });
        if (exit._tag !== 'Success') return;
        setValue('');
        if (fixedName === undefined) setName('');
        onDone?.();
      }}
    >
      {fixedName === undefined && (
        <TextField
          label="Name"
          isCode
          placeholder="STRIPE_SECRET_KEY"
          error={
            name !== '' && !isSecretName(name)
              ? 'An environment variable name: letters, digits and underscores, not starting with a digit.'
              : null
          }
          value={name}
          onChange={event => setName(event.target.value)}
        />
      )}
      <TextArea
        label={fixedName === undefined ? 'Value' : `New value for ${fixedName}`}
        isCode
        hint={SEALED_NOTE}
        error={failureMessage(writing)}
        value={value}
        onChange={event => setValue(event.target.value)}
      />
      <div className="flex gap-2">
        <Button type="submit" intent="primary" disabled={!isValid || writing.waiting}>
          {writing.waiting ? 'Sealing…' : 'Seal and save'}
        </Button>
        {onDone && <Button onClick={onDone}>Cancel</Button>}
      </div>
    </form>
  );
};

const History = ({ projectId, name }: { readonly projectId: string; readonly name: string }) => {
  const versions = latest(useAtomValue(versionsAtom({ projectId, name })));
  const [rolling, rollback] = useAtom(rollbackSecretAtom);
  if (versions === null) return <p className="text-sm text-muted">Loading its versions…</p>;
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-line rounded-control border border-line bg-background">
        {versions.map(version => (
          <li
            key={version.version}
            className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1.5 text-sm"
          >
            <span className="w-8 font-medium tabular-nums">v{version.version}</span>
            <span className="text-muted">
              {bytes(version.size)} · {version.createdBy.name} · <Time at={version.createdAt} />
            </span>
            <span className="ml-auto">
              {version.isCurrent ? (
                <Tag tone="accent">current</Tag>
              ) : (
                <Button
                  size="sm"
                  intent="subtle"
                  disabled={rolling.waiting}
                  onClick={() => rollback({ projectId, name, version: version.version })}
                >
                  Make v{version.version} current
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {failureMessage(rolling) && <Notice>{failureMessage(rolling)}</Notice>}
    </div>
  );
};

const SecretRow = ({ project, secret }: { readonly project: Project; readonly secret: Secret }) => {
  const [panel, setPanel] = useState<'replace' | 'history' | null>(null);
  const [removing, remove] = useAtom(removeSecretAtom, { mode: 'promiseExit' });
  const [isConfirming, setIsConfirming] = useState(false);
  const isDeleted = secret.currentVersion === null;
  const toggle = (next: 'replace' | 'history') => setPanel(panel === next ? null : next);
  return (
    // A row written in the last few seconds says so once: it is the only motion on the page.
    <Row className={Date.now() - secret.updatedAt < 3000 ? 'animate-written' : undefined}>
      <div className="flex flex-col gap-x-4 gap-y-2 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <Code className={isDeleted ? 'text-muted line-through' : 'text-base font-medium'}>
            {secret.name}
          </Code>
          <p className="mt-0.5 text-sm text-muted">
            {isDeleted
              ? `deleted · ${counted(secret.latestVersion, 'version')} kept`
              : `sealed · ${bytes(secret.size ?? 0)} · v${secret.currentVersion}`}{' '}
            · {secret.updatedBy.name}, <Time at={secret.updatedAt} />
          </p>
        </div>
        <RowActions>
          {!isDeleted && (
            <Button
              size="sm"
              intent="subtle"
              aria-expanded={panel === 'replace'}
              onClick={() => toggle('replace')}
            >
              Replace
            </Button>
          )}
          <Button
            size="sm"
            intent="subtle"
            aria-expanded={panel === 'history'}
            onClick={() => toggle('history')}
          >
            {isDeleted ? 'Restore' : 'History'}
          </Button>
          {!isDeleted && (
            <Confirm
              open={isConfirming}
              onOpenChange={setIsConfirming}
              trigger={
                <Button size="sm" intent="subtleDanger">
                  Delete
                </Button>
              }
              title={`Delete ${secret.name}?`}
              keepLabel="Keep it"
              confirmLabel="Delete secret"
              pendingLabel="Deleting…"
              isDangerous
              isPending={removing.waiting}
              error={failureMessage(removing)}
              onConfirm={async () => {
                const exit = await remove({ projectId: project.id, name: secret.name });
                if (exit._tag === 'Success') setIsConfirming(false);
              }}
            >
              <p>
                Machines stop receiving it on their next load. Its versions are kept, so you can
                restore it from its history.
              </p>
            </Confirm>
          )}
        </RowActions>
      </div>
      {panel !== null && (
        <div className="mt-3 border-line border-t pt-3">
          {panel === 'replace' ? (
            <ValueForm project={project} name={secret.name} onDone={() => setPanel(null)} />
          ) : (
            <History projectId={project.id} name={secret.name} />
          )}
        </div>
      )}
    </Row>
  );
};

const Secrets = ({ project }: { readonly project: Project }) => {
  const result = useAtomValue(secretsAtom(project.id));
  const secrets = latest(result);
  const [isAdding, setIsAdding] = useState(false);
  return (
    <Section
      title="Secrets"
      lede="Names, versions and sizes. No value is ever shown here: there is nothing to reveal."
      action={
        !isAdding && (
          <Button intent="primary" onClick={() => setIsAdding(true)}>
            Add a secret
          </Button>
        )
      }
    >
      {isAdding && (
        <div className="mb-4 rounded-panel border border-line bg-surface p-4">
          <ValueForm project={project} onDone={() => setIsAdding(false)} />
        </div>
      )}
      {failureMessage(result) && <Notice>{failureMessage(result)}</Notice>}
      {secrets === null && !failureMessage(result) && <Skeleton />}
      {secrets?.length === 0 && !isAdding && (
        <Empty title="No secrets yet">
          <p>Add one here, or from a machine that can write here, with the value on stdin:</p>
          <CommandLine>{`baymutt set ${project.name} NAME < file`}</CommandLine>
          <p>
            For a value only you can fetch, an agent runs <Code>baymutt request</Code> and you paste
            it from the link it prints, or from Requests.
          </p>
        </Empty>
      )}
      {secrets !== null && secrets.length > 0 && (
        <Rows>
          {secrets.map(secret => (
            <SecretRow
              key={`${secret.name}:${secret.updatedAt}`}
              project={project}
              secret={secret}
            />
          ))}
        </Rows>
      )}
    </Section>
  );
};

const GrantRow = ({ project, grant }: { readonly project: Project; readonly grant: Grant }) => {
  const owner = useOwner();
  const [removing, remove] = useAtom(removeGrantAtom);
  const [setting, set] = useAtom(setGrantAtom);
  const isOwnerPaired = grant.endorsement !== null;
  const change = (next: { canRead: boolean; canWrite: boolean }) =>
    set({ owner, project, reader: grant, ...next });
  const isBusy = removing.waiting || setting.waiting;
  // Only changes that leave it some access: taking the last one away is Remove.
  const readChange = (() => {
    if (!grant.canRead) return 'Let it read';
    if (grant.canWrite) return 'Stop reading';
    return null;
  })();
  const writeChange = (() => {
    if (!grant.canWrite) return 'Let it write';
    if (grant.canRead) return 'Stop writing';
    return null;
  })();
  return (
    <Row>
      <div className="flex flex-col gap-x-4 gap-y-2 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{grant.credentialName}</p>
          <p className="mt-0.5 text-sm text-muted">
            can {grantWords(grant)}
            {!isOwnerPaired && ' · made by another machine, which handed this on'}
          </p>
        </div>
        <RowActions>
          {isOwnerPaired && readChange && (
            <Button
              size="sm"
              intent="subtle"
              disabled={isBusy}
              onClick={() => change({ canRead: !grant.canRead, canWrite: grant.canWrite })}
            >
              {readChange}
            </Button>
          )}
          {isOwnerPaired && writeChange && (
            <Button
              size="sm"
              intent="subtle"
              disabled={isBusy}
              onClick={() => change({ canRead: grant.canRead, canWrite: !grant.canWrite })}
            >
              {writeChange}
            </Button>
          )}
          <Button
            size="sm"
            intent="subtleDanger"
            disabled={isBusy}
            onClick={() => remove({ id: project.id, credentialId: grant.credentialId })}
          >
            {removing.waiting ? 'Removing…' : 'Remove'}
          </Button>
        </RowActions>
      </div>
      {(failureMessage(removing) ?? failureMessage(setting)) && (
        <Notice className="mt-2">{failureMessage(removing) ?? failureMessage(setting)}</Notice>
      )}
    </Row>
  );
};

const NewGrant = ({
  project,
  held,
}: {
  readonly project: Project;
  readonly held: ReadonlyArray<Grant>;
}) => {
  const owner = useOwner();
  const machines = latest(useAtomValue(machinesAtom)) ?? [];
  const [granting, grant] = useAtom(setGrantAtom, { mode: 'promiseExit' });
  const [machineId, setMachineId] = useState('');
  const [canRead, setCanRead] = useState(true);
  const [canWrite, setCanWrite] = useState(false);
  // Only a machine the owner paired: the vault vouches for its key, so the project key can be wrapped to it.
  const candidates = machines.filter(
    machine =>
      machine.endorsement !== null && !held.some(grant => grant.credentialId === machine.id),
  );
  const machine = candidates.find(({ id }) => id === machineId);
  // With no machine paired at all, the empty list above already says how to pair one.
  if (candidates.length === 0) {
    return held.length === 0 ? null : (
      <p className="mt-3 text-sm text-muted">
        Every machine you paired has access here. Pair another with <Code>baymutt pair</Code>.
      </p>
    );
  }
  return (
    <form
      className="mt-4 flex flex-wrap items-end gap-x-4 gap-y-3"
      onSubmit={async event => {
        event.preventDefault();
        if (machine === undefined) return;
        const exit = await grant({
          owner,
          project,
          reader: {
            credentialId: machine.id,
            credentialPublicKey: machine.publicKey,
            endorsement: machine.endorsement,
          },
          canRead,
          canWrite,
        });
        if (exit._tag === 'Success') setMachineId('');
      }}
    >
      <div className="w-full sm:w-64">
        <SelectField
          label="Give a machine access"
          value={machineId}
          onChange={event => setMachineId(event.target.value)}
        >
          <option value="">Choose a machine</option>
          {candidates.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </SelectField>
      </div>
      <fieldset className="flex h-9 items-center gap-4">
        <legend className="sr-only">What it may do</legend>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={canRead}
            onChange={event => setCanRead(event.target.checked)}
            className="size-4 accent-accent"
          />
          Read
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={canWrite}
            onChange={event => setCanWrite(event.target.checked)}
            className="size-4 accent-accent"
          />
          Write
        </label>
      </fieldset>
      <Button
        type="submit"
        disabled={machine === undefined || (!canRead && !canWrite) || granting.waiting}
      >
        {granting.waiting ? 'Granting…' : `Grant ${grantWords({ canRead, canWrite })}`}
      </Button>
      {failureMessage(granting) && (
        <Notice className="basis-full">{failureMessage(granting)}</Notice>
      )}
    </form>
  );
};

const Access = ({ project }: { readonly project: Project }) => {
  const grants = latest(useAtomValue(grantsAtom(project.id)));
  return (
    <Section
      title="Who can reach it"
      lede="You can always read and write. A machine that reads keeps what it read: taking access away stops the next load, not the last one."
    >
      {grants === null ? (
        <Skeleton rows={2} />
      ) : (
        <>
          {grants.length === 0 ? (
            <Empty title="No machine has access">
              <p>
                Pair a machine with <Code>baymutt pair</Code>, then grant it here, or let it ask.
                What it asks appears under Requests:
              </p>
              <CommandLine>{`baymutt access request ${project.name} --read --reason "…"`}</CommandLine>
            </Empty>
          ) : (
            <Rows>
              {grants.map(grant => (
                <GrantRow key={grant.credentialId} project={project} grant={grant} />
              ))}
            </Rows>
          )}
          <NewGrant project={project} held={grants} />
        </>
      )}
    </Section>
  );
};

const Archive = ({ project }: { readonly project: Project }) => {
  const navigate = useNavigate();
  const [archiving, archive] = useAtom(archiveProjectAtom, { mode: 'promiseExit' });
  return (
    <Section
      title="Archive"
      lede="Stops every load and write of this project. Its rows are kept, and its name stays taken."
      className="border-line border-t pt-8"
      action={
        <Confirm
          trigger={<Button intent="danger">Archive project</Button>}
          title={`Archive ${project.name}?`}
          keepLabel="Keep project"
          confirmLabel="Archive project"
          pendingLabel="Archiving…"
          isDangerous
          isPending={archiving.waiting}
          error={failureMessage(archiving)}
          onConfirm={async () => {
            const exit = await archive(project.id);
            if (exit._tag === 'Success') await navigate({ to: '/projects' });
          }}
        >
          <p>
            Anything that loads it will fail on its next run, deploys included. This cannot be
            undone from the dashboard.
          </p>
        </Confirm>
      }
    />
  );
};

export const ProjectPage = ({ id }: { readonly id: string }) => {
  const result = useAtomValue(projectAtom(id));
  const project = latest(result);
  if (project === null) {
    return failureMessage(result) ? (
      <>
        <Notice>{failureMessage(result)}</Notice>
        <p className="mt-4">
          <Link to="/projects" className="underline">
            Back to all projects
          </Link>
        </p>
      </>
    ) : (
      <Skeleton />
    );
  }
  return (
    <>
      <Link
        to="/projects"
        className="-ml-1 mb-3 inline-flex items-center gap-1 rounded-control px-1 text-sm text-muted transition-colors duration-150 ease-out hover:text-foreground"
      >
        <CaretLeftIcon aria-hidden="true" className="size-3.5" />
        Projects
      </Link>
      <PageHeader
        title={<Code className="text-xl font-[650] tracking-tight">{project.name}</Code>}
        lede={`Made by ${project.createdBy.name} on ${exactTime(project.createdAt)}.`}
      />
      <Secrets project={project} />
      <Access project={project} />
      <Archive project={project} />
    </>
  );
};
