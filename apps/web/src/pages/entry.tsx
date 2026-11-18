// The way in. Signed out: a passkey, or an email and password, or a link by email (which is also
// how an account starts). Signed in with no vault: making one. Signed in with the vault locked:
// opening it.
import type { Account } from '@baymutt/api';
import { MIN_PASSWORD_LENGTH } from '@baymutt/keys';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { Link } from '@tanstack/react-router';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';
import { type ReactNode, useLayoutEffect, useState } from 'react';
import mark from '../assets/mark.svg';
import { useTitle } from '../components/shell.tsx';
import { Button } from '../components/ui/button.tsx';
import { Form, TextField } from '../components/ui/field.tsx';
import {
  sendLinkAtom,
  sessionAtom,
  setUpAtom,
  signInWithPasskeyAtom,
  signInWithPasswordAtom,
  signOutAtom,
  unlockWithPasswordAtom,
} from '../lib/data.ts';
import type { FirstUnlock } from '../lib/owner.ts';
import { clearsFailure, failureMessage, latest } from '../lib/result.ts';

/**
 * `main.entry`: a page outside the app, under the mark that leads home. Its parts follow in
 * `children`, each setting the gap above itself.
 */
export const Standalone = ({ children }: { readonly children: ReactNode }) => (
  <main className="entry">
    <a className="entry-brand" href="/">
      <img src={mark} alt="" />
      baymutt
    </a>
    {children}
  </main>
);

/** The price, where the reader decides on it: the last part of sign in, sign up and recover. */
export const BetaLine = () => <p className="entry-beta">Free while in beta</p>;

/** A store or passkey failure under the button that was used. */
const EntryError = ({ message }: { readonly message: string | null }) =>
  message !== null && (
    <p role="alert" className="error">
      {message}
    </p>
  );

const PASSWORD_HINT = `At least ${MIN_PASSWORD_LENGTH} characters. It opens your vault, and baymutt never receives it, so it cannot be reset: only your recovery key replaces it.`;

const isEmail = (text: string) => /^\S+@\S+\.\S+$/.test(text.trim());

/**
 * One email field and one button that sends a sign-in link, then `.entry-sent` in their place. It
 * is how an account starts and how a lost one is recovered.
 */
export const LinkByEmail = ({
  landOn,
  action,
  sent,
}: {
  readonly landOn: '/orgs' | '/recover';
  readonly action: string;
  /** The last sentence once the link is on its way. */
  readonly sent: string;
}) => {
  const [link, sendLink] = useAtom(sendLinkAtom);
  const [email, setEmail] = useState('');
  // One atom serves sign-up and recovery: a link sent from the other page is not this one's.
  useLayoutEffect(() => {
    sendLink(Atom.Reset);
  }, [sendLink]);
  const clearing = clearsFailure(link, sendLink);
  if (AsyncResult.isSuccess(link)) {
    return (
      <div className="entry-sent" role="status">
        <h2>Check your inbox</h2>
        <p>
          We sent a link to <b>{email.trim()}</b>. It works once, for 10 minutes. Open it in this
          browser. {sent}
        </p>
      </div>
    );
  }
  return (
    <Form
      className="entry-body"
      onSubmit={event => {
        event.preventDefault();
        if (isEmail(email) && !link.waiting) sendLink({ email: email.trim(), landOn });
      }}
    >
      <TextField
        label="Email"
        type="email"
        autoComplete="email"
        autoFocus
        failure={failureMessage(link)}
        value={email}
        onValueChange={clearing(setEmail)}
      />
      <Button
        type="submit"
        kind="primary"
        size="lg"
        isWide
        isPending={link.waiting}
        pendingLabel="Sending…"
        disabled={!isEmail(email)}
      >
        {action}
      </Button>
    </Form>
  );
};

const SignedOut = () => {
  useTitle('Sign in');
  const [passkey, withPasskey] = useAtom(signInWithPasskeyAtom);
  const [password, withPassword] = useAtom(signInWithPasswordAtom);
  const [email, setEmail] = useState('');
  const [secret, setSecret] = useState('');
  const clearing = clearsFailure(password, withPassword);
  // The email must look like one: the browser would otherwise refuse the submit with no words.
  const isFilled = isEmail(email) && secret !== '';
  return (
    <>
      <h1>Sign in</h1>
      <div className="entry-body">
        <Button
          kind="primary"
          size="lg"
          isWide
          isPending={passkey.waiting}
          pendingLabel="Waiting for your passkey…"
          disabled={password.waiting}
          onClick={() => withPasskey()}
        >
          Sign in with a passkey
        </Button>
        <EntryError message={failureMessage(passkey)} />
      </div>
      <p className="entry-or">Or with your email and password</p>
      <Form
        className="entry-body"
        onSubmit={event => {
          event.preventDefault();
          if (isFilled) withPassword({ email: email.trim(), password: secret });
        }}
      >
        <TextField
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          onValueChange={clearing(setEmail)}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          failure={failureMessage(password)}
          value={secret}
          onValueChange={clearing(setSecret)}
        />
        <Button
          type="submit"
          size="lg"
          isWide
          isPending={password.waiting}
          pendingLabel="Signing in…"
          disabled={passkey.waiting || !isFilled}
        >
          Sign in
        </Button>
      </Form>
      <div className="entry-links">
        <p>
          <Link to="/recover" className="link">
            Lost your password or passkey?
          </Link>
        </p>
        <p>
          New to baymutt?&nbsp;
          <Link to="/signup" className="link">
            Create an account
          </Link>
        </p>
      </div>
      <BetaLine />
    </>
  );
};

/** A session with no vault: the email is verified, and what opens the vault is chosen here. */
const SetUp = ({
  email,
  onRecoveryKey,
}: {
  readonly email: string;
  readonly onRecoveryKey: (recoveryKey: string) => void;
}) => {
  useTitle('Set up your vault');
  const [setting, setUp] = useAtom(setUpAtom, { mode: 'promiseExit' });
  const [method, setMethod] = useState<FirstUnlock['_tag'] | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const hasName = name.trim() !== '';
  const isPasswordShort = password !== '' && password.length < MIN_PASSWORD_LENGTH;
  const isMismatch = again !== '' && again !== password;
  const isPasswordReady = password.length >= MIN_PASSWORD_LENGTH && again === password;
  const failure = failureMessage(setting);

  const start = async (unlock: FirstUnlock) => {
    setMethod(unlock._tag);
    const exit = await setUp({ name: name.trim(), unlock });
    if (exit._tag === 'Success') onRecoveryKey(exit.value.recoveryKey);
  };

  return (
    <>
      <h1>Set up your vault</h1>
      <p className="entry-lede">
        <b>{email}</b> is verified. Your vault is opened by something only you have: a passkey or a
        password. You can add the other later.
      </p>
      <div className="entry-body">
        <TextField
          label="Your name"
          hint="What the dashboard and your agents call this account."
          value={name}
          onValueChange={setName}
          maxLength={60}
          autoComplete="name"
          autoFocus
        />
        <Button
          kind="primary"
          size="lg"
          isWide
          isPending={setting.waiting && method === 'Passkey'}
          pendingLabel="Waiting for your passkey…"
          disabled={!hasName || setting.waiting}
          onClick={() => void start({ _tag: 'Passkey' })}
        >
          Use a passkey
        </Button>
        <EntryError message={method === 'Passkey' ? failure : null} />
        <p className="entry-note">
          Recommended: nothing to remember and nothing to guess. Your browser will ask twice, once
          to make it and once to unlock with it.
        </p>
      </div>
      <p className="entry-or">Or a password</p>
      <Form
        className="entry-body"
        onSubmit={event => {
          event.preventDefault();
          if (hasName && isPasswordReady) void start({ _tag: 'Password', password });
        }}
      >
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          hint={PASSWORD_HINT}
          error={isPasswordShort ? `At least ${MIN_PASSWORD_LENGTH} characters.` : null}
          value={password}
          onValueChange={setPassword}
        />
        <TextField
          label="Password again"
          type="password"
          autoComplete="new-password"
          error={isMismatch ? 'The two do not match.' : null}
          value={again}
          onValueChange={setAgain}
        />
        <Button
          type="submit"
          size="lg"
          isWide
          isPending={setting.waiting && method === 'Password'}
          pendingLabel="Setting up your vault…"
          disabled={!hasName || !isPasswordReady || setting.waiting}
        >
          Use this password
        </Button>
        <EntryError message={method === 'Password' ? failure : null} />
      </Form>
    </>
  );
};

/** Signed in, vault locked: after a magic link, or in a browser that has not opened it yet. */
const Unlock = ({ account }: { readonly account: Account }) => {
  useTitle(`Unlock ${account.name}`);
  const [passkey, withPasskey] = useAtom(signInWithPasskeyAtom);
  const [unlocking, withPassword] = useAtom(unlockWithPasswordAtom);
  const signOut = useAtomSet(signOutAtom);
  const [password, setPassword] = useState('');
  const hasPasskey = account.passkeys.some(({ hasWrap }) => hasWrap);
  return (
    <>
      <h1>Unlock {account.name}</h1>
      <p className="entry-lede">
        You are signed in, and your vault is locked. It stays unlocked in this browser until you
        sign out.
      </p>
      {hasPasskey && (
        <div className="entry-body">
          <Button
            kind="primary"
            size="lg"
            isWide
            isPending={passkey.waiting}
            pendingLabel="Waiting for your passkey…"
            disabled={unlocking.waiting}
            onClick={() => withPasskey()}
          >
            Unlock with a passkey
          </Button>
          <EntryError message={failureMessage(passkey)} />
        </div>
      )}
      {hasPasskey && account.hasPassword && <p className="entry-or">Or with your password</p>}
      {account.hasPassword && (
        <Form
          className="entry-body"
          onSubmit={event => {
            event.preventDefault();
            if (password !== '') withPassword(password);
          }}
        >
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            failure={failureMessage(unlocking)}
            value={password}
            onValueChange={clearsFailure(unlocking, withPassword)(setPassword)}
          />
          <Button
            type="submit"
            kind={hasPasskey ? 'secondary' : 'primary'}
            size="lg"
            isWide
            isPending={unlocking.waiting}
            pendingLabel="Unlocking…"
            disabled={passkey.waiting || password === ''}
          >
            Unlock with your password
          </Button>
        </Form>
      )}
      <p className="entry-line">
        Lost them?{' '}
        <Link to="/recover" className="link">
          Use your recovery key
        </Link>
        . Or{' '}
        <button type="button" className="link" onClick={() => signOut()}>
          sign out
        </button>
        .
      </p>
    </>
  );
};

/**
 * `onRecoveryKey` receives the key of a vault this screen just made, to be shown once before
 * anything else.
 */
export const Entry = ({
  onRecoveryKey,
}: {
  readonly onRecoveryKey: (recoveryKey: string) => void;
}) => {
  const result = useAtomValue(sessionAtom);
  const session = latest(result);
  if (session === null) return AsyncResult.isInitial(result) ? null : <SignedOut />;
  return session.account === null ? (
    <SetUp email={session.email} onRecoveryKey={onRecoveryKey} />
  ) : (
    <Unlock account={session.account} />
  );
};
