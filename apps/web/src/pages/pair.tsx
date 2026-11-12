// The page a pairing link opens. Everything it shows comes from the link's fragment, which the
// store never received: the code is computed here from the key the terminal made. The name and
// the description are the terminal's words, shown as its claim.
import { PairingRequestSchema } from '@baymutt/api';
import { pairingCode } from '@baymutt/keys';
import { useAtom, useAtomValue } from '@effect/atom-react';
import { Link, useRouterState } from '@tanstack/react-router';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';
import * as Schema from 'effect/Schema';
import { useMemo, useState } from 'react';
import { ExpiryField, expiryLabel } from '../components/expiry.tsx';
import { useOwner } from '../components/gate.tsx';
import { Code, Notice } from '../components/parts.tsx';
import { Button, buttonStyles } from '../components/ui/button.tsx';
import { pairAtom } from '../lib/data.ts';
import { failureMessage, latest } from '../lib/result.ts';

const decodeFragment = Schema.decodeUnknownOption(Schema.fromJsonString(PairingRequestSchema));

const pairingCodeAtom = Atom.family((publicKey: string) =>
  Atom.make(Effect.promise(() => pairingCode(publicKey))),
);

/** The link's fragment, followed as it changes: a second link opened in the same tab is a new page. */
export const PairPage = () => {
  const hash = useRouterState({ select: state => state.location.hash });
  return <Pairing key={hash} hash={hash} />;
};

const Pairing = ({ hash }: { readonly hash: string }) => {
  const owner = useOwner();
  const request = useMemo(
    () => Option.getOrNull(decodeFragment(decodeURIComponent(hash.replace(/^#/u, '')))),
    [hash],
  );
  const [pairing, pair] = useAtom(pairAtom(request?.id ?? ''));
  const code = latest(useAtomValue(pairingCodeAtom(request?.publicKey ?? '')));
  const [expiresAt, setExpiresAt] = useState<number | null | undefined>(request?.expiresAt ?? null);

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
          The terminal picks this up by itself. It can read and write every project now, and each
          one you make from here on.
        </p>
        <Link to="/service-accounts" className={buttonStyles({ intent: 'primary' })}>
          See service accounts
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-[34rem] space-y-5">
      <div>
        <h1 className="text-xl">Approve this login?</h1>
        <p className="mt-2 text-muted">
          A terminal ran <Code>baymutt login</Code> and asks to join{' '}
          <span className="text-foreground">{owner.accountName}</span>.
        </p>
      </div>
      <div className="rounded-panel border border-line bg-surface px-5 py-4 sm:px-6">
        <p className="text-sm text-muted">It calls itself</p>
        <p className="mt-0.5 font-medium">{request.name}</p>
        {request.description !== undefined && (
          <p className="mt-1 text-sm [overflow-wrap:anywhere]">“{request.description}”</p>
        )}
        <p className="mt-2 text-sm text-muted">
          Its own words, from the link: the code below is what proves which key you approve.
        </p>
      </div>
      <div className="rounded-panel border border-line bg-surface px-5 py-5 sm:px-6">
        <Code aria-live="polite" className="block text-xl font-medium tracking-[0.14em]">
          {code ?? '····-····'}
        </Code>
        <p className="mt-2 text-sm text-muted">This must match the code in the terminal.</p>
      </div>
      <p>
        Approving lets it <strong className="font-medium">read and write every project</strong> in
        this account, now and later, and make service accounts for any of them. What it reads stays
        read, even after you revoke it.
      </p>
      <ExpiryField
        kept={request.expiresAt ?? null}
        keptLabel={at => `As the terminal asked: ${expiryLabel(at)}`}
        onChange={setExpiresAt}
      />
      <Notice tone="warn">
        If the codes differ, or you did not run <Code>baymutt login</Code> yourself, this link
        carries someone else’s key. Do not approve it.
      </Notice>
      {failureMessage(pairing) && <Notice>{failureMessage(pairing)}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button
          intent="primary"
          disabled={pairing.waiting || code === null || expiresAt === undefined}
          onClick={() => {
            if (expiresAt !== undefined) pair({ owner, request, expiresAt });
          }}
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
