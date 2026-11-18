// The page `baymutt ask access` links to: one request, approved or rejected here. What the terminal
// claims (the reason, the command) is shown as its words; the owner changes only when the key ends.
import { useAtom, useAtomValue } from '@effect/atom-react';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { type ReactNode, useState } from 'react';
import {
  askState,
  expiresAtOf,
  type Lifetime,
  lifetimeOf,
  lifetimeOptions,
  SeeKeys,
} from '../components/decision/ask.tsx';
import { DecisionColumn, DecisionLoading, Outcome } from '../components/decision/frame.tsx';
import { Answer, ExactTime, Grant, Vouch } from '../components/decision/parts.tsx';
import { useOwner } from '../components/gate.tsx';
import { useOrg } from '../components/org-scope.tsx';
import { useTitle } from '../components/shell.tsx';
import { Button } from '../components/ui/button.tsx';
import { Select } from '../components/ui/select.tsx';
import { AccessWords, Code } from '../components/ui/text.tsx';
import {
  approveRequestAtom,
  type OpenedRequest,
  rejectRequestAtom,
  requestAtom,
} from '../lib/data.ts';
import { expiryWords } from '../lib/format.ts';
import { failureMessage } from '../lib/result.ts';

/** "read and write", "read" or "write": everything the request asks for, across its environments. */
const askedWords = (items: OpenedRequest['items']): string => {
  const canRead = items.some(item => item.canRead);
  const canWrite = items.some(item => item.canWrite);
  if (canRead && canWrite) return 'read and write';
  return canWrite ? 'write' : 'read';
};

const Decision = ({ request }: { readonly request: OpenedRequest }) => {
  const owner = useOwner();
  const [approving, approve] = useAtom(approveRequestAtom(request.id));
  const [rejecting, reject] = useAtom(rejectRequestAtom(request.id));
  const asked = request.lifetime === null ? 'never' : lifetimeOf(request.lifetime);
  const [lifetime, setLifetime] = useState<Lifetime>(asked);
  const isBlocked = request.items.some(item => item.openedEnvironmentName === null);
  const isBusy = approving.waiting || rejecting.waiting;
  return (
    <DecisionColumn>
      <p className="ask">
        <b>{request.maker.name}</b> asks for a key it calls <b>{request.name}</b>
      </p>
      <h1 className="claim">“{request.reason}”</h1>
      <div className="grants">
        <ul>
          {request.items.map(item => (
            <Grant key={item.environmentId} item={item}>
              <AccessWords canRead={item.canRead} canWrite={item.canWrite} />
            </Grant>
          ))}
        </ul>
      </div>
      <p className="makes">
        {request.command === null ? (
          <>Approving makes an agent key, kept in a file on {request.maker.name}.</>
        ) : (
          <>
            Approving makes a service account. Its key goes into <Code>{request.command}</Code> and
            is never shown.
          </>
        )}
      </p>
      <Select
        label="Ends"
        labelPlacement="beside"
        value={lifetime}
        onValueChange={setLifetime}
        options={lifetimeOptions(asked)}
      />
      {isBlocked && (
        <p className="warnline">
          An environment’s name does not open with your vault, so this request cannot be approved.
        </p>
      )}
      <Answer error={failureMessage(approving) ?? failureMessage(rejecting)}>
        <Button
          size="lg"
          disabled={isBusy}
          isPending={rejecting.waiting}
          pendingLabel="Rejecting…"
          onClick={() => reject(request.id)}
        >
          Reject
        </Button>
        <Button
          size="lg"
          kind="primary"
          disabled={isBusy || isBlocked}
          isPending={approving.waiting}
          pendingLabel="Approving…"
          onClick={() => approve({ owner, request, expiresAt: expiresAtOf(lifetime, Date.now()) })}
        >
          Approve {askedWords(request.items)}
        </Button>
      </Answer>
      {!isBlocked && (
        <p className="then">
          What it reads stays read after the key ends or you revoke it.
          {lifetime === 'never' && ' With no end, it works until you revoke it.'}
        </p>
      )}
      <Vouch askedAt={request.createdAt} maker={request.maker} />
    </DecisionColumn>
  );
};

const ANSWERED_EARLIER = {
  approved: { title: 'Already approved', words: 'it was approved' },
  rejected: { title: 'Already rejected', words: 'it was rejected' },
} as const;

export const AskAccessPage = ({ id }: { readonly id: string }) => {
  const org = useOrg();
  const state = askState(
    useAtomValue(requestAtom(useOwner())(id)),
    ({ org: { id: orgId } }) => orgId === org.id,
  );
  const approving = useAtomValue(approveRequestAtom(id));
  const rejecting = useAtomValue(rejectRequestAtom(id));
  const screen = ((): { readonly title: string | null; readonly body: ReactNode } => {
    const outcome = (title: string, sentence: ReactNode, tone?: 'danger') => ({
      title,
      body: (
        <Outcome title={title} tone={tone} action={<SeeKeys />}>
          {sentence}
        </Outcome>
      ),
    });
    if (state.kind === 'loading') return { title: null, body: <DecisionLoading /> };
    if (state.kind === 'failed') {
      return outcome('Couldn’t load this request', state.message, 'danger');
    }
    if (state.kind === 'missing') {
      return outcome(
        'No request at this link',
        <>
          Open the whole link <Code>baymutt ask access</Code> printed.
        </>,
      );
    }
    const request = state.ask;
    // The answer just given: once given, the request reads as answered and the decision is gone.
    if (AsyncResult.isSuccess(approving)) {
      return outcome(
        'Approved',
        `The terminal picks up its key by itself. It ${expiryWords(approving.value.expiresAt, Date.now())}.`,
      );
    }
    if (AsyncResult.isSuccess(rejecting)) {
      return outcome('Rejected', 'Its key holds nothing and no longer works.');
    }
    if (request.status === 'pending') {
      return { title: `Approve ${request.name}?`, body: <Decision request={request} /> };
    }
    if (request.status === 'expired') {
      return outcome(
        'This request expired',
        `${request.maker.name} asked for it, and nobody answered within an hour.`,
      );
    }
    const { title, words } = ANSWERED_EARLIER[request.status];
    return outcome(
      title,
      <>
        {request.maker.name} asked for it, and {words}
        {request.resolvedAt !== null && (
          <>
            : <ExactTime at={request.resolvedAt} />
          </>
        )}
        .
      </>,
    );
  })();
  useTitle(screen.title, org.name);
  return screen.body;
};
