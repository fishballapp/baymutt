// Creating an account: an email, and nothing else yet. What opens the vault is chosen after the
// link has verified the address.
import { useAtomValue } from '@effect/atom-react';
import { Link, Navigate } from '@tanstack/react-router';
import { useTitle } from '../components/shell.tsx';
import { sessionAtom } from '../lib/data.ts';
import { latest } from '../lib/result.ts';
import { BetaLine, LinkByEmail, Standalone } from './entry.tsx';

export const SignUpPage = () => {
  useTitle('Create your account');
  const session = latest(useAtomValue(sessionAtom));
  // Already signed in: the sign-in page takes it from here (set up, or unlock).
  if (session !== null) return <Navigate to="/signin" replace />;
  return (
    <Standalone>
      <h1>Create your account</h1>
      <p className="entry-lede">
        Secrets your agents can use, sealed so that baymutt cannot read one.
      </p>
      <LinkByEmail
        landOn="/orgs"
        action="Email me a link to get started"
        sent="It takes you to setting up your vault, with a passkey or a password."
      />
      <div className="entry-links">
        <p>
          Have an account?&nbsp;
          <Link to="/signin" className="link">
            Sign in
          </Link>
        </p>
      </div>
      <BetaLine />
    </Standalone>
  );
};
