import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { RobotIcon, TerminalWindowIcon } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
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
  Section,
  Skeleton,
  Tag,
  Time,
} from '../components/parts.tsx';
import { Button, buttonStyles } from '../components/ui/button.tsx';
import { Confirm } from '../components/ui/confirm.tsx';
import {
  type AccessChange,
  addressOf,
  changeAccessAtom,
  environmentsAtom,
  isLogin,
  isVouched,
  type OpenedEnvironment,
  type OpenedRequest,
  type OpenedServiceAccount,
  requestsAtom,
  revokeServiceAccountAtom,
  serviceAccountsAtom,
  setExpiryAtom,
} from '../lib/data.ts';
import { counted, expiryWords } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

/** A login and a scoped service account are told apart by a glyph and a word, never by colour. */
const KindIcon = ({ serviceAccount }: { readonly serviceAccount: OpenedServiceAccount }) => {
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
        {isLogin(serviceAccount) && ', and so do the service accounts it asked for'}. A later date
        revives it. What it already read stays read.
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
  const environments = latest(useAtomValue(environmentsAtom(owner))) ?? [];
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
            <Tag
              tone={
                serviceAccount.expiresAt !== null && serviceAccount.expiresAt <= Date.now()
                  ? 'warn'
                  : 'plain'
              }
            >
              {expiryWords(serviceAccount.expiresAt, Date.now())}
            </Tag>
          </p>
          {serviceAccount.description !== null && (
            <p className="mt-0.5 text-sm [overflow-wrap:anywhere]">{serviceAccount.description}</p>
          )}
          <p className="mt-0.5 text-sm text-muted">
            {isLogin(serviceAccount) ? 'CLI login, approved' : 'Service account, asked for by'}{' '}
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
              {made > 0 && `, and so do the ${counted(made, 'service account')} it asked for`}.
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

/** One request waiting for the owner, as a sentence: who asks for what. Its decision is on its own page. */
const RequestRow = ({ request }: { readonly request: OpenedRequest }) => (
  <Row>
    <div className="flex flex-col gap-x-4 gap-y-2 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <p>
          <span className="font-medium">{request.maker.name}</span> asks for{' '}
          {request.items.map((item, index) => (
            <span key={item.environmentId}>
              {index > 0 && ', '}
              <Code>{addressOf({ orgSlug: item.orgSlug, name: item.openedEnvironmentName })}</Code>{' '}
              <span className="text-muted">({grantWords(item)})</span>
            </span>
          ))}
        </p>
        <p className="mt-1.5 max-w-[65ch] border-line border-l pl-3 text-sm text-muted [overflow-wrap:anywhere]">
          {request.reason}
        </p>
        <p className="mt-1.5 text-sm text-muted">
          asked <Time at={request.createdAt} />
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5 sm:shrink-0">
        <Link to="/requests/$id" params={{ id: request.id }} className={buttonStyles()}>
          Review
        </Link>
      </div>
    </div>
  </Row>
);

const Requests = () => {
  const requests = latest(useAtomValue(requestsAtom(useOwner())));
  if (requests === null || requests.length === 0) return null;
  return (
    <Section
      title="Requests"
      lede="Each waits for you. Approving one makes its key a service account."
    >
      <Rows>
        {requests.map(request => (
          <RequestRow key={request.id} request={request} />
        ))}
      </Rows>
    </Section>
  );
};

export const ServiceAccountsPage = () => {
  const result = useAtomValue(serviceAccountsAtom(useOwner()));
  const serviceAccounts = latest(result);
  return (
    <>
      <PageHeader
        title="Service accounts"
        lede="A CLI login lists the names in your orgs and opens nothing. A service account is the key of a request you approved: it reaches what the request named, until it ends."
      />
      <Requests />
      <Section title="CLI logins and service accounts">
        {failureMessage(result) && <Notice>{failureMessage(result)}</Notice>}
        {serviceAccounts === null && !failureMessage(result) && <Skeleton />}
        {serviceAccounts?.length === 0 && (
          <Empty title="No CLI logins yet">
            <p>Install the CLI and log in:</p>
            <CommandLine>npm install -g baymutt</CommandLine>
            <CommandLine>baymutt auth login</CommandLine>
            <p>
              It prints a link and a code. Open the link here and approve it if the codes match. The
              CLI login then lists the names in your orgs, and asks you for environments with{' '}
              <Code>baymutt ask access</Code>.
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
                made={
                  serviceAccounts.filter(({ parentId }) => parentId === serviceAccount.id).length
                }
              />
            ))}
          </Rows>
        )}
      </Section>
    </>
  );
};
