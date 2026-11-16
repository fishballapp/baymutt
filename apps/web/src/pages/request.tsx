// The page `baymutt ask access` links to: one request, approved or rejected here. What the terminal
// claims (the reason, the command) is shown as its words; the owner changes only when the key ends.
import type { Request } from '@baymutt/api';
import { useAtom, useAtomValue } from '@effect/atom-react';
import { Link } from '@tanstack/react-router';
import * as Option from 'effect/Option';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { type ReactNode, useState } from 'react';
import { useOwner } from '../components/gate.tsx';
import {
  Claim,
  Code,
  grantWords,
  Notice,
  Row,
  Rows,
  Skeleton,
  Time,
} from '../components/parts.tsx';
import { Button, buttonStyles } from '../components/ui/button.tsx';
import { SelectField } from '../components/ui/field.tsx';
import {
  addressOf,
  approveRequestAtom,
  type OpenedRequest,
  rejectRequestAtom,
  requestAtom,
} from '../lib/data.ts';
import { durationWords, exactTime, expiryWords } from '../lib/format.ts';
import { failureMessage, latest } from '../lib/result.ts';

const MINUTE_MS = 60_000;

/** The ends the owner may pick, besides what was asked for and no end. */
const LIFETIMES = [15 * MINUTE_MS, 60 * MINUTE_MS, 24 * 60 * MINUTE_MS] as const;

/** A lifetime in milliseconds as a select's value, or `never`. */
type Choice = 'never' | `${number}`;

const choiceOf = (lifetime: number | null): Choice => (lifetime === null ? 'never' : `${lifetime}`);

/** A page that is not the decision: an answered or missing request, or the answer just given. */
const Outcome = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
  <div className="max-w-[34rem] space-y-4">
    <h1 className="text-xl">{title}</h1>
    {children}
    <Link to="/service-accounts" className={buttonStyles()}>
      See service accounts
    </Link>
  </div>
);

/**
 * The answer just given on this page, if any. The page reads it, not the decision: once given,
 * the request reads as answered and the decision is gone.
 */
const justAnswered = ({
  request,
  approving,
  rejecting,
}: {
  readonly request: OpenedRequest;
  readonly approving: AsyncResult.AsyncResult<Request, unknown>;
  readonly rejecting: AsyncResult.AsyncResult<Request, unknown>;
}): ReactNode => {
  if (AsyncResult.isSuccess(approving) && approving.value.id === request.id) {
    return (
      <Outcome title="Approved">
        <p className="text-muted">
          The terminal picks up its key by itself. It{' '}
          {expiryWords(approving.value.expiresAt, Date.now())}.
        </p>
      </Outcome>
    );
  }
  if (AsyncResult.isSuccess(rejecting) && rejecting.value.id === request.id) {
    return (
      <Outcome title="Rejected">
        <p className="text-muted">Its key holds nothing and no longer works.</p>
      </Outcome>
    );
  }
  return null;
};

const Decision = ({ request }: { readonly request: OpenedRequest }) => {
  const owner = useOwner();
  const [approving, approve] = useAtom(approveRequestAtom(request.id));
  const [rejecting, reject] = useAtom(rejectRequestAtom(request.id));
  const isUnopened = request.items.some(item => item.openedEnvironmentName === null);
  const [choice, setChoice] = useState<Choice>(choiceOf(request.lifetime));
  const isBusy = approving.waiting || rejecting.waiting;
  const choices: ReadonlyArray<Choice> = [
    ...new Set<Choice>([
      ...LIFETIMES.map(choiceOf),
      ...(request.lifetime === null ? [] : [choiceOf(request.lifetime)]),
    ]),
  ]
    .toSorted((a, b) => Number(a) - Number(b))
    .concat('never');

  return (
    <div className="max-w-[34rem] space-y-5">
      <div>
        <h1 className="text-xl">Approve this request?</h1>
        <p className="mt-2 text-muted">
          The CLI login <span className="font-medium text-foreground">{request.maker.name}</span>{' '}
          asks for a key it calls “{request.name}”, <Time at={request.createdAt} />.
        </p>
      </div>
      <Claim label="Why">
        <p>“{request.reason}”</p>
      </Claim>
      <div>
        <h2 className="mb-2 text-md">What the key reaches</h2>
        <Rows>
          {request.items.map(item => (
            <Row key={item.environmentId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Code className="min-w-0 flex-1 font-medium">
                {addressOf({ orgSlug: item.orgSlug, name: item.openedEnvironmentName })}
              </Code>
              <span className="text-sm">{grantWords(item)}</span>
            </Row>
          ))}
        </Rows>
      </div>
      {request.command !== null && (
        <Claim label="Its key is piped into">
          <Code className="block rounded-control border border-line bg-sunken px-3 py-1.5">
            {request.command}
          </Code>
        </Claim>
      )}
      <div className="w-full sm:w-72">
        <SelectField
          label="Ends"
          value={choice}
          onChange={event => setChoice(event.target.value as Choice)}
        >
          {choices.map(option => (
            <option key={option} value={option}>
              {option === 'never' ? 'Never' : `${durationWords(Number(option))} after approval`}
              {option === choiceOf(request.lifetime) && ', as asked'}
            </option>
          ))}
        </SelectField>
      </div>
      <p>
        What its key reads stays read after it ends or you revoke it.
        {choice === 'never' && ' With no end, it works until you revoke it.'}
      </p>
      {isUnopened && (
        <Notice tone="warn">
          An environment’s name does not open with your vault, so this request cannot be approved.
        </Notice>
      )}
      {(failureMessage(approving) ?? failureMessage(rejecting)) && (
        <Notice>{failureMessage(approving) ?? failureMessage(rejecting)}</Notice>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          intent="primary"
          disabled={isBusy || isUnopened}
          onClick={() =>
            approve({
              owner,
              request,
              expiresAt: choice === 'never' ? null : Date.now() + Number(choice),
            })
          }
        >
          {approving.waiting ? 'Approving…' : 'Approve'}
        </Button>
        <Button disabled={isBusy} onClick={() => reject(request.id)}>
          {rejecting.waiting ? 'Rejecting…' : 'Reject'}
        </Button>
      </div>
    </div>
  );
};

const OUTCOME_TITLES = {
  approved: 'Already approved',
  rejected: 'Already rejected',
  expired: 'This request expired',
} as const;

export const RequestPage = ({ id }: { readonly id: string }) => {
  const result = useAtomValue(requestAtom(useOwner())(id));
  const approving = useAtomValue(approveRequestAtom(id));
  const rejecting = useAtomValue(rejectRequestAtom(id));
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
            Open the whole link <Code>baymutt ask access</Code> printed.
          </p>
        </Outcome>
      );
    }
    const failure = failureMessage(result);
    return failure === null ? <Skeleton rows={4} /> : <Notice>{failure}</Notice>;
  }
  const answered = justAnswered({ request, approving, rejecting });
  if (answered !== null) return answered;
  if (request.status === 'pending') return <Decision request={request} />;
  return (
    <Outcome title={OUTCOME_TITLES[request.status]}>
      <p className="text-muted">
        {request.maker.name} asked for it, and{' '}
        {request.status === 'expired'
          ? 'nobody answered within an hour'
          : `it was ${request.status}`}
        {request.resolvedAt !== null && `: ${exactTime(request.resolvedAt)}`}.
      </p>
    </Outcome>
  );
};
