// The way in. Signed out: a passkey, or an email and password, or a link by email (which is also
// how an account starts). Signed in with no vault: making one. Signed in with the vault locked:
// opening it.
import type { Account } from '@baymutt/api';
import { MIN_PASSWORD_LENGTH } from '@baymutt/keys';
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react';
import { Link } from '@tanstack/react-router';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { type ReactNode, useState } from 'react';
import { Notice, Wordmark } from '../components/parts.tsx';
import { Button } from '../components/ui/button.tsx';
import { TextField } from '../components/ui/field.tsx';
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
import { failureMessage, latest } from '../lib/result.ts';

/**
 * A page outside the dashboard: one panel under the wordmark, which leads home. The panel's top
 * sits at the same height on every such page, so moving between them nothing jumps.
 */
export const Standalone = ({
  hasBetaNote = false,
  children,
}: {
  /** For the pages an account holder signs in or up on. */
  readonly hasBetaNote?: boolean;
  readonly children: ReactNode;
}) => (
  <div className="flex min-h-dvh flex-col items-center px-4 pt-6 pb-10 sm:px-6 sm:pt-[max(2.5rem,10vh)]">
    <div className="w-full max-w-[30rem]">
      <a href="/" className="-mx-1 inline-flex rounded-control px-1 py-1">
        <Wordmark />
      </a>
      <main className="mt-5 rounded-panel border border-line bg-surface px-5 py-7 sm:px-8 sm:py-8">
        {children}
      </main>
      {hasBetaNote && (
        <p className="mt-5 px-1 text-sm text-muted">Free while baymutt is in beta.</p>
      )}
    </div>
  </div>
);

/** A standalone page's heading, what it is for, and its one task. */
export const Frame = ({
  title,
  lede,
  children,
}: {
  readonly title: ReactNode;
  readonly lede?: ReactNode;
  readonly children: ReactNode;
}) => (
  <>
    <h1 className="text-xl leading-tight">{title}</h1>
    {lede && <p className="mt-2 text-muted">{lede}</p>}
    <div className="mt-7 space-y-6">{children}</div>
  </>
);

/** The links under a standalone page's task, to the other ways in. */
export const Elsewhere = ({ children }: { readonly children: ReactNode }) => (
  <div className="space-y-1.5 border-line border-t pt-5 text-muted">{children}</div>
);

const Or = ({ children }: { readonly children: string }) => (
  <p className="flex items-center gap-3 text-sm text-muted before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
    {children}
  </p>
);

const PASSWORD_HINT = `At least ${MIN_PASSWORD_LENGTH} characters. It opens your vault, and baymutt never receives it, so it cannot be reset: only your recovery key replaces it.`;

const isEmail = (text: string) => /^\S+@\S+\.\S+$/.test(text.trim());

/**
 * One email field and one button that sends a sign-in link, then says to check the inbox. It is
 * how an account starts and how a lost one is recovered.
 */
export const LinkByEmail = ({
  landOn,
  action,
  sent,
}: {
  readonly landOn: '/environments' | '/recover';
  readonly action: string;
  /** What to tell them once the link is on its way. */
  readonly sent: string;
}) => {
  const [link, sendLink] = useAtom(sendLinkAtom);
  const [email, setEmail] = useState('');
  if (AsyncResult.isSuccess(link)) {
    return (
      <div
        className="space-y-2 rounded-control border border-line bg-sunken px-4 py-3.5"
        role="status"
      >
        <h2 className="text-md">Check your inbox</h2>
        <p className="text-muted">
          We sent a link to <span className="text-foreground">{email.trim()}</span>. It works once,
          for 10 minutes. Open it in this browser. {sent}
        </p>
      </div>
    );
  }
  return (
    <form
      className="space-y-3"
      onSubmit={event => {
        event.preventDefault();
        sendLink({ email: email.trim(), landOn });
      }}
    >
      <TextField
        label="Email"
        type="email"
        autoComplete="email"
        autoFocus
        error={failureMessage(link)}
        value={email}
        onChange={event => setEmail(event.target.value)}
      />
      <Button
        type="submit"
        intent="primary"
        className="w-full"
        disabled={!isEmail(email) || link.waiting}
      >
        {link.waiting ? 'Sending…' : action}
      </Button>
    </form>
  );
};

const SignedOut = () => {
  const [passkey, withPasskey] = useAtom(signInWithPasskeyAtom);
  const [password, withPassword] = useAtom(signInWithPasswordAtom);
  const [email, setEmail] = useState('');
  const [secret, setSecret] = useState('');
  const isBusy = passkey.waiting || password.waiting;
  return (
    <Frame title="Sign in to baymutt" lede="Use your passkey, or your email and password.">
      <div className="space-y-3">
        <Button intent="primary" className="w-full" disabled={isBusy} onClick={() => withPasskey()}>
          {passkey.waiting ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
        </Button>
        {failureMessage(passkey) && <Notice>{failureMessage(passkey)}</Notice>}
      </div>
      <Or>or</Or>
      <form
        className="space-y-3"
        onSubmit={event => {
          event.preventDefault();
          withPassword({ email: email.trim(), password: secret });
        }}
      >
        <TextField
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={event => setEmail(event.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={secret}
          onChange={event => setSecret(event.target.value)}
        />
        <Button
          type="submit"
          className="w-full"
          disabled={isBusy || !isEmail(email) || secret === ''}
        >
          {password.waiting ? 'Signing in…' : 'Sign in'}
        </Button>
        {failureMessage(password) && <Notice>{failureMessage(password)}</Notice>}
      </form>
      <Elsewhere>
        <p>
          New here?{' '}
          <Link to="/signup" className="text-foreground underline">
            Create an account
          </Link>
        </p>
        <p>
          <Link to="/recover" className="text-foreground underline">
            Lost your password or passkey?
          </Link>
        </p>
      </Elsewhere>
    </Frame>
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
  const [setting, setUp] = useAtom(setUpAtom, { mode: 'promiseExit' });
  const [method, setMethod] = useState<FirstUnlock['_tag'] | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const hasName = name.trim() !== '';
  const mismatch = again !== '' && again !== password;
  const isPasswordReady = password.length >= MIN_PASSWORD_LENGTH && again === password;

  const start = async (unlock: FirstUnlock) => {
    setMethod(unlock._tag);
    const exit = await setUp({ name: name.trim(), unlock });
    if (exit._tag === 'Success') onRecoveryKey(exit.value.recoveryKey);
  };

  return (
    <Frame
      title="Set up your vault"
      lede={
        <>
          <span className="text-foreground">{email}</span> is verified. Your vault is opened by
          something only you have: a passkey or a password. You can add the other later.
        </>
      }
    >
      <TextField
        label="Your name"
        hint="What the dashboard and your agents call this account."
        value={name}
        onChange={event => setName(event.target.value)}
        maxLength={60}
        autoFocus
      />
      <div className="space-y-2">
        <Button
          intent="primary"
          className="w-full"
          disabled={!hasName || setting.waiting}
          onClick={() => start({ _tag: 'Passkey' })}
        >
          {setting.waiting && method === 'Passkey' ? 'Waiting for your passkey…' : 'Use a passkey'}
        </Button>
        <p className="text-sm text-muted">
          Recommended: nothing to remember and nothing to guess. Your browser will ask twice, once
          to make it and once to open the vault with it.
        </p>
      </div>
      <Or>or</Or>
      <form
        className="space-y-3"
        onSubmit={event => {
          event.preventDefault();
          void start({ _tag: 'Password', password });
        }}
      >
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          hint={PASSWORD_HINT}
          value={password}
          onChange={event => setPassword(event.target.value)}
        />
        <TextField
          label="Password again"
          type="password"
          autoComplete="new-password"
          error={mismatch ? 'The two do not match.' : null}
          value={again}
          onChange={event => setAgain(event.target.value)}
        />
        <Button
          type="submit"
          className="w-full"
          disabled={!hasName || !isPasswordReady || setting.waiting}
        >
          {setting.waiting && method === 'Password'
            ? 'Setting up your vault…'
            : 'Use this password'}
        </Button>
      </form>
      {failureMessage(setting) && <Notice>{failureMessage(setting)}</Notice>}
    </Frame>
  );
};

/** Signed in, vault locked: after a magic link, or in a browser that has not opened it yet. */
const Unlock = ({ account }: { readonly account: Account }) => {
  const [passkey, withPasskey] = useAtom(signInWithPasskeyAtom);
  const [unlocking, withPassword] = useAtom(unlockWithPasswordAtom);
  const signOut = useAtomSet(signOutAtom);
  const [password, setPassword] = useState('');
  const hasPasskey = account.passkeys.some(({ hasWrap }) => hasWrap);
  const isBusy = passkey.waiting || unlocking.waiting;
  return (
    <Frame
      title={`Unlock ${account.name}`}
      lede="You are signed in, and your vault is locked. Until you open it, you can look and change nothing. It then stays open in this browser until you sign out."
    >
      {hasPasskey && (
        <div className="space-y-3">
          <Button
            intent="primary"
            className="w-full"
            disabled={isBusy}
            onClick={() => withPasskey()}
          >
            {passkey.waiting ? 'Waiting for your passkey…' : 'Unlock with a passkey'}
          </Button>
          {failureMessage(passkey) && <Notice>{failureMessage(passkey)}</Notice>}
        </div>
      )}
      {account.hasPassword && (
        <form
          className="space-y-3"
          onSubmit={event => {
            event.preventDefault();
            withPassword(password);
          }}
        >
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            error={failureMessage(unlocking)}
            value={password}
            onChange={event => setPassword(event.target.value)}
          />
          <Button
            type="submit"
            intent={hasPasskey ? 'plain' : 'primary'}
            className="w-full"
            disabled={isBusy || password === ''}
          >
            {unlocking.waiting ? 'Unlocking…' : 'Unlock with your password'}
          </Button>
        </form>
      )}
      <p className="border-line border-t pt-5 text-muted">
        Lost them?{' '}
        <Link to="/recover" className="text-foreground underline">
          Use your recovery key
        </Link>
        . Or{' '}
        <button type="button" className="text-foreground underline" onClick={() => signOut()}>
          sign out
        </button>
        .
      </p>
    </Frame>
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
