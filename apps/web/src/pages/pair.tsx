// The page a pairing link opens. Everything it shows comes from the link's fragment, which the
// store never received: the code is computed here from the key the terminal made.
import { PairingRequestSchema } from '@baymutt/api';
import { pairingCode } from '@baymutt/keys';
import { useAtom, useAtomValue } from '@effect/atom-react';
import { Link } from '@tanstack/react-router';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';
import * as Schema from 'effect/Schema';
import { useMemo } from 'react';
import { useOwner } from '../components/gate.tsx';
import { Code, Notice } from '../components/parts.tsx';
import { Button, buttonStyles } from '../components/ui/button.tsx';
import { pairAtom } from '../lib/data.ts';
import { failureMessage, latest } from '../lib/result.ts';

const decodeFragment = Schema.decodeUnknownOption(Schema.fromJsonString(PairingRequestSchema));

const pairingCodeAtom = Atom.family((publicKey: string) =>
  Atom.make(Effect.promise(() => pairingCode(publicKey))),
);

export const PairPage = () => {
  const owner = useOwner();
  const request = useMemo(
    () => Option.getOrNull(decodeFragment(decodeURIComponent(window.location.hash.slice(1)))),
    [],
  );
  const [pairing, pair] = useAtom(pairAtom);
  const code = latest(useAtomValue(pairingCodeAtom(request?.publicKey ?? '')));

  if (request === null) {
    return (
      <div className="max-w-[34rem] space-y-4">
        <h1 className="text-xl">This is not a login link</h1>
        <p className="text-muted">
          Run <Code>baymutt login</Code> on the computer and open the whole link it prints,
          including everything after the #.
        </p>
      </div>
    );
  }

  if (AsyncResult.isSuccess(pairing)) {
    return (
      <div className="max-w-[34rem] space-y-4">
        <h1 className="text-xl">{request.name} is approved</h1>
        <p className="text-muted">
          The terminal picks this up by itself. The service account has no access yet: it can ask
          with <Code>baymutt access request</Code>, or you can grant it a project now.
        </p>
        <Link to="/projects" className={buttonStyles({ intent: 'primary' })}>
          Go to projects
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-[34rem] space-y-5">
      <div>
        <h1 className="text-xl">Approve {request.name}?</h1>
        <p className="mt-2 text-muted">
          A service account is asking to join{' '}
          <span className="text-foreground">{owner.accountName}</span>. It will be able to ask you
          for access; it starts with none.
        </p>
      </div>
      <div className="rounded-panel border border-line bg-surface px-5 py-5 sm:px-6">
        <Code aria-live="polite" className="block text-xl font-medium tracking-[0.14em]">
          {code ?? '····-····'}
        </Code>
        <p className="mt-2 text-sm text-muted">This must match the code in the terminal.</p>
      </div>
      <Notice tone="warn">
        If the codes differ, or you did not run <Code>baymutt login</Code> yourself, this link
        carries someone else’s key. Do not approve it.
      </Notice>
      {failureMessage(pairing) && <Notice>{failureMessage(pairing)}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button
          intent="primary"
          disabled={pairing.waiting || code === null}
          onClick={() => pair({ owner, request })}
        >
          {pairing.waiting ? 'Approving…' : 'The codes match: approve it'}
        </Button>
        <Link to="/projects" className={buttonStyles()}>
          Do not approve
        </Link>
      </div>
    </div>
  );
};
