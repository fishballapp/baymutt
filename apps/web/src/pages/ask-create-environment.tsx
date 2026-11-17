// The page `baymutt ask create-environment` links to: one environment request, approved here by
// creating the environment, or rejected. The name is opened with the org's names key; one that
// does not open is never shown as a name, and cannot be created.
import { useAtom, useAtomValue } from '@effect/atom-react';
import { Link } from '@tanstack/react-router';
import * as Option from 'effect/Option';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import type { ReactNode } from 'react';
import { useOwner } from '../components/gate.tsx';
import { Claim, Code, Notice, Skeleton, Time } from '../components/parts.tsx';
import { Button, buttonStyles } from '../components/ui/button.tsx';
import {
  addressOf,
  approveEnvironmentRequestAtom,
  environmentRequestAtom,
  type OpenedEnvironmentRequest,
  rejectEnvironmentRequestAtom,
} from '../lib/data.ts';
import { exactTime } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

/** A page that is not the decision: an answered or missing request, or the answer just given. */
const Outcome = ({
  title,
  children,
  action = (
    <Link to="/environments" className={buttonStyles()}>
      See environments
    </Link>
  ),
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) => (
  <div className="max-w-[34rem] space-y-4">
    <h1 className="text-xl">{title}</h1>
    {children}
    {action}
  </div>
);

/**
 * The answer just given on this page, if any. The page reads it, not the decision: once given,
 * the request reads as answered and the decision is gone.
 */
const justAnswered = ({
  request,
  creating,
  rejecting,
}: {
  readonly request: OpenedEnvironmentRequest;
  readonly creating: AsyncResult.AsyncResult<{ readonly id: string }, unknown>;
  readonly rejecting: AsyncResult.AsyncResult<{ readonly id: string }, unknown>;
}): ReactNode => {
  const address = addressOf({ orgSlug: request.orgSlug, name: request.openedName });
  if (AsyncResult.isSuccess(creating) && creating.value.id === request.id) {
    return (
      <Outcome
        title="Created"
        action={
          <Link to="/environments/$id" params={{ id: request.id }} className={buttonStyles()}>
            Open {address}
          </Link>
        }
      >
        <p className="text-muted">
          No key reaches <Code className="text-foreground">{address}</Code> until you approve a
          request that names it.
        </p>
      </Outcome>
    );
  }
  if (AsyncResult.isSuccess(rejecting) && rejecting.value.id === request.id) {
    return (
      <Outcome title="Rejected">
        <p className="text-muted">Nothing was created.</p>
      </Outcome>
    );
  }
  return null;
};

const Decision = ({ request }: { readonly request: OpenedEnvironmentRequest }) => {
  const [creating, create] = useAtom(approveEnvironmentRequestAtom(request.id));
  const [rejecting, reject] = useAtom(rejectEnvironmentRequestAtom(request.id));
  const owner = useOwner();
  const isBusy = creating.waiting || rejecting.waiting;
  const address = addressOf({ orgSlug: request.orgSlug, name: request.openedName });

  return (
    <div className="max-w-[34rem] space-y-5">
      <div>
        <h1 className="text-xl">Create this environment?</h1>
        <p className="mt-2 text-muted">
          The CLI login{' '}
          <span className="font-medium text-foreground">{request.createdBy.name}</span> asks for a
          new environment, <Time at={request.createdAt} />.
        </p>
      </div>
      <Code className="block text-md font-medium [overflow-wrap:anywhere]">{address}</Code>
      <Claim label="Why">
        <p>“{request.reason}”</p>
      </Claim>
      <p>Creating it gives no one access to it.</p>
      {request.openedName === null && (
        <Notice tone="warn">
          This name does not open with your vault, so it cannot be created.
        </Notice>
      )}
      {(failureMessage(creating) ?? failureMessage(rejecting)) && (
        <Notice>{failureMessage(creating) ?? failureMessage(rejecting)}</Notice>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          intent="primary"
          disabled={isBusy || request.openedName === null}
          onClick={() => create({ owner, request })}
        >
          {creating.waiting ? 'Creating…' : 'Create environment'}
        </Button>
        <Button disabled={isBusy} onClick={() => reject(request.id)}>
          {rejecting.waiting ? 'Rejecting…' : 'Reject'}
        </Button>
      </div>
    </div>
  );
};

const OUTCOME_TITLES = {
  approved: 'Already created',
  rejected: 'Already rejected',
  expired: 'This request expired',
} as const;

export const AskCreateEnvironmentPage = ({ id }: { readonly id: string }) => {
  const result = useAtomValue(environmentRequestAtom(useOwner())(id));
  const creating = useAtomValue(approveEnvironmentRequestAtom(id));
  const rejecting = useAtomValue(rejectEnvironmentRequestAtom(id));
  const request = latest(result);
  if (request === null) {
    const isMissing = AsyncResult.isFailure(result)
      ? Option.match(AsyncResult.error(result), {
          onNone: () => false,
          onSome: error => error._tag === 'NotFoundError',
        })
      : false;
    if (isMissing) {
      return (
        <Outcome title="No request at this link">
          <p className="text-muted">
            Open the whole link <Code>baymutt ask create-environment</Code> printed.
          </p>
        </Outcome>
      );
    }
    const failure = failureMessage(result);
    return failure === null ? <Skeleton rows={4} /> : <Notice>{failure}</Notice>;
  }
  const answered = justAnswered({ request, creating, rejecting });
  if (answered !== null) return answered;
  if (request.status === 'pending') return <Decision request={request} />;
  return (
    <Outcome title={OUTCOME_TITLES[request.status]}>
      <p className="text-muted">
        {request.createdBy.name} asked for{' '}
        <Code className="text-foreground">
          {addressOf({ orgSlug: request.orgSlug, name: request.openedName })}
        </Code>
        , and{' '}
        {request.status === 'expired'
          ? 'nobody answered within an hour'
          : `it was ${request.status === 'approved' ? 'created' : 'rejected'}`}
        {request.resolvedAt !== null && `: ${exactTime(request.resolvedAt)}`}.
      </p>
    </Outcome>
  );
};
