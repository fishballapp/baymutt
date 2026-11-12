// The way back in when the password and every passkey are lost: an email link signs in, and the
// recovery key opens the vault. A new password or passkey is then set from the account page.
import { useAtom, useAtomValue } from '@effect/atom-react';
import { Link, Navigate, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Notice } from '../components/parts.tsx';
import { RecoveryKey } from '../components/recovery-key.tsx';
import { Button } from '../components/ui/button.tsx';
import { TextArea } from '../components/ui/field.tsx';
import { recoverAtom, sessionAtom } from '../lib/data.ts';
import { failureMessage, latest } from '../lib/result.ts';
import { Elsewhere, Frame, LinkByEmail } from './entry.tsx';

export const RecoverPage = () => {
  const navigate = useNavigate();
  const session = latest(useAtomValue(sessionAtom));
  const [recovering, recover] = useAtom(recoverAtom, { mode: 'promiseExit' });
  const [recoveryKey, setRecoveryKey] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);

  if (newKey !== null) {
    return <RecoveryKey recoveryKey={newKey} onDone={() => navigate({ to: '/account' })} />;
  }
  if (session === null) {
    return (
      <Frame
        title="Recover your account"
        lede="Lost your password or passkey? A link to your email signs you in, and your recovery key then opens your vault."
      >
        <LinkByEmail
          landOn="/recover"
          action="Email me a link"
          sent="Have your recovery key ready."
        />
        <Elsewhere>
          <p>
            <Link to="/signin" className="text-foreground underline">
              Back to sign in
            </Link>
          </p>
        </Elsewhere>
      </Frame>
    );
  }
  // Signed in with no vault yet: there is nothing to recover, only a vault to set up.
  if (session.account === null) return <Navigate to="/signin" replace />;
  return (
    <Frame
      title="Recover your vault"
      lede={
        <>
          Your recovery key opens the vault of{' '}
          <span className="text-foreground">{session.email}</span>. It is then replaced: you will be
          shown a new one, and you set a new password or passkey next.
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={async event => {
          event.preventDefault();
          const exit = await recover(recoveryKey);
          if (exit._tag === 'Success') setNewKey(exit.value.recoveryKey);
        }}
      >
        <TextArea
          label="Recovery key"
          isCode
          rows={3}
          placeholder="XXXX-XXXX-XXXX-…"
          hint="Thirteen groups of four. Dashes, spaces and case do not matter."
          error={failureMessage(recovering)}
          value={recoveryKey}
          onChange={event => setRecoveryKey(event.target.value)}
        />
        <Button
          type="submit"
          intent="primary"
          className="w-full"
          disabled={recoveryKey.trim() === '' || recovering.waiting}
        >
          {recovering.waiting ? 'Opening your vault…' : 'Open my vault'}
        </Button>
      </form>
      <Notice tone="plain">
        Without a passkey, your password or this key, nobody can open the vault, baymutt included.
      </Notice>
      <Elsewhere>
        <p>
          <Link to="/signin" className="text-foreground underline">
            Back to sign in
          </Link>
        </p>
      </Elsewhere>
    </Frame>
  );
};
