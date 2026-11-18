// The way back in when the password and every passkey are lost: an email link signs in, and the
// recovery key opens the vault. A new password or passkey is then set from the account page.
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { Link, Navigate, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { RecoveryKey } from '../components/recovery-key.tsx';
import { useTitle } from '../components/shell.tsx';
import { Button } from '../components/ui/button.tsx';
import { Form, TextAreaField } from '../components/ui/field.tsx';
import { recoverAtom, sessionAtom } from '../lib/data.ts';
import { clearsFailure, failureMessage, latest } from '../lib/result.ts';
import { BetaLine, LinkByEmail, Standalone } from './entry.tsx';

const BackToSignIn = () => (
  <div className="entry-links">
    <p>
      <Link to="/signin" className="link">
        Back to sign in
      </Link>
    </p>
  </div>
);

const SignedOut = () => {
  useTitle('Recover your account');
  return (
    <>
      <h1>Recover your account</h1>
      <p className="entry-lede">
        Lost your password or passkey? A link to your email signs you in, and your recovery key then
        unlocks your vault.
      </p>
      <LinkByEmail
        landOn="/recover"
        action="Email me a link"
        sent="Have your recovery key ready."
      />
      <BackToSignIn />
      <BetaLine />
    </>
  );
};

const SignedIn = ({
  email,
  onRecovered,
}: {
  readonly email: string;
  readonly onRecovered: (newKey: string) => void;
}) => {
  useTitle('Recover your vault');
  const [recovering, recover] = useAtom(recoverAtom, { mode: 'promiseExit' });
  const forget = useAtomSet(recoverAtom);
  const [recoveryKey, setRecoveryKey] = useState('');
  const isEmpty = recoveryKey.trim() === '';
  return (
    <>
      <h1>Recover your vault</h1>
      <p className="entry-lede">
        Your recovery key unlocks the vault of <b>{email}</b>. It is then replaced: you will see a
        new one, and set a new password or passkey next.
      </p>
      <Form
        className="entry-body"
        onSubmit={async event => {
          event.preventDefault();
          if (isEmpty) return;
          const exit = await recover(recoveryKey);
          if (exit._tag === 'Success') onRecovered(exit.value.recoveryKey);
        }}
      >
        <TextAreaField
          label="Recovery key"
          rows={3}
          hint="Thirteen groups of four. Dashes, spaces and case do not matter."
          failure={failureMessage(recovering)}
          value={recoveryKey}
          onValueChange={clearsFailure(recovering, forget)(setRecoveryKey)}
        />
        <Button
          type="submit"
          kind="primary"
          size="lg"
          isWide
          isPending={recovering.waiting}
          pendingLabel="Unlocking your vault…"
          disabled={isEmpty}
        >
          Unlock my vault
        </Button>
        <p className="entry-note">
          Without a passkey, your password or this key, nobody can unlock the vault, baymutt
          included.
        </p>
      </Form>
      <BackToSignIn />
      <BetaLine />
    </>
  );
};

export const RecoverPage = () => {
  const navigate = useNavigate();
  const session = latest(useAtomValue(sessionAtom));
  const [newKey, setNewKey] = useState<string | null>(null);
  if (newKey !== null) {
    return (
      <Standalone>
        <RecoveryKey recoveryKey={newKey} onDone={() => navigate({ to: '/account' })} />
      </Standalone>
    );
  }
  if (session === null) {
    return (
      <Standalone>
        <SignedOut />
      </Standalone>
    );
  }
  // Signed in with no vault yet: there is nothing to recover, only a vault to set up.
  if (session.account === null) return <Navigate to="/signin" replace />;
  return (
    <Standalone>
      <SignedIn email={session.email} onRecovered={setNewKey} />
    </Standalone>
  );
};
