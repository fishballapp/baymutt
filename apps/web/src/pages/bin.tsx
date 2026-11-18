import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import * as Atom from 'effect/reactivity/Atom';
import { type ReactNode, useState } from 'react';
import { useOwner } from '../components/gate.tsx';
import { useOrg } from '../components/org-scope.tsx';
import { useTitle } from '../components/shell.tsx';
import { Button } from '../components/ui/button.tsx';
import { Confirm } from '../components/ui/dialog.tsx';
import { Filter, NoMatch, useFilter } from '../components/ui/filter.tsx';
import { EmptyState, List, Notice, Row, Rows, Skeleton, Status } from '../components/ui/list.tsx';
import { RowMenu } from '../components/ui/menu.tsx';
import { PageHead, PageTitle, RelativeTime } from '../components/ui/page.tsx';
import { Address, Code, SealedName } from '../components/ui/text.tsx';
import {
  addressOf,
  binAtom,
  NAME_NOT_OPENED,
  type OpenedBinEnvironment,
  type OpenedBinSecret,
  purgeEnvironmentAtom,
  purgeSecretAtom,
  restoreEnvironmentAtom,
  restoreSecretAtom,
} from '../lib/data.ts';
import { DAY_MS, removedForGoodWords } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

/**
 * One thing in the bin: its name, when it goes for good (in `warn` under a day) over when it was
 * deleted, Restore, and Delete for good in its `⋯`.
 */
const BinRow = ({
  name,
  menuLabel,
  purgeAt,
  deleted,
  restore,
  purge,
}: {
  readonly name: ReactNode;
  /** What the `⋯` names it: its address or name, or "this secret" when that does not open. */
  readonly menuLabel: string;
  readonly purgeAt: number;
  readonly deleted: ReactNode;
  readonly restore: {
    readonly onClick: () => void;
    readonly isPending: boolean;
    readonly error: string | null;
  };
  readonly purge: {
    readonly title: ReactNode;
    readonly body: string;
    readonly onConfirm: () => Promise<boolean>;
    readonly isPending: boolean;
    readonly error: string | null;
    /** Clears an earlier failure: called each time its dialog opens. */
    readonly forget: () => void;
  };
}) => {
  const [isConfirming, setConfirming] = useState(false);
  return (
    <Row variant="row-bin" error={restore.error}>
      <span>{name}</span>
      <Status
        status={
          <RelativeTime at={purgeAt}>{() => removedForGoodWords(purgeAt, Date.now())}</RelativeTime>
        }
        isWarn={purgeAt - Date.now() < DAY_MS}
        fact={deleted}
      />
      <Button
        kind="quiet"
        isPending={restore.isPending}
        pendingLabel="Restoring…"
        onClick={restore.onClick}
      >
        Restore
      </Button>
      <RowMenu
        label={`${menuLabel}: delete for good`}
        items={[{ label: 'Delete for good', onClick: () => setConfirming(true), isDanger: true }]}
      />
      <Confirm
        open={isConfirming}
        onOpenChange={setConfirming}
        onOpen={purge.forget}
        title={purge.title}
        keepLabel="Keep it"
        confirmLabel="Delete for good"
        pendingLabel="Deleting…"
        isPending={purge.isPending}
        error={purge.error}
        onConfirm={async () => {
          if (await purge.onConfirm()) setConfirming(false);
        }}
      >
        <p>{purge.body} This cannot be undone.</p>
      </Confirm>
    </Row>
  );
};

const EnvironmentRow = ({ environment }: { readonly environment: OpenedBinEnvironment }) => {
  const [restoring, restore] = useAtom(restoreEnvironmentAtom(environment.id));
  const [purging, purge] = useAtom(purgeEnvironmentAtom(environment.id), {
    mode: 'promiseExit',
  });
  const forgetPurge = useAtomSet(purgeEnvironmentAtom(environment.id));
  const address = <Address orgSlug={environment.orgSlug} name={environment.openedName} />;
  return (
    <BinRow
      name={address}
      menuLabel={
        environment.openedName === null
          ? 'this environment'
          : addressOf({ orgSlug: environment.orgSlug, name: environment.openedName })
      }
      purgeAt={environment.purgeAt}
      deleted={<RelativeTime at={environment.deletedAt}>{ago => `deleted ${ago}`}</RelativeTime>}
      restore={{
        onClick: () => restore(environment.id),
        isPending: restoring.waiting,
        error: failureMessage(restoring),
      }}
      purge={{
        title:
          environment.openedName === null ? (
            'Delete this environment for good?'
          ) : (
            <>Delete {address} for good?</>
          ),
        body: 'Its secrets, every version of each, and who could reach it are removed from baymutt.',
        onConfirm: async () => (await purge(environment.id))._tag === 'Success',
        isPending: purging.waiting,
        error: failureMessage(purging),
        forget: () => forgetPurge(Atom.Reset),
      }}
    />
  );
};

const SecretRow = ({ secret }: { readonly secret: OpenedBinSecret }) => {
  const slot = `${secret.environmentId}/${secret.name}`;
  const [restoring, restore] = useAtom(restoreSecretAtom(slot));
  const [purging, purge] = useAtom(purgeSecretAtom(slot), { mode: 'promiseExit' });
  const forgetPurge = useAtomSet(purgeSecretAtom(slot));
  const key = { environmentId: secret.environmentId, name: secret.name };
  return (
    <BinRow
      name={
        <>
          <SealedName name={secret.openedName} /> in{' '}
          <Address orgSlug={secret.orgSlug} name={secret.openedEnvironmentName} />
        </>
      }
      menuLabel={secret.openedName ?? 'this secret'}
      purgeAt={secret.purgeAt}
      deleted={
        <RelativeTime at={secret.deletedAt}>
          {ago => `deleted by ${secret.deletedBy.name} ${ago}`}
        </RelativeTime>
      }
      restore={{
        onClick: () => restore({ ...key, version: secret.latestVersion }),
        isPending: restoring.waiting,
        error: failureMessage(restoring),
      }}
      purge={{
        title:
          secret.openedName === null ? (
            'Delete this secret for good?'
          ) : (
            <>
              Delete <Code>{secret.openedName}</Code> for good?
            </>
          ),
        body: 'Every version of it is removed from baymutt.',
        onConfirm: async () => (await purge(key))._tag === 'Success',
        forget: () => forgetPurge(Atom.Reset),
        isPending: purging.waiting,
        error: failureMessage(purging),
      }}
    />
  );
};

export const BinPage = () => {
  const org = useOrg();
  useTitle('Bin', org.name);
  const result = useAtomValue(binAtom(useOwner()));
  const failure = failureMessage(result);
  const all = latest(result);
  const environments = (all?.environments ?? []).filter(
    environment => environment.orgId === org.id,
  );
  const secrets = (all?.secrets ?? []).filter(secret => secret.orgId === org.id);
  const filter = useFilter(environments.length + secrets.length);
  const soonestFirst = (a: { readonly purgeAt: number }, b: { readonly purgeAt: number }) =>
    a.purgeAt - b.purgeAt;
  const shownEnvironments = environments
    .filter(environment =>
      filter.matches(addressOf({ orgSlug: environment.orgSlug, name: environment.openedName })),
    )
    .toSorted(soonestFirst);
  const shownSecrets = secrets
    .filter(secret =>
      filter.matches(
        secret.openedName ?? NAME_NOT_OPENED,
        addressOf({ orgSlug: secret.orgSlug, name: secret.openedEnvironmentName }),
      ),
    )
    .toSorted(soonestFirst);
  const count = (rows: number) => (filter.isFiltering ? undefined : rows);
  const body = (() => {
    if (failure !== null) return <Notice tone="danger">{failure}</Notice>;
    if (all === null) return <Skeleton />;
    if (environments.length + secrets.length === 0) {
      return (
        <EmptyState>
          What you delete in {org.name} stays here for 30 days, and can be restored until then.
        </EmptyState>
      );
    }
    if (shownEnvironments.length + shownSecrets.length === 0) {
      return <NoMatch filter={filter}>Nothing in the bin matches “{filter.query.trim()}”.</NoMatch>;
    }
    return (
      <>
        {shownEnvironments.length > 0 && (
          <List title="Environments" count={count(shownEnvironments.length)}>
            <Rows>
              {shownEnvironments.map(environment => (
                <EnvironmentRow key={environment.id} environment={environment} />
              ))}
            </Rows>
          </List>
        )}
        {shownSecrets.length > 0 && (
          <List title="Secrets" count={count(shownSecrets.length)}>
            <Rows>
              {shownSecrets.map(secret => (
                <SecretRow key={`${secret.environmentId}/${secret.name}`} secret={secret} />
              ))}
            </Rows>
          </List>
        )}
      </>
    );
  })();
  return (
    <>
      <PageHead
        title={<PageTitle>Bin</PageTitle>}
        filter={filter.isShown && <Filter filter={filter} placeholder="name" />}
      />
      {body}
    </>
  );
};
