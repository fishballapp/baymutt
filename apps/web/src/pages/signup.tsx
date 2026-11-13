// Creating an account: an email, and nothing else yet. What opens the vault is chosen after the
// link has verified the address.
import { useAtomValue } from '@effect/atom-react';
import { Link, Navigate } from '@tanstack/react-router';
import { sessionAtom } from '../lib/data.ts';
import { latest } from '../lib/result.ts';
import { Elsewhere, Frame, LinkByEmail } from './entry.tsx';

export const SignUpPage = () => {
  const session = latest(useAtomValue(sessionAtom));
  // Already signed in: the sign-in page takes it from here (set up, or unlock).
  if (session !== null) return <Navigate to="/signin" replace />;
  return (
    <Frame
      title="Create your account"
      lede="Secrets your agents can use, sealed so that baymutt cannot read one."
    >
      <LinkByEmail
        landOn="/environments"
        action="Email me a link to get started"
        sent="It takes you to setting up your vault, with a passkey or a password."
      />
      <Elsewhere>
        <p>
          Have an account?{' '}
          <Link to="/signin" className="text-foreground underline">
            Sign in
          </Link>
        </p>
      </Elsewhere>
    </Frame>
  );
};
