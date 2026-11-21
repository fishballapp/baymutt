// A key as a row on an org's Keys page, with the dialogs its `⋯` opens: access, expiry, revoke.

import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import * as Atom from 'effect/reactivity/Atom';
import { useState } from 'react';
import {
  type AccessChange,
  addressOf,
  changeAccessAtom,
  environmentsAtom,
  hasEnded,
  isVouched,
  type OpenedEnvironment,
  type OpenedServiceAccount,
  revokeServiceAccountAtom,
  setExpiryAtom,
} from '../lib/data.ts';
import { expiryWords } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';
import { ExpiryField, expiryLabel } from './expiry.tsx';
import { useOwner } from './gate.tsx';
import { Confirm, Dialog } from './ui/dialog.tsx';
import { Checkbox } from './ui/field.tsx';
import { Filter, NoMatch, useFilter } from './ui/filter.tsx';
import { Row, Status } from './ui/list.tsx';
import { RowMenu } from './ui/menu.tsx';
import { RelativeTime } from './ui/page.tsx';
import { AccessWords, Address } from './ui/text.tsx';

/** Whether a key reads an environment: a grant is a read. */
const readsOn = (key: OpenedServiceAccount, environmentId: string): boolean =>
  key.grants.some(held => held.environmentId === environmentId);

/** The words a filter on Keys matches: the key's name, its reason and its environments' addresses. */
export const keyWords = (key: OpenedServiceAccount): ReadonlyArray<string> => [
  key.name,
  key.description ?? '',
  ...key.grants.map(grant =>
    addressOf({ orgSlug: grant.orgSlug, name: grant.openedEnvironmentName }),
  ),
];

/**
 * What a key reads, changed here under the key it already has: from its row on Keys, and from
 * "Keys that reach it" on an environment. A key only reads. A read it gains needs its key as its
 * CLI login vouched for it; one made by a CLI before 0.4.0 has no such voucher, so it can only
 * stop reading.
 */
export const AccessDialog = ({
  keyToChange,
  maker,
  isOpen,
  onOpenChange,
}: {
  readonly keyToChange: OpenedServiceAccount;
  readonly maker: OpenedServiceAccount | undefined;
  readonly isOpen: boolean;
  readonly onOpenChange: (isOpen: boolean) => void;
}) => {
  const owner = useOwner();
  // A key belongs to one org and holds environments of that org only.
  const environments = (latest(useAtomValue(environmentsAtom(owner))) ?? [])
    .filter(environment => environment.orgId === keyToChange.org?.id)
    .map(environment => ({
      environment,
      address: addressOf({ orgSlug: environment.orgSlug, name: environment.openedName }),
    }))
    .toSorted((a, b) => a.address.localeCompare(b.address));
  const filter = useFilter(environments.length);
  const [saving, save] = useAtom(changeAccessAtom, { mode: 'promiseExit' });
  // One atom serves every key: another key's failure is cleared when this dialog opens.
  const forget = useAtomSet(changeAccessAtom);
  const [chosen, setChosen] = useState<Readonly<Record<string, boolean>>>({});
  const isKeyVouched = isVouched(keyToChange) && maker !== undefined;
  const readsAfter = (environment: OpenedEnvironment) =>
    chosen[environment.id] ?? readsOn(keyToChange, environment.id);
  const changes: ReadonlyArray<AccessChange> = environments.flatMap(({ environment }) => {
    const canRead = readsAfter(environment);
    return canRead === readsOn(keyToChange, environment.id)
      ? []
      : [{ environmentId: environment.id, orgId: environment.orgId, canRead }];
  });
  const shown = environments.filter(({ address }) => filter.matches(address));
  return (
    <Dialog
      open={isOpen}
      onOpenChange={onOpenChange}
      onOpen={() => {
        setChosen({});
        filter.clear();
        forget(Atom.Reset);
      }}
      title={`What can ${keyToChange.name} read?`}
      confirmLabel="Save access"
      pendingLabel="Saving…"
      isPending={saving.waiting}
      error={failureMessage(
        saving,
        'Something went wrong. The list behind shows what it holds now; try again.',
      )}
      onConfirm={async () => {
        if (maker === undefined || changes.length === 0) return onOpenChange(false);
        const exit = await save({ owner, serviceAccount: keyToChange, maker, changes });
        if (exit._tag === 'Success') onOpenChange(false);
      }}
    >
      {filter.isShown && <Filter filter={filter} placeholder="environment" />}
      {shown.length === 0 && filter.isFiltering ? (
        <NoMatch filter={filter}>No environment matches “{filter.query.trim()}”.</NoMatch>
      ) : (
        <ul className="access-list">
          {shown.map(({ environment, address }) => {
            const before = readsOn(keyToChange, environment.id);
            return (
              // biome-ignore lint/a11y/useSemanticElements: a fieldset would put a legend's box in the list; the group only names its checkbox.
              <li key={environment.id} role="group" aria-label={address}>
                <Address orgSlug={environment.orgSlug} name={environment.openedName} />
                <span className="checks">
                  <Checkbox
                    label="read"
                    checked={readsAfter(environment)}
                    disabled={!isKeyVouched && !before}
                    onCheckedChange={canRead =>
                      setChosen(current => ({ ...current, [environment.id]: canRead }))
                    }
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {isKeyVouched ? (
        <p>
          A read wraps the environment’s key to it. A key only reads: a write is asked for in a
          plan. What it reads cannot be unread.
        </p>
      ) : (
        <p>
          A CLI before 0.4.0 made it, so nothing vouches for its key: it can only stop reading here.
        </p>
      )}
    </Dialog>
  );
};

const ExpiryDialog = ({
  keyToChange,
  isOpen,
  onOpenChange,
}: {
  readonly keyToChange: OpenedServiceAccount;
  readonly isOpen: boolean;
  readonly onOpenChange: (isOpen: boolean) => void;
}) => {
  const [saving, save] = useAtom(setExpiryAtom, { mode: 'promiseExit' });
  // One atom serves every key: another key's failure is cleared when this dialog opens.
  const forget = useAtomSet(setExpiryAtom);
  const [expiresAt, setExpiresAt] = useState<number | null | undefined>(keyToChange.expiresAt);
  return (
    <Dialog
      open={isOpen}
      onOpenChange={onOpenChange}
      onOpen={() => {
        setExpiresAt(keyToChange.expiresAt);
        forget(Atom.Reset);
      }}
      title={`When should ${keyToChange.name} expire?`}
      confirmLabel="Save expiry"
      pendingLabel="Saving…"
      isPending={saving.waiting}
      isConfirmDisabled={expiresAt === undefined}
      error={failureMessage(saving)}
      onConfirm={async () => {
        if (expiresAt === undefined) return;
        const exit = await save({ id: keyToChange.id, expiresAt });
        if (exit._tag === 'Success') onOpenChange(false);
      }}
    >
      <ExpiryField
        kept={keyToChange.expiresAt}
        keptLabel={at => `${at <= Date.now() ? 'Expired' : 'Unchanged'}: ${expiryLabel(at)}`}
        onChange={setExpiresAt}
      />
      <p>
        Once it expires its key stops working. A later date revives it. What it already read stays
        read.
      </p>
    </Dialog>
  );
};

const RevokeDialog = ({
  keyToChange,
  isOpen,
  onOpenChange,
}: {
  readonly keyToChange: OpenedServiceAccount;
  readonly isOpen: boolean;
  readonly onOpenChange: (isOpen: boolean) => void;
}) => {
  const [revoking, revoke] = useAtom(revokeServiceAccountAtom, { mode: 'promiseExit' });
  const forget = useAtomSet(revokeServiceAccountAtom);
  return (
    <Confirm
      open={isOpen}
      onOpenChange={onOpenChange}
      onOpen={() => forget(Atom.Reset)}
      title={`Revoke ${keyToChange.name}?`}
      keepLabel="Keep key"
      confirmLabel="Revoke key"
      pendingLabel="Revoking…"
      isPending={revoking.waiting}
      error={failureMessage(revoking)}
      onConfirm={async () => {
        const exit = await revoke(keyToChange.id);
        if (exit._tag === 'Success') onOpenChange(false);
      }}
    >
      <p>Its key stops working at once.</p>
      <p>
        What it already read stays read. If the key may have leaked, replace those values at their
        vendors too.
      </p>
    </Confirm>
  );
};

/** When it ends, as `.status` reads it: a moment for an end, plain words for none. */
const EndWords = ({ expiresAt }: { readonly expiresAt: number | null }) =>
  expiresAt === null ? (
    'never expires'
  ) : (
    <RelativeTime at={expiresAt}>{() => expiryWords(expiresAt, Date.now())}</RelativeTime>
  );

/**
 * A service account or agent key: its name and quoted reason, what it reads, when it ends and
 * was last used, and its `⋯` with Access, Expiry and Revoke.
 */
export const KeyRow = ({
  keyToShow,
  maker,
}: {
  readonly keyToShow: OpenedServiceAccount;
  /** The CLI login that asked for it, which vouched for its key. */
  readonly maker: OpenedServiceAccount | undefined;
}) => {
  const [dialog, setDialog] = useState<'access' | 'expiry' | 'revoke' | null>(null);
  const toggle = (which: NonNullable<typeof dialog>) => (isOpen: boolean) =>
    setDialog(isOpen ? which : null);
  return (
    <Row variant="row-key">
      <div>
        <b>{keyToShow.name}</b>
        {keyToShow.description !== null && (
          <span className="cell-sub">“{keyToShow.description}”</span>
        )}
      </div>
      <ul className="reach">
        {keyToShow.grants.length === 0 ? (
          <li className="t-small muted">Reads no environment.</li>
        ) : (
          keyToShow.grants.map(grant => (
            <li key={grant.environmentId}>
              <Address orgSlug={grant.orgSlug} name={grant.openedEnvironmentName} />
              <span className="muted">
                <AccessWords canRead canWrite={false} />
              </span>
            </li>
          ))
        )}
      </ul>
      <Status
        status={<EndWords expiresAt={keyToShow.expiresAt} />}
        isWarn={hasEnded(keyToShow, Date.now())}
        fact={
          keyToShow.lastUsedAt === null ? (
            'never used'
          ) : (
            <RelativeTime at={keyToShow.lastUsedAt}>{ago => `used ${ago}`}</RelativeTime>
          )
        }
      />
      <RowMenu
        label={`${keyToShow.name}: access, expiry, revoke`}
        items={[
          { label: 'Access', onClick: () => setDialog('access') },
          { label: 'Expiry', onClick: () => setDialog('expiry') },
          { label: 'Revoke', onClick: () => setDialog('revoke'), isDanger: true },
        ]}
      />
      <AccessDialog
        keyToChange={keyToShow}
        maker={maker}
        isOpen={dialog === 'access'}
        onOpenChange={toggle('access')}
      />
      <ExpiryDialog
        keyToChange={keyToShow}
        isOpen={dialog === 'expiry'}
        onOpenChange={toggle('expiry')}
      />
      <RevokeDialog
        keyToChange={keyToShow}
        isOpen={dialog === 'revoke'}
        onOpenChange={toggle('revoke')}
      />
    </Row>
  );
};
