import { MIN_PASSWORD_LENGTH } from '@baymutt/keys';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import * as Atom from 'effect/reactivity/Atom';
import { useState } from 'react';
import { ExpiryField, expiryLabel } from '../components/expiry.tsx';
import { useOwner } from '../components/gate.tsx';
import { OrgList } from '../components/orgs.tsx';
import { RecoveryKey } from '../components/recovery-key.tsx';
import { useTitle } from '../components/shell.tsx';
import { Button } from '../components/ui/button.tsx';
import { Confirm, Dialog } from '../components/ui/dialog.tsx';
import { TextField } from '../components/ui/field.tsx';
import { ActionForm, useInlineForm } from '../components/ui/form.tsx';
import {
  EmptyState,
  Ended,
  List,
  ListActions,
  Notice,
  Row,
  Rows,
  Skeleton,
  Status,
} from '../components/ui/list.tsx';
import { RowMenu } from '../components/ui/menu.tsx';
import { PageHead, RelativeTime } from '../components/ui/page.tsx';
import {
  addPasskeyAtom,
  hasEnded,
  isLogin,
  type OpenedServiceAccount,
  removePasskeyAtom,
  removePasswordAtom,
  revokeServiceAccountAtom,
  rotateRecoveryKeyAtom,
  serviceAccountsAtom,
  sessionAtom,
  setExpiryAtom,
  setPasswordAtom,
  signOutAtom,
} from '../lib/data.ts';
import { counted, expiryWords } from '../lib/format.ts';
import { clearsFailure, failureMessage, latest } from '../lib/result.ts';

/** "Its key stops working at once, and so do the 3 keys it asked for." */
const revokeSentence = (made: number) => {
  if (made === 0) return 'Its key stops working at once.';
  if (made === 1) return 'Its key stops working at once, and so does the 1 key it asked for.';
  return `Its key stops working at once, and so do the ${made} keys it asked for.`;
};

/** When it ends, in words: a moment while it is ahead, "expired" in `warn` once it has passed. */
const LoginEnd = ({ expiresAt }: { readonly expiresAt: number | null }) => {
  if (expiresAt === null) return 'never expires';
  if (expiresAt <= Date.now()) return <span className="warn">expired</span>;
  return <RelativeTime at={expiresAt}>{() => expiryWords(expiresAt, Date.now())}</RelativeTime>;
};

/** One CLI login: its name, when it was approved, its end over its last use, and its `⋯`. */
const CliLoginRow = ({
  login,
  made,
}: {
  readonly login: OpenedServiceAccount;
  readonly made: number;
}) => {
  const [saving, save] = useAtom(setExpiryAtom, { mode: 'promiseExit' });
  const [revoking, revoke] = useAtom(revokeServiceAccountAtom, { mode: 'promiseExit' });
  // Both atoms serve every row, so an earlier row's failure is cleared when a dialog opens.
  const forgetSaving = useAtomSet(setExpiryAtom);
  const forgetRevoking = useAtomSet(revokeServiceAccountAtom);
  const [dialog, setDialog] = useState<'expiry' | 'revoke' | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null | undefined>(login.expiresAt);
  return (
    <Row variant="row-acct">
      <b>{login.name}</b>
      <RelativeTime at={login.createdAt} className="t-small muted">
        {words => `approved ${words}`}
      </RelativeTime>
      <Status
        status={<LoginEnd expiresAt={login.expiresAt} />}
        fact={
          login.lastUsedAt === null ? (
            'never used'
          ) : (
            <RelativeTime at={login.lastUsedAt}>{words => `used ${words}`}</RelativeTime>
          )
        }
      />
      <RowMenu
        label={`${login.name}: expiry, revoke`}
        items={[
          { label: 'Expiry', onClick: () => setDialog('expiry') },
          { label: 'Revoke', isDanger: true, onClick: () => setDialog('revoke') },
        ]}
      />
      <Dialog
        open={dialog === 'expiry'}
        onOpenChange={open => setDialog(open ? 'expiry' : null)}
        onOpen={() => {
          forgetSaving(Atom.Reset);
          setExpiresAt(login.expiresAt);
        }}
        title={`When should ${login.name} expire?`}
        confirmLabel="Save expiry"
        pendingLabel="Saving…"
        isPending={saving.waiting}
        isConfirmDisabled={expiresAt === undefined}
        error={failureMessage(saving)}
        onConfirm={async () => {
          if (expiresAt === undefined) return;
          const exit = await save({ id: login.id, expiresAt });
          if (exit._tag === 'Success') setDialog(null);
        }}
      >
        <ExpiryField
          kept={login.expiresAt}
          keptLabel={at => `${at <= Date.now() ? 'Expired' : 'Unchanged'}: ${expiryLabel(at)}`}
          onChange={setExpiresAt}
        />
        <p>
          Once it expires its key stops working, and so do the keys it asked for. A later date
          revives it. What it already read stays read.
        </p>
      </Dialog>
      <Confirm
        open={dialog === 'revoke'}
        onOpenChange={open => setDialog(open ? 'revoke' : null)}
        onOpen={() => forgetRevoking(Atom.Reset)}
        title={`Revoke ${login.name}?`}
        keepLabel="Keep key"
        confirmLabel="Revoke key"
        pendingLabel="Revoking…"
        isPending={revoking.waiting}
        error={failureMessage(revoking)}
        onConfirm={async () => {
          const exit = await revoke(login.id);
          if (exit._tag === 'Success') setDialog(null);
        }}
      >
        <p>{revokeSentence(made)}</p>
        <p>
          What it already read stays read. If the key may have leaked, replace those values at their
          vendors too.
        </p>
      </Confirm>
    </Row>
  );
};

/**
 * The account's CLI logins: each lists the names in every org and holds no environment, so they
 * are the account's, not an org's. Active ones newest first; ended ones behind a toggle, the
 * latest end first.
 */
const CliLogins = () => {
  const result = useAtomValue(serviceAccountsAtom(useOwner()));
  const all = latest(result);
  const now = Date.now();
  const row = (login: OpenedServiceAccount) => (
    <CliLoginRow
      key={login.id}
      login={login}
      made={all?.filter(({ parentId }) => parentId === login.id).length ?? 0}
    />
  );
  const logins = all?.filter(isLogin) ?? [];
  const active = logins
    .filter(login => !hasEnded(login, now))
    .toSorted((a, b) => b.createdAt - a.createdAt);
  const ended = logins
    .filter(login => hasEnded(login, now))
    .toSorted((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0));
  const rows = (() => {
    if (all === null) {
      const failure = failureMessage(result);
      return failure === null ? <Skeleton /> : <Notice tone="danger">{failure}</Notice>;
    }
    if (active.length === 0) {
      return (
        <EmptyState
          example={{
            lead: 'An agent logs in like this:',
            commands: ['npm install -g baymutt', 'baymutt auth login'],
          }}
        >
          A CLI login shows here once you approve the link it prints.
        </EmptyState>
      );
    }
    return <Rows>{active.map(row)}</Rows>;
  })();
  return (
    <>
      <List title="CLI logins" lede="Each lists the names in your orgs and opens no value.">
        {rows}
      </List>
      {ended.length > 0 && (
        <Ended
          showLabel={`Show ${counted(ended.length, 'ended CLI login')}`}
          hideLabel="Hide ended CLI logins"
        >
          {ended.map(row)}
        </Ended>
      )}
    </>
  );
};

const Passkeys = () => {
  const owner = useOwner();
  const account = latest(useAtomValue(sessionAtom))?.account;
  const [adding, add] = useAtom(addPasskeyAtom);
  const [removing, remove] = useAtom(removePasskeyAtom);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const rows = (() => {
    if (account == null) return <Skeleton />;
    if (account.passkeys.length === 0) {
      return (
        <EmptyState>
          {account.hasPassword
            ? 'Your passkeys show here. You sign in with your email and password for now.'
            : 'Your passkeys show here. Add one, or set a password, to unlock without your recovery key.'}
        </EmptyState>
      );
    }
    return (
      <Rows>
        {account.passkeys
          .toSorted((a, b) => a.createdAt - b.createdAt)
          .map((passkey, index) => {
            const name = passkey.name ?? `Passkey ${index + 1}`;
            const isRemoving = removing.waiting && removingId === passkey.passkeyId;
            return (
              <Row
                key={passkey.passkeyId}
                variant="row-acct"
                working={isRemoving ? 'Removing…' : null}
              >
                <b>{name}</b>
                <RelativeTime at={passkey.createdAt} className="t-small muted">
                  {words => `added ${words}`}
                </RelativeTime>
                {!passkey.hasWrap && <Status status="signs in, cannot unlock" isWarn />}
                <RowMenu
                  label={`${name}: remove`}
                  isDisabled={isRemoving}
                  items={[
                    {
                      label: 'Remove',
                      isDanger: true,
                      onClick: () => {
                        // One failure line serves both actions: the one starting replaces the other's.
                        add(Atom.Reset);
                        setRemovingId(passkey.passkeyId);
                        remove(passkey.passkeyId);
                      },
                    },
                  ]}
                />
              </Row>
            );
          })}
      </Rows>
    );
  })();
  return (
    <List
      title="Passkeys"
      actions={
        <Button
          isPending={adding.waiting}
          pendingLabel="Waiting for your passkey…"
          onClick={() => {
            remove(Atom.Reset);
            add(owner);
          }}
        >
          Add a passkey
        </Button>
      }
      error={failureMessage(adding) ?? failureMessage(removing)}
    >
      {rows}
    </List>
  );
};

/** Change or set the password, in place of the Password list's lede. */
const PasswordForm = ({ onClose }: { readonly onClose: () => void }) => {
  const owner = useOwner();
  const [setting, setPassword] = useAtom(setPasswordAtom, { mode: 'promiseExit' });
  const clearing = clearsFailure(setting, useAtomSet(setPasswordAtom));
  const [password, setValue] = useState('');
  const [again, setAgain] = useState('');
  const isShort = password !== '' && password.length < MIN_PASSWORD_LENGTH;
  const isMismatch = again !== '' && again !== password;
  return (
    <ActionForm
      placement="inline"
      submitLabel="Save password"
      pendingLabel="Saving…"
      isPending={setting.waiting}
      isSubmitDisabled={password.length < MIN_PASSWORD_LENGTH || again !== password}
      onCancel={onClose}
      onSubmit={async () => {
        const exit = await setPassword({ owner, password });
        if (exit._tag === 'Success') onClose();
      }}
    >
      <TextField
        label="New password"
        type="password"
        autoComplete="new-password"
        hint={`At least ${MIN_PASSWORD_LENGTH} characters. It opens your vault and baymutt never receives it, so it cannot be reset. Every other signed-in browser is signed out.`}
        error={isShort ? `At least ${MIN_PASSWORD_LENGTH} characters.` : null}
        value={password}
        onValueChange={clearing(setValue)}
      />
      <TextField
        label="New password again"
        type="password"
        autoComplete="new-password"
        error={isMismatch ? 'The two do not match.' : null}
        failure={failureMessage(setting)}
        value={again}
        onValueChange={clearing(setAgain)}
      />
    </ActionForm>
  );
};

const Password = () => {
  const owner = useOwner();
  const account = latest(useAtomValue(sessionAtom))?.account;
  const [removing, remove] = useAtom(removePasswordAtom);
  const form = useInlineForm('password');
  const hasPassword = account?.hasPassword === true;
  const actions = (() => {
    if (form.isOpen) return null;
    if (!hasPassword) {
      return (
        <Button
          onClick={() => {
            remove(Atom.Reset);
            form.open();
          }}
        >
          Set a password
        </Button>
      );
    }
    return (
      <ListActions>
        <Button
          kind="quiet-danger"
          isPending={removing.waiting}
          pendingLabel="Removing…"
          onClick={() => remove()}
        >
          Remove
        </Button>
        <Button
          disabled={removing.waiting}
          onClick={() => {
            remove(Atom.Reset);
            form.open();
          }}
        >
          Change password
        </Button>
      </ListActions>
    );
  })();
  const lede = hasPassword
    ? `You can sign in with ${owner.email} and your password, which also unlocks the vault.`
    : 'Optional. With one, you can sign in where a passkey is not at hand.';
  return (
    <List
      title="Password"
      actions={actions}
      lede={form.isOpen ? null : lede}
      error={failureMessage(removing)}
    >
      {form.isOpen && <PasswordForm onClose={form.close} />}
    </List>
  );
};

const Recovery = ({ onNewKey }: { readonly onNewKey: (recoveryKey: string) => void }) => {
  const owner = useOwner();
  const [rotating, rotate] = useAtom(rotateRecoveryKeyAtom, { mode: 'promiseExit' });
  const forgetRotating = useAtomSet(rotateRecoveryKeyAtom);
  const [isConfirming, setIsConfirming] = useState(false);
  return (
    <List
      title="Recovery key"
      lede="The way back in if every passkey and the password are lost. It is shown once, when it is made."
      actions={
        <Confirm
          open={isConfirming}
          onOpenChange={setIsConfirming}
          onOpen={() => forgetRotating(Atom.Reset)}
          trigger={<Button>Make a new recovery key</Button>}
          title="Make a new recovery key?"
          keepLabel="Keep the current one"
          confirmLabel="Make a new key"
          pendingLabel="Making a new key…"
          isPending={rotating.waiting}
          error={failureMessage(rotating)}
          onConfirm={async () => {
            const exit = await rotate(owner);
            if (exit._tag !== 'Success') return;
            setIsConfirming(false);
            onNewKey(exit.value.recoveryKey);
          }}
        >
          <p>The key you have now stops working at once. The new one is shown once.</p>
        </Confirm>
      }
    >
      {null}
    </List>
  );
};

export const AccountPage = () => {
  useTitle('Account');
  const owner = useOwner();
  const signOut = useAtomSet(signOutAtom);
  const [newKey, setNewKey] = useState<string | null>(null);
  // The shell holds this page, so the key shows as an entry page's parts inside its column.
  if (newKey !== null) {
    return (
      <div className="entry">
        <RecoveryKey recoveryKey={newKey} onDone={() => setNewKey(null)} />
      </div>
    );
  }
  return (
    <>
      <PageHead
        title={<h1>{owner.accountName}</h1>}
        sub={owner.email}
        primary={<Button onClick={() => signOut()}>Sign out</Button>}
      />
      <OrgList />
      <CliLogins />
      <Passkeys />
      <Password />
      <Recovery onNewKey={setNewKey} />
    </>
  );
};
