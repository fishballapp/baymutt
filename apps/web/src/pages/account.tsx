import { MIN_PASSWORD_LENGTH } from '@baymutt/keys';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { useState } from 'react';
import { useOwner } from '../components/gate.tsx';
import {
  Notice,
  PageHeader,
  Row,
  RowActions,
  Rows,
  Section,
  Skeleton,
  Tag,
} from '../components/parts.tsx';
import { RecoveryKey } from '../components/recovery-key.tsx';
import { Button } from '../components/ui/button.tsx';
import { Confirm } from '../components/ui/confirm.tsx';
import { TextField } from '../components/ui/field.tsx';
import {
  addPasskeyAtom,
  removePasskeyAtom,
  removePasswordAtom,
  rotateRecoveryKeyAtom,
  sessionAtom,
  setPasswordAtom,
  signOutAtom,
} from '../lib/data.ts';
import { exactTime } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

const Passkeys = () => {
  const owner = useOwner();
  const account = latest(useAtomValue(sessionAtom))?.account;
  const [adding, add] = useAtom(addPasskeyAtom);
  const [removing, remove] = useAtom(removePasskeyAtom);
  return (
    <Section
      title="Passkeys"
      lede="Each one signs in and opens the vault with one prompt. Add one per device or password manager."
      action={
        <Button disabled={adding.waiting} onClick={() => add(owner)}>
          {adding.waiting ? 'Waiting for your passkey…' : 'Add a passkey'}
        </Button>
      }
    >
      {account == null && <Skeleton rows={1} />}
      {account?.passkeys.length === 0 && (
        <p className="rounded-panel border border-dashed border-line px-4 py-3 text-muted">
          No passkey yet. You sign in with your email and password.
        </p>
      )}
      {account != null && account.passkeys.length > 0 && (
        <Rows>
          {account.passkeys.map((passkey, index) => (
            <Row
              key={passkey.passkeyId}
              className="flex flex-col gap-x-4 gap-y-2 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">{passkey.name ?? `Passkey ${index + 1}`}</p>
                <p className="mt-0.5 text-sm text-muted">Added {exactTime(passkey.createdAt)}</p>
              </div>
              {!passkey.hasWrap && <Tag tone="warn">signs in, cannot open the vault</Tag>}
              <RowActions>
                <Button
                  size="sm"
                  intent="subtleDanger"
                  disabled={removing.waiting}
                  onClick={() => remove(passkey.passkeyId)}
                >
                  Remove
                </Button>
              </RowActions>
            </Row>
          ))}
        </Rows>
      )}
      {(failureMessage(adding) ?? failureMessage(removing)) && (
        <Notice className="mt-3">{failureMessage(adding) ?? failureMessage(removing)}</Notice>
      )}
    </Section>
  );
};

const Password = () => {
  const owner = useOwner();
  const account = latest(useAtomValue(sessionAtom))?.account;
  const [setting, setPassword] = useAtom(setPasswordAtom, { mode: 'promiseExit' });
  const [removing, remove] = useAtom(removePasswordAtom);
  const [isEditing, setIsEditing] = useState(false);
  const [password, setValue] = useState('');
  const [again, setAgain] = useState('');
  const hasPassword = account?.hasPassword === true;
  const mismatch = again !== '' && again !== password;
  return (
    <Section
      title="Password"
      lede={
        hasPassword
          ? `You can sign in with ${owner.email} and your password, which also opens the vault.`
          : 'Optional. With one, you can sign in with your email and password where a passkey is not at hand.'
      }
      action={
        !isEditing && (
          <div className="flex gap-2">
            <Button onClick={() => setIsEditing(true)}>
              {hasPassword ? 'Change password' : 'Set a password'}
            </Button>
            {hasPassword && (
              <Button intent="danger" disabled={removing.waiting} onClick={() => remove()}>
                {removing.waiting ? 'Removing…' : 'Remove'}
              </Button>
            )}
          </div>
        )
      }
    >
      {isEditing ? (
        <form
          className="max-w-[26rem] space-y-3"
          onSubmit={async event => {
            event.preventDefault();
            const exit = await setPassword({ owner, password });
            if (exit._tag !== 'Success') return;
            setValue('');
            setAgain('');
            setIsEditing(false);
          }}
        >
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            hint={`At least ${MIN_PASSWORD_LENGTH} characters. It opens your vault and baymutt never receives it, so it cannot be reset. Every other signed-in browser is signed out.`}
            value={password}
            onChange={event => setValue(event.target.value)}
          />
          <TextField
            label="New password again"
            type="password"
            autoComplete="new-password"
            error={mismatch ? 'The two do not match.' : failureMessage(setting)}
            value={again}
            onChange={event => setAgain(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              intent="primary"
              disabled={
                password.length < MIN_PASSWORD_LENGTH || again !== password || setting.waiting
              }
            >
              {setting.waiting ? 'Saving…' : 'Save password'}
            </Button>
            <Button onClick={() => setIsEditing(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        failureMessage(removing) && <Notice>{failureMessage(removing)}</Notice>
      )}
    </Section>
  );
};

const Recovery = ({ onNewKey }: { readonly onNewKey: (recoveryKey: string) => void }) => {
  const owner = useOwner();
  const [rotating, rotate] = useAtom(rotateRecoveryKeyAtom, { mode: 'promiseExit' });
  const [isConfirming, setIsConfirming] = useState(false);
  return (
    <Section
      title="Recovery key"
      lede="The way back in if every passkey is lost. It was shown once, when the vault was made."
      action={
        <Confirm
          open={isConfirming}
          onOpenChange={setIsConfirming}
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
    />
  );
};

export const AccountPage = () => {
  const owner = useOwner();
  const signOut = useAtomSet(signOutAtom);
  const [newKey, setNewKey] = useState<string | null>(null);
  if (newKey !== null) return <RecoveryKey recoveryKey={newKey} onDone={() => setNewKey(null)} />;
  return (
    <>
      <PageHeader
        title={owner.accountName}
        lede={`${owner.email}. Free while baymutt is in beta. Your vault stays open in this browser until you sign out.`}
        action={<Button onClick={() => signOut()}>Sign out</Button>}
      />
      <Passkeys />
      <Password />
      <Recovery onNewKey={setNewKey} />
    </>
  );
};
