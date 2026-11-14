import type { BinEnvironment, BinSecret } from '@baymutt/api';
import { useAtom, useAtomValue } from '@effect/atom-react';
import type { ReactNode } from 'react';
import { usePickedOrg } from '../components/orgs.tsx';
import {
  Code,
  Empty,
  Notice,
  PageHeader,
  Row,
  RowActions,
  Rows,
  Section,
  Skeleton,
  Time,
} from '../components/parts.tsx';
import { Button } from '../components/ui/button.tsx';
import { Confirm } from '../components/ui/confirm.tsx';
import {
  addressOf,
  binAtom,
  purgeEnvironmentAtom,
  purgeSecretAtom,
  restoreEnvironmentAtom,
  restoreSecretAtom,
} from '../lib/data.ts';
import { exactDay, exactTime } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

/** When it goes for good: a day, with the exact time on hover. */
const GoesOn = ({ at }: { readonly at: number }) => (
  <time dateTime={Temporal.Instant.fromEpochMilliseconds(at).toString()} title={exactTime(at)}>
    {exactDay(at)}
  </time>
);

/** One thing in the bin: what it is, when it was deleted and goes, and its two actions. */
const BinRow = ({
  name,
  deleted,
  purgeAt,
  restore,
  purge,
}: {
  readonly name: ReactNode;
  readonly deleted: ReactNode;
  readonly purgeAt: number;
  readonly restore: {
    readonly onClick: () => void;
    readonly waiting: boolean;
    readonly error: string | null;
  };
  readonly purge: {
    readonly title: string;
    readonly body: string;
    readonly onConfirm: () => void;
    readonly waiting: boolean;
    readonly error: string | null;
  };
}) => (
  <Row>
    <div className="flex flex-col gap-x-4 gap-y-2 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        {name}
        <p className="mt-0.5 text-sm text-muted">
          {deleted} · removed for good on <GoesOn at={purgeAt} />
        </p>
      </div>
      <RowActions>
        <Button size="sm" intent="subtle" disabled={restore.waiting} onClick={restore.onClick}>
          {restore.waiting ? 'Restoring…' : 'Restore'}
        </Button>
        <Confirm
          trigger={
            <Button size="sm" intent="subtleDanger">
              Delete for good
            </Button>
          }
          title={purge.title}
          keepLabel="Keep it"
          confirmLabel="Delete for good"
          pendingLabel="Deleting…"
          isDangerous
          isPending={purge.waiting}
          error={purge.error}
          onConfirm={purge.onConfirm}
        >
          <p>{purge.body} This cannot be undone.</p>
        </Confirm>
      </RowActions>
    </div>
    {restore.error && <Notice className="mt-2">{restore.error}</Notice>}
  </Row>
);

const EnvironmentRow = ({ environment }: { readonly environment: BinEnvironment }) => {
  const [restoring, restore] = useAtom(restoreEnvironmentAtom(environment.id));
  const [purging, purge] = useAtom(purgeEnvironmentAtom(environment.id));
  return (
    <BinRow
      name={<Code className="text-base font-medium">{addressOf(environment)}</Code>}
      deleted={
        <>
          deleted <Time at={environment.deletedAt} />
        </>
      }
      purgeAt={environment.purgeAt}
      restore={{
        onClick: () => restore(environment.id),
        waiting: restoring.waiting,
        error: failureMessage(restoring),
      }}
      purge={{
        title: `Delete ${addressOf(environment)} for good?`,
        body: 'Its secrets, every version of each, and who could reach it are removed from baymutt.',
        onConfirm: () => purge(environment.id),
        waiting: purging.waiting,
        error: failureMessage(purging),
      }}
    />
  );
};

const SecretRow = ({ secret }: { readonly secret: BinSecret }) => {
  const slot = `${secret.environmentId}/${secret.name}`;
  const [restoring, restore] = useAtom(restoreSecretAtom(slot));
  const [purging, purge] = useAtom(purgeSecretAtom(slot));
  const key = { environmentId: secret.environmentId, name: secret.name };
  return (
    <BinRow
      name={
        <p>
          <Code className="text-base font-medium">{secret.name}</Code>{' '}
          <span className="text-muted">in</span>{' '}
          <Code>{addressOf({ orgSlug: secret.orgSlug, name: secret.environmentName })}</Code>
        </p>
      }
      deleted={
        <>
          deleted by {secret.deletedBy.name}, <Time at={secret.deletedAt} />
        </>
      }
      purgeAt={secret.purgeAt}
      restore={{
        onClick: () => restore({ ...key, version: secret.latestVersion }),
        waiting: restoring.waiting,
        error: failureMessage(restoring),
      }}
      purge={{
        title: `Delete ${secret.name} for good?`,
        body: `Every version of it is removed from baymutt.`,
        onConfirm: () => purge(key),
        waiting: purging.waiting,
        error: failureMessage(purging),
      }}
    />
  );
};

export const BinPage = () => {
  const result = useAtomValue(binAtom);
  const { org } = usePickedOrg();
  const all = latest(result);
  const bin =
    all === null || org === null
      ? null
      : {
          environments: all.environments.filter(environment => environment.orgId === org.id),
          secrets: all.secrets.filter(secret => secret.orgId === org.id),
        };
  const failure = failureMessage(result);
  const isEmpty = bin !== null && bin.environments.length === 0 && bin.secrets.length === 0;
  return (
    <>
      <PageHeader
        title="Bin"
        lede={`Deleted environments and secrets${org === null ? '' : ` of ${org.name}`}. Each can be restored for 30 days, then it is removed for good.`}
      />
      {failure && <Notice className="mb-6">{failure}</Notice>}
      {bin === null && !failure && <Skeleton rows={2} />}
      {isEmpty && (
        <Empty title="The bin is empty">
          <p>An environment or secret you or a CLI login deletes stays here for 30 days.</p>
        </Empty>
      )}
      {bin !== null && bin.environments.length > 0 && (
        <Section title="Environments">
          <Rows>
            {bin.environments.map(environment => (
              <EnvironmentRow key={environment.id} environment={environment} />
            ))}
          </Rows>
        </Section>
      )}
      {bin !== null && bin.secrets.length > 0 && (
        <Section title="Secrets">
          <Rows>
            {bin.secrets.map(secret => (
              <SecretRow key={`${secret.environmentId}/${secret.name}`} secret={secret} />
            ))}
          </Rows>
        </Section>
      )}
    </>
  );
};
