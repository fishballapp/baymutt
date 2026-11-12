import type { ServiceAccount } from '@baymutt/api';
import { useAtom, useAtomValue } from '@effect/atom-react';
import { RobotIcon, TerminalWindowIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { ExpiryField, expiryLabel } from '../components/expiry.tsx';
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
  Skeleton,
  Tag,
  Time,
} from '../components/parts.tsx';
import { Button } from '../components/ui/button.tsx';
import { Confirm } from '../components/ui/confirm.tsx';
import {
  isLogin,
  revokeServiceAccountAtom,
  serviceAccountsAtom,
  setExpiryAtom,
} from '../lib/data.ts';
import { counted, expiryWords } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

/** A login and a scoped service account are told apart by a glyph and a word, never by colour. */
export const KindIcon = ({ serviceAccount }: { readonly serviceAccount: ServiceAccount }) => {
  const Icon = isLogin(serviceAccount) ? TerminalWindowIcon : RobotIcon;
  return (
    <Icon
      role="img"
      aria-label={isLogin(serviceAccount) ? 'CLI login' : 'Service account'}
      weight="regular"
      className="mt-0.5 size-5 shrink-0 text-muted"
    />
  );
};

const ChangeExpiry = ({ serviceAccount }: { readonly serviceAccount: ServiceAccount }) => {
  const [saving, save] = useAtom(setExpiryAtom, { mode: 'promiseExit' });
  const [isOpen, setIsOpen] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null | undefined>(serviceAccount.expiresAt);
  return (
    <Confirm
      open={isOpen}
      onOpenChange={open => {
        setIsOpen(open);
        if (open) setExpiresAt(serviceAccount.expiresAt);
      }}
      trigger={
        <Button size="sm" intent="subtle">
          Expiry
        </Button>
      }
      title={`When should ${serviceAccount.name} expire?`}
      confirmLabel="Save expiry"
      pendingLabel="Saving…"
      isPending={saving.waiting}
      error={failureMessage(saving)}
      onConfirm={async () => {
        if (expiresAt === undefined) return;
        const exit = await save({ id: serviceAccount.id, expiresAt });
        if (exit._tag === 'Success') setIsOpen(false);
      }}
    >
      <ExpiryField
        kept={serviceAccount.expiresAt}
        keptLabel={at => `${at <= Date.now() ? 'Expired' : 'Unchanged'}: ${expiryLabel(at)}`}
        onChange={setExpiresAt}
      />
      <p>
        Once it expires its key stops working
        {isLogin(serviceAccount) && ', and so do the service accounts it made'}. A later date
        revives it. What it already read stays read.
      </p>
    </Confirm>
  );
};

/** What it can reach: every project for a login, what it was handed for any other. */
const Reach = ({ serviceAccount }: { readonly serviceAccount: ServiceAccount }) => {
  if (isLogin(serviceAccount)) {
    return (
      <p className="mt-2 text-sm">
        <span className="text-muted">can read + write</span> every project
      </p>
    );
  }
  if (serviceAccount.grants.length === 0) {
    return <p className="mt-2 text-sm text-muted">No access to any project.</p>;
  }
  return (
    <ul className="mt-2 space-y-0.5 text-sm">
      {serviceAccount.grants.map(grant => (
        <li key={grant.projectId}>
          <span className="text-muted">can {grantWords(grant)}</span>{' '}
          <Code>{grant.projectName}</Code>
        </li>
      ))}
    </ul>
  );
};

const ServiceAccountRow = ({
  serviceAccount,
  madeBy,
  made,
}: {
  readonly serviceAccount: ServiceAccount;
  readonly madeBy: string | undefined;
  readonly made: number;
}) => {
  const [revoking, revoke] = useAtom(revokeServiceAccountAtom, { mode: 'promiseExit' });
  const [isConfirming, setIsConfirming] = useState(false);
  return (
    <Row>
      <div className="flex flex-col gap-x-4 gap-y-2 sm:flex-row sm:items-start">
        <KindIcon serviceAccount={serviceAccount} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{serviceAccount.name}</span>
            {serviceAccount.expiresAt !== null && (
              <Tag tone={serviceAccount.expiresAt <= Date.now() ? 'warn' : 'plain'}>
                {expiryWords(serviceAccount.expiresAt, Date.now())}
              </Tag>
            )}
          </p>
          {serviceAccount.description !== null && (
            <p className="mt-0.5 text-sm [overflow-wrap:anywhere]">{serviceAccount.description}</p>
          )}
          <p className="mt-0.5 text-sm text-muted">
            {isLogin(serviceAccount) ? 'CLI login, approved' : 'Service account, made by'}{' '}
            {madeBy !== undefined && `${madeBy} `}
            <Time at={serviceAccount.createdAt} /> ·{' '}
            {serviceAccount.lastUsedAt === null ? (
              'never used'
            ) : (
              <>
                last used <Time at={serviceAccount.lastUsedAt} />
              </>
            )}
          </p>
          <Reach serviceAccount={serviceAccount} />
        </div>
        <RowActions>
          <ChangeExpiry serviceAccount={serviceAccount} />
          <Confirm
            open={isConfirming}
            onOpenChange={setIsConfirming}
            trigger={
              <Button size="sm" intent="subtleDanger">
                Revoke
              </Button>
            }
            title={`Revoke ${serviceAccount.name}?`}
            keepLabel="Keep service account"
            confirmLabel="Revoke service account"
            pendingLabel="Revoking…"
            isDangerous
            isPending={revoking.waiting}
            error={failureMessage(revoking)}
            onConfirm={async () => {
              const exit = await revoke(serviceAccount.id);
              if (exit._tag === 'Success') setIsConfirming(false);
            }}
          >
            <p>
              Its key stops working at once
              {made > 0 && `, and so do the ${counted(made, 'service account')} it made`}.
            </p>
            <p>
              What it already read stays read. If the key may have leaked, replace those values at
              their vendors too.
            </p>
          </Confirm>
        </RowActions>
      </div>
    </Row>
  );
};

export const ServiceAccountsPage = () => {
  const result = useAtomValue(serviceAccountsAtom);
  const serviceAccounts = latest(result);
  return (
    <>
      <PageHeader
        title="Service accounts"
        lede="Each has its own key that the CLI acts as. A CLI login reads and writes every project; a service account a login made reaches only what its maker handed on."
      />
      {failureMessage(result) && <Notice>{failureMessage(result)}</Notice>}
      {serviceAccounts === null && !failureMessage(result) && <Skeleton />}
      {serviceAccounts?.length === 0 && (
        <Empty title="No service accounts yet">
          <p>Install the CLI and log in:</p>
          <CommandLine>npm install -g baymutt</CommandLine>
          <CommandLine>baymutt login</CommandLine>
          <p>
            It prints a link and a code. Open the link here and approve it if the codes match. The
            login can then read and write every project, and make service accounts that hold part of
            its access.
          </p>
        </Empty>
      )}
      {serviceAccounts !== null && serviceAccounts.length > 0 && (
        <Rows>
          {serviceAccounts.map(serviceAccount => (
            <ServiceAccountRow
              key={serviceAccount.id}
              serviceAccount={serviceAccount}
              madeBy={serviceAccounts.find(({ id }) => id === serviceAccount.parentId)?.name}
              made={serviceAccounts.filter(({ parentId }) => parentId === serviceAccount.id).length}
            />
          ))}
        </Rows>
      )}
    </>
  );
};
