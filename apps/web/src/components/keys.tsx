// A key as a row, wherever keys are listed: an org's Keys page, and the CLI logins under Account.
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { ChatCircleDotsIcon, RobotIcon, TerminalWindowIcon } from '@phosphor-icons/react';
import * as Atom from 'effect/reactivity/Atom';
import { useState } from 'react';
import {
  type AccessChange,
  addressOf,
  changeAccessAtom,
  environmentsAtom,
  hasEnded,
  isLogin,
  isVouched,
  kindOf,
  type OpenedEnvironment,
  type OpenedServiceAccount,
  revokeServiceAccountAtom,
  setExpiryAtom,
} from '../lib/data.ts';
import { counted, expiryWords } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';
import { ExpiryField, expiryLabel } from './expiry.tsx';
import { useOwner } from './gate.tsx';
import { Code, grantWords, Row, RowActions, Rows, Tag, Time } from './parts.tsx';
import { Button } from './ui/button.tsx';
import { Confirm } from './ui/confirm.tsx';

const KINDS = {
  login: { Icon: TerminalWindowIcon, label: 'CLI login' },
  'service-account': { Icon: RobotIcon, label: 'Service account' },
  agent: { Icon: ChatCircleDotsIcon, label: 'Agent key' },
} as const;

/** A CLI login, a service account and an agent key are told apart by a glyph and a word, never by colour. */
const KindIcon = ({ serviceAccount }: { readonly serviceAccount: OpenedServiceAccount }) => {
  const { Icon, label } = KINDS[kindOf(serviceAccount)];
  return (
    <Icon
      role="img"
      aria-label={label}
      weight="regular"
      className="mt-0.5 size-5 shrink-0 text-muted"
    />
  );
};

const ChangeExpiry = ({ serviceAccount }: { readonly serviceAccount: OpenedServiceAccount }) => {
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
        {isLogin(serviceAccount) && ', and so do the keys it asked for'}. A later date revives it.
        What it already read stays read.
      </p>
    </Confirm>
  );
};

type Held = { readonly canRead: boolean; readonly canWrite: boolean };

const heldOn = (serviceAccount: OpenedServiceAccount, environmentId: string): Held => {
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
 * What a service account can reach, changed here under the key it already has. A read or an
 * environment it gains needs its key as its CLI login vouched for it; one made by a CLI before
 * 0.4.0 has no such voucher, so it can only lose access, and gain write on an environment it holds.
 */
const ChangeAccess = ({
  serviceAccount,
  maker,
}: {
  readonly serviceAccount: OpenedServiceAccount;
  readonly maker: OpenedServiceAccount | undefined;
}) => {
  const owner = useOwner();
  // A key belongs to one org and holds environments of that org only.
  const environments = (latest(useAtomValue(environmentsAtom(owner))) ?? []).filter(
    environment => environment.orgId === serviceAccount.org?.id,
  );
  const [saving, save] = useAtom(changeAccessAtom, { mode: 'promiseExit' });
  // One atom serves every row, so an earlier row's failure is cleared when this dialog opens.
  const forget = useAtomSet(changeAccessAtom);
  const [isOpen, setIsOpen] = useState(false);
  const [chosen, setChosen] = useState<Readonly<Record<string, Held>>>({});
  const vouched = isVouched(serviceAccount) && maker !== undefined;
  const accessOn = (environment: OpenedEnvironment) =>
    chosen[environment.id] ?? heldOn(serviceAccount, environment.id);
  const changes: ReadonlyArray<AccessChange> = environments.flatMap(environment => {
    const before = heldOn(serviceAccount, environment.id);
    const after = accessOn(environment);
    return before.canRead === after.canRead && before.canWrite === after.canWrite
      ? []
      : [{ environmentId: environment.id, orgId: environment.orgId, ...after }];
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
              <Code className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {addressOf({ orgSlug: environment.orgSlug, name: environment.openedName })}
              </Code>
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

/** What it can reach: the names alone for a login, the environments it holds for any other. */
const Reach = ({ serviceAccount }: { readonly serviceAccount: OpenedServiceAccount }) => {
  if (isLogin(serviceAccount)) {
    return (
      <p className="mt-2 text-sm">
        <span className="text-muted">lists</span> the names in your orgs{' '}
        <span className="text-muted">and opens no value</span>
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
          <Code>{addressOf({ orgSlug: grant.orgSlug, name: grant.openedEnvironmentName })}</Code>
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
  readonly serviceAccount: OpenedServiceAccount;
  readonly maker: OpenedServiceAccount | undefined;
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
            <Tag tone={hasEnded(serviceAccount, Date.now()) ? 'warn' : 'plain'}>
              {expiryWords(serviceAccount.expiresAt, Date.now())}
            </Tag>
          </p>
          {serviceAccount.description !== null && (
            <p className="mt-0.5 text-sm [overflow-wrap:anywhere]">{serviceAccount.description}</p>
          )}
          <p className="mt-0.5 text-sm text-muted">
            {isLogin(serviceAccount) ? 'CLI login, approved' : 'Asked for'}{' '}
            {maker !== undefined && `by ${maker.name} `}
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
            keepLabel="Keep key"
            confirmLabel="Revoke key"
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
              {made > 0 && `, and so do the ${counted(made, 'key')} it asked for`}.
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

/**
 * Keys as rows, newest first. `all` is every key of the account, which names each key's maker and
 * counts the keys a CLI login asked for.
 */
export const KeyRows = ({
  keys,
  all,
}: {
  readonly keys: ReadonlyArray<OpenedServiceAccount>;
  readonly all: ReadonlyArray<OpenedServiceAccount>;
}) => (
  <Rows>
    {keys
      .toSorted((a, b) => b.createdAt - a.createdAt)
      .map(serviceAccount => (
        <ServiceAccountRow
          key={serviceAccount.id}
          serviceAccount={serviceAccount}
          maker={all.find(({ id }) => id === serviceAccount.parentId)}
          made={all.filter(({ parentId }) => parentId === serviceAccount.id).length}
        />
      ))}
  </Rows>
);

/** Keys that have ended stay out of sight until asked for: they are listed until the nightly sweep revokes them. */
export const useEndedShown = (keys: ReadonlyArray<OpenedServiceAccount> | null) => {
  const [isShowingEnded, setIsShowingEnded] = useState(false);
  const now = Date.now();
  const ended = keys?.filter(key => hasEnded(key, now)) ?? [];
  return {
    shown: keys?.filter(key => isShowingEnded || !hasEnded(key, now)) ?? [],
    toggle:
      ended.length === 0 ? null : (
        <div className="mt-8">
          <Button size="sm" intent="quiet" onClick={() => setIsShowingEnded(current => !current)}>
            {isShowingEnded ? 'Hide ended keys' : `Show ${counted(ended.length, 'ended key')}`}
          </Button>
        </div>
      ),
  };
};
