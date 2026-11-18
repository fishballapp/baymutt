// The page `baymutt ask create-environment` links to: one environment request, approved here by
// creating the environment, or rejected. The name is opened with the org's names key; one that
// does not open is never shown as a name, and cannot be created.
import { useAtom, useAtomValue } from '@effect/atom-react';
import { Link } from '@tanstack/react-router';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import type { ReactNode } from 'react';
import { askState, SeeEnvironments } from '../components/decision/ask.tsx';
import { DecisionColumn, DecisionLoading, Outcome } from '../components/decision/frame.tsx';
import { Answer, ExactTime, Grant, Vouch } from '../components/decision/parts.tsx';
import { useOwner } from '../components/gate.tsx';
import { useOrg } from '../components/org-scope.tsx';
import { useTitle } from '../components/shell.tsx';
import { Button, buttonClass } from '../components/ui/button.tsx';
import { Address, Code } from '../components/ui/text.tsx';
import {
  addressOf,
  approveEnvironmentRequestAtom,
  environmentRequestAtom,
  type OpenedEnvironmentRequest,
  rejectEnvironmentRequestAtom,
} from '../lib/data.ts';
import { failureMessage } from '../lib/result.ts';

const Decision = ({ request }: { readonly request: OpenedEnvironmentRequest }) => {
  const owner = useOwner();
  const [creating, create] = useAtom(approveEnvironmentRequestAtom(request.id));
  const [rejecting, reject] = useAtom(rejectEnvironmentRequestAtom(request.id));
  const isBlocked = request.openedName === null;
  const isBusy = creating.waiting || rejecting.waiting;
  return (
    <DecisionColumn>
      <p className="ask">
        <b>{request.createdBy.name}</b> asks you to create an environment
      </p>
      <h1 className="claim">“{request.reason}”</h1>
      <div className="grants">
        <ul>
          <Grant item={{ orgSlug: request.orgSlug, openedEnvironmentName: request.openedName }} />
        </ul>
      </div>
      <p className="makes">Creating it gives no one access to it.</p>
      {isBlocked && (
        <p className="warnline">
          This name does not open with your vault, so it cannot be created.
        </p>
      )}
      <Answer error={failureMessage(creating) ?? failureMessage(rejecting)}>
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
          isPending={creating.waiting}
          pendingLabel="Creating…"
          onClick={() => create({ owner, request })}
        >
          Create environment
        </Button>
      </Answer>
      <Vouch askedAt={request.createdAt} maker={request.createdBy} />
    </DecisionColumn>
  );
};

const ANSWERED_EARLIER = {
  approved: { title: 'Already created', words: 'it was created' },
  rejected: { title: 'Already rejected', words: 'it was rejected' },
} as const;

export const AskCreateEnvironmentPage = ({ id }: { readonly id: string }) => {
  const org = useOrg();
  const state = askState(
    useAtomValue(environmentRequestAtom(useOwner())(id)),
    ({ orgId }) => orgId === org.id,
  );
  const creating = useAtomValue(approveEnvironmentRequestAtom(id));
  const rejecting = useAtomValue(rejectEnvironmentRequestAtom(id));
  const screen = ((): { readonly title: string | null; readonly body: ReactNode } => {
    const outcome = (
      title: string,
      sentence: ReactNode,
      { tone, action = <SeeEnvironments /> }: { tone?: 'danger'; action?: ReactNode } = {},
    ) => ({
      title,
      body: (
        <Outcome title={title} tone={tone} action={action}>
          {sentence}
        </Outcome>
      ),
    });
    if (state.kind === 'loading') return { title: null, body: <DecisionLoading /> };
    if (state.kind === 'failed') {
      return outcome('Couldn’t load this request', state.message, { tone: 'danger' });
    }
    if (state.kind === 'missing') {
      return outcome(
        'No request at this link',
        <>
          Open the whole link <Code>baymutt ask create-environment</Code> printed.
        </>,
      );
    }
    const request = state.ask;
    const address = <Address orgSlug={request.orgSlug} name={request.openedName} />;
    // The answer just given: once given, the request reads as answered and the decision is gone.
    if (AsyncResult.isSuccess(creating)) {
      return outcome(
        'Created',
        <>No key reaches {address} until you approve a request that names it.</>,
        {
          action: (
            <Link
              to="/orgs/$slug/environments/$id"
              params={{ slug: request.orgSlug, id: request.id }}
              className={buttonClass({ size: 'lg' })}
            >
              <span className="t">
                Open {addressOf({ orgSlug: request.orgSlug, name: request.openedName })}
              </span>
            </Link>
          ),
        },
      );
    }
    if (AsyncResult.isSuccess(rejecting)) return outcome('Rejected', 'Nothing was created.');
    if (request.status === 'pending') {
      return {
        title: `Create ${addressOf({ orgSlug: request.orgSlug, name: request.openedName })}?`,
        body: <Decision request={request} />,
      };
    }
    if (request.status === 'expired') {
      return outcome(
        'This request expired',
        <>
          {request.createdBy.name} asked for {address}, and nobody answered within an hour.
        </>,
      );
    }
    const { title, words } = ANSWERED_EARLIER[request.status];
    return outcome(
      title,
      <>
        {request.createdBy.name} asked for {address}, and {words}
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
