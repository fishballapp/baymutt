// The page a pairing link opens. Everything it shows comes from the link's fragment, which the
// store never received: the code is computed here from the key the terminal made. The name and
// the description are the terminal's words, shown as its claim.
import { PairingRequestSchema } from '@baymutt/api';
import { pairingCode } from '@baymutt/keys';
import { useAtom, useAtomValue } from '@effect/atom-react';
import { Link, useRouterState } from '@tanstack/react-router';
import { cn } from 'cn';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';
import * as Schema from 'effect/Schema';
import { useMemo, useState } from 'react';
import { DecisionColumn, Outcome } from '../components/decision/frame.tsx';
import { Answer } from '../components/decision/parts.tsx';
import { ExpiryField, expiryLabel } from '../components/expiry.tsx';
import { useOwner } from '../components/gate.tsx';
import { useTitle } from '../components/shell.tsx';
import { Button, buttonClass } from '../components/ui/button.tsx';
import { Code } from '../components/ui/text.tsx';
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
  const request = useMemo(() => {
    // A link cut in the middle of an escape (`%2`) is no login link, not a crash.
    const fragment = (() => {
      try {
        return decodeURIComponent(hash.replace(/^#/u, ''));
      } catch {
        return null;
      }
    })();
    return fragment === null ? null : Option.getOrNull(decodeFragment(fragment));
  }, [hash]);
  const [pairing, pair] = useAtom(pairAtom(request?.id ?? ''));
  const code = latest(useAtomValue(pairingCodeAtom(request?.publicKey ?? '')));
  const [expiresAt, setExpiresAt] = useState<number | null | undefined>(request?.expiresAt ?? null);
  const title = (() => {
    if (request === null) return 'This is not a login link';
    if (AsyncResult.isSuccess(pairing)) return `${request.name} is approved`;
    return `Approve ${request.name}?`;
  })();
  useTitle(title);

  if (request === null) {
    return (
      <Outcome title={title}>
        Run <Code>baymutt auth login</Code> on the computer and open the whole link it prints,
        including everything after the #.
      </Outcome>
    );
  }

  if (AsyncResult.isSuccess(pairing)) {
    return (
      <Outcome
        title={title}
        action={
          <Link to="/account" className={buttonClass({ size: 'lg' })}>
            See CLI logins
          </Link>
        }
      >
        The terminal picks this up by itself. Each plan it sends waits for you.
      </Outcome>
    );
  }

  return (
    <DecisionColumn>
      <p className="ask">
        A terminal ran <Code>baymutt auth login</Code> and asks to join <b>{owner.accountName}</b>’s
        account.
      </p>
      <h1 className="claim">“{request.name}”</h1>
      {request.description !== undefined && <p className="claim-sub">“{request.description}”</p>}
      <div className="pair-code">
        <span aria-live="polite" className={cn('code-big', code === null && 'pending')}>
          {code ?? '····-····'}
        </span>
        <p>This must match the code in the terminal.</p>
      </div>
      <p className="makes">
        Approving lets it <b>list the names of your orgs, environments and secrets</b>, and ask you
        for anything in a plan. It opens no value and writes none.
      </p>
      <ExpiryField
        placement="decision"
        kept={request.expiresAt ?? null}
        keptLabel={at => `As the terminal asked: ${expiryLabel(at)}`}
        onChange={setExpiresAt}
      />
      <p className="warnline">
        If the codes differ, or you did not run <Code>baymutt auth login</Code> yourself, do not
        approve it.
      </p>
      <Answer error={failureMessage(pairing)}>
        {/* A link cannot be disabled: while approving it is marked so, and the style takes the pointer. */}
        <Link
          to="/account"
          className={buttonClass({ size: 'lg' })}
          aria-disabled={pairing.waiting ? true : undefined}
          tabIndex={pairing.waiting ? -1 : undefined}
        >
          Do not approve
        </Link>
        <Button
          size="lg"
          kind="primary"
          disabled={code === null || expiresAt === undefined}
          isPending={pairing.waiting}
          pendingLabel="Approving…"
          onClick={() => {
            if (expiresAt !== undefined) pair({ owner, request, expiresAt });
          }}
        >
          The codes match: approve it
        </Button>
      </Answer>
    </DecisionColumn>
  );
};
