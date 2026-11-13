import type { Environment, ServiceAccount } from '@baymutt/api';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { RobotIcon, TerminalWindowIcon } from '@phosphor-icons/react';
import * as Atom from 'effect/reactivity/Atom';
import { useState } from 'react';
import { ExpiryField, expiryLabel } from '../components/expiry.tsx';
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
  Skeleton,
  Tag,
  Time,
} from '../components/parts.tsx';
import { Button } from '../components/ui/button.tsx';
import { Confirm } from '../components/ui/confirm.tsx';
import {
  type AccessChange,
  changeAccessAtom,
  environmentsAtom,
  isLogin,
  isVouched,
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

type Held = { readonly canRead: boolean; readonly canWrite: boolean };

const heldOn = (serviceAccount: ServiceAccount, environmentId: string): Held => {
  const grant = serviceAccount.grants.find(held => held.environmentId === environmentId);
  return { canRead: grant?.canRead ?? false, canWrite: grant?.canWrite ?? false };
};

const AccessBox = ({
  label,
  checked,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}) => (
  <label className="flex items-center gap-1.5 text-sm text-foreground has-disabled:text-muted">
    <input
      type="checkbox"
      className="size-4 shrink-0 accent-accent"
      checked={checked}
      disabled={disabled}
      onChange={event => onChange(event.target.checked)}
    />
    {label}
  </label>
);

/**
 * What a scoped service account can reach, changed here under the key it already has. A read or
 * an environment it gains needs its key as its maker vouched for it; one made by a CLI before 0.4.0 has
 * no such voucher, so it can only lose access, and gain write on an environment it holds.
 */
const ChangeAccess = ({
  serviceAccount,
  maker,
}: {
  readonly serviceAccount: ServiceAccount;
  readonly maker: ServiceAccount | undefined;
}) => {
  const owner = useOwner();
  const environments = latest(useAtomValue(environmentsAtom)) ?? [];
  const [saving, save] = useAtom(changeAccessAtom, { mode: 'promiseExit' });
  // One atom serves every row, so an earlier row's failure is cleared when this dialog opens.
  const forget = useAtomSet(changeAccessAtom);
  const [isOpen, setIsOpen] = useState(false);
  const [chosen, setChosen] = useState<Readonly<Record<string, Held>>>({});
  const vouched = isVouched(serviceAccount) && maker !== undefined;
  const accessOn = (environment: Environment) =>
    chosen[environment.id] ?? heldOn(serviceAccount, environment.id);
  const changes: ReadonlyArray<AccessChange> = environments.flatMap(environment => {
    const before = heldOn(serviceAccount, environment.id);
    const after = accessOn(environment);
    return before.canRead === after.canRead && before.canWrite === after.canWrite
      ? []
      : [{ environmentId: environment.id, ...after }];
  });
  return (
    <Confirm
      open={isOpen}
      onOpenChange={open => {
        setIsOpen(open);
        if (open) {
          setChosen({});
          forget(Atom.Reset);
        }
      }}
      trigger={
        <Button size="sm" intent="subtle">
          Access
        </Button>
      }
      title={`What can ${serviceAccount.name} reach?`}
      confirmLabel="Save access"
      pendingLabel="Saving…"
      isPending={saving.waiting}
      error={failureMessage(
        saving,
        'Something went wrong. The list behind shows what it holds now; try again.',
      )}
      onConfirm={async () => {
        if (maker === undefined || changes.length === 0) return setIsOpen(false);
        const exit = await save({ owner, serviceAccount, maker, changes });
        if (exit._tag === 'Success') setIsOpen(false);
      }}
    >
      <ul className="max-h-72 divide-y divide-line overflow-y-auto border-line border-y">
        {environments.map(environment => {
          const before = heldOn(serviceAccount, environment.id);
          const after = accessOn(environment);
          const set = (next: Held) =>
            setChosen(current => ({ ...current, [environment.id]: next }));
          return (
            <li key={environment.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
              <Code className="min-w-0 flex-1 [overflow-wrap:anywhere]">{environment.name}</Code>
              <AccessBox
                label="read"
                checked={after.canRead}
                disabled={!vouched && !before.canRead}
                onChange={canRead => set({ ...after, canRead })}
              />
              <AccessBox
                label="write"
                checked={after.canWrite}
                disabled={!vouched && !before.canRead && !before.canWrite}
                onChange={canWrite => set({ ...after, canWrite })}
              />
            </li>
          );
        })}
      </ul>
      {vouched ? (
        <p>A read wraps the environment key to it. What it reads cannot be unread.</p>
      ) : (
        <p>
          A CLI before 0.4.0 made it, so nothing vouches for its key: it can lose access here, and
          gain only write on an environment it holds.
        </p>
      )}
    </Confirm>
  );
};

/** What it can reach: every environment for a login, what it was handed for any other. */
const Reach = ({ serviceAccount }: { readonly serviceAccount: ServiceAccount }) => {
  if (isLogin(serviceAccount)) {
    return (
      <p className="mt-2 text-sm">
        <span className="text-muted">can read + write</span> every environment
      </p>
    );
  }
  if (serviceAccount.grants.length === 0) {
    return <p className="mt-2 text-sm text-muted">No access to any environment.</p>;
  }
  return (
    <ul className="mt-2 space-y-0.5 text-sm">
      {serviceAccount.grants.map(grant => (
        <li key={grant.environmentId}>
          <span className="text-muted">can {grantWords(grant)}</span>{' '}
          <Code>{grant.environmentName}</Code>
        </li>
      ))}
    </ul>
  );
};

const ServiceAccountRow = ({
  serviceAccount,
  maker,
  made,
}: {
  readonly serviceAccount: ServiceAccount;
  readonly maker: ServiceAccount | undefined;
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
            {maker !== undefined && `${maker.name} `}
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
          {!isLogin(serviceAccount) && (
            <ChangeAccess serviceAccount={serviceAccount} maker={maker} />
          )}
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
        lede="Each has its own key that the CLI acts as. A CLI login reads and writes every environment; a service account a login made reaches only what it was handed, by that login or by you."
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
            login can then read and write every environment, and make service accounts that hold
            part of its access.
          </p>
        </Empty>
      )}
      {serviceAccounts !== null && serviceAccounts.length > 0 && (
        <Rows>
          {serviceAccounts.map(serviceAccount => (
            <ServiceAccountRow
              key={serviceAccount.id}
              serviceAccount={serviceAccount}
              maker={serviceAccounts.find(({ id }) => id === serviceAccount.parentId)}
              made={serviceAccounts.filter(({ parentId }) => parentId === serviceAccount.id).length}
            />
          ))}
        </Rows>
      )}
    </>
  );
};
