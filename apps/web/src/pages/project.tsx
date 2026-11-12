import { type Grant, type Project, type Secret, SecretNameSchema } from '@baymutt/api';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { CaretLeftIcon } from '@phosphor-icons/react';
import { Link, useNavigate } from '@tanstack/react-router';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';
import * as Schema from 'effect/Schema';
import { useEffect, useState } from 'react';
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
import { TextArea, TextField } from '../components/ui/field.tsx';
import { copyWhenReady } from '../lib/clipboard.ts';
import {
  archiveProjectAtom,
  grantsAtom,
  isLogin,
  projectAtom,
  removeGrantAtom,
  removeSecretAtom,
  revealSecretAtom,
  rollbackSecretAtom,
  secretsAtom,
  versionsAtom,
  writeSecretAtom,
} from '../lib/data.ts';
import { bytes, counted, exactTime } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

const isSecretName = Schema.is(SecretNameSchema);

const SEALED_NOTE = 'Sealed in this browser to the project’s key: baymutt cannot read it.';

const OPEN_FAILED = 'Something went wrong on our side; try again.';

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

/**
 * The current value, masked. Reveal opens it in this browser and Copy copies it without showing
 * it; either is logged. Nothing keeps it: Hide, leaving the page and locking the vault drop it.
 */
const SecretValue = ({
  project,
  name,
  version,
}: {
  readonly project: Project;
  readonly name: string;
  readonly version: number;
}) => {
  const owner = useOwner();
  // The version is part of the slot, so a replaced value never shows under the new version.
  const slot = `${project.id}/${name}/${version}`;
  const [shown, reveal] = useAtom(revealSecretAtom(`${slot}:show`));
  const [copying, open] = useAtom(revealSecretAtom(`${slot}:copy`), { mode: 'promiseExit' });
  // A plain setter for resets: in `promiseExit` mode a reset would wait on a result that never comes.
  const forgetCopy = useAtomSet(revealSecretAtom(`${slot}:copy`));
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(
    () => () => {
      reveal(Atom.Reset);
      forgetCopy(Atom.Reset);
    },
    [reveal, forgetCopy],
  );
  const value = AsyncResult.isSuccess(shown) ? shown.value : null;
  const request = { owner, projectId: project.id, name, version };
  const revealLabel = value === null ? 'Reveal' : 'Hide';

  const copy = async () => {
    setCopied('idle');
    if (value !== null) {
      setCopied(await copyWhenReady(Promise.resolve(value)));
      return;
    }
    const opening = open(request);
    const text = opening.then(exit =>
      exit._tag === 'Success' ? exit.value : Promise.reject(exit.cause),
    );
    // The clipboard may refuse before the value arrives, and nothing else would hear this fail.
    text.catch(() => undefined);
    const outcome = await copyWhenReady(text);
    // A failure stays, to say why; a copied value goes.
    if ((await opening)._tag !== 'Success') return;
    forgetCopy(Atom.Reset);
    setCopied(outcome);
  };

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <pre className="max-h-48 min-w-0 flex-1 basis-60 overflow-auto whitespace-pre-wrap rounded-control border border-line bg-sunken px-3 py-1 font-mono text-sm [overflow-wrap:anywhere]">
          {value ?? (
            <>
              <span aria-hidden="true">••••••••••••</span>
              <span className="sr-only">Value hidden</span>
            </>
          )}
        </pre>
        <div className="-mx-2.5 flex gap-0.5 sm:mx-0">
          <Button
            size="sm"
            intent="subtle"
            aria-pressed={value !== null}
            disabled={shown.waiting}
            onClick={() => (value === null ? reveal(request) : reveal(Atom.Reset))}
          >
            {shown.waiting ? 'Revealing…' : revealLabel}
          </Button>
          <Button size="sm" intent="subtle" disabled={copying.waiting} onClick={copy}>
            {copied === 'copied' ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>
      <p aria-live="polite" className="sr-only">
        {copied === 'copied' ? `${name} copied` : ''}
      </p>
      {(failureMessage(shown, OPEN_FAILED) ?? failureMessage(copying, OPEN_FAILED)) && (
        <Notice className="mt-2">
          {failureMessage(shown, OPEN_FAILED) ?? failureMessage(copying, OPEN_FAILED)}
        </Notice>
      )}
      {copied === 'failed' && (
        <Notice className="mt-2">
          This browser refused the clipboard. Reveal it to select it.
        </Notice>
      )}
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
                Service accounts stop receiving it on their next load. Its versions are kept, so you
                can restore it from its history.
              </p>
            </Confirm>
          )}
        </RowActions>
      </div>
      {secret.currentVersion !== null && (
        <SecretValue project={project} name={secret.name} version={secret.currentVersion} />
      )}
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
      lede="Each value is sealed to the project’s key and masked here. Reveal and Copy open it in this browser, and Activity records each time."
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
          <p>
            Add one here, or from a service account that can write here, with the value on stdin:
          </p>
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
  const [removing, remove] = useAtom(removeGrantAtom);
  return (
    <Row>
      <div className="flex flex-col gap-x-4 gap-y-2 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{grant.credentialName}</p>
          <p className="mt-0.5 text-sm text-muted">
            can {grantWords(grant)}
            {isLogin(grant)
              ? ' · a CLI login, which holds every project'
              : ' · made by a login, which handed this on'}
          </p>
        </div>
        {/* A login holds every project: revoking it, under Service accounts, is the way to end that. */}
        {!isLogin(grant) && (
          <RowActions>
            <Button
              size="sm"
              intent="subtleDanger"
              disabled={removing.waiting}
              onClick={() => remove({ id: project.id, credentialId: grant.credentialId })}
            >
              {removing.waiting ? 'Removing…' : 'Remove'}
            </Button>
          </RowActions>
        )}
      </div>
      {failureMessage(removing) && <Notice className="mt-2">{failureMessage(removing)}</Notice>}
    </Row>
  );
};

const Access = ({ project }: { readonly project: Project }) => {
  const grants = latest(useAtomValue(grantsAtom(project.id)));
  return (
    <Section
      title="Who can reach it"
      lede="You and every CLI login can read and write it. A service account a login made reaches it only if its maker handed it on. One that reads keeps what it read: taking access away stops the next load, not the last one."
    >
      {grants === null && <Skeleton rows={2} />}
      {grants?.length === 0 && (
        <Empty title="Only you, so far">
          <p>
            Run <Code>baymutt login</Code> and approve it here: a login reads and writes every
            project.
          </p>
        </Empty>
      )}
      {grants !== null && grants.length > 0 && (
        <Rows>
          {grants.map(grant => (
            <GrantRow key={grant.credentialId} project={project} grant={grant} />
          ))}
        </Rows>
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
