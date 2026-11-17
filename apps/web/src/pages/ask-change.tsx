// The page `baymutt ask change` links to: one change to a key an agent already holds, approved or
// rejected here as a whole. It shows what the key holds now, what the change adds and what it
// gives back; the owner changes only when the key ends.
import type { KeyChange } from '@baymutt/api';
import { useAtom, useAtomValue } from '@effect/atom-react';
import { Link } from '@tanstack/react-router';
import * as Option from 'effect/Option';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { type ReactNode, useState } from 'react';
import { useOwner } from '../components/gate.tsx';
import { useOrg } from '../components/orgs.tsx';
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
  approveKeyChangeAtom,
  keyChangeAtom,
  type OpenedKeyChange,
  type OpenedRequestItem,
  rejectKeyChangeAtom,
} from '../lib/data.ts';
import { durationWords, exactTime, expiryWords } from '../lib/format.ts';
import { givesBackAll, isApprovable } from '../lib/key-changes.ts';
import { failureMessage, latest } from '../lib/result.ts';

const MINUTE_MS = 60_000;

/** The ends the owner may pick, besides keeping the key's own, what was asked for, and no end. */
const LIFETIMES = [15 * MINUTE_MS, 60 * MINUTE_MS, 24 * 60 * MINUTE_MS] as const;

/** A lifetime in milliseconds as a select's value, `keep` for the key's own end, or `never`. */
type Choice = 'keep' | 'never' | `${number}`;

const choiceOf = (lifetime: number | null): Choice => (lifetime === null ? 'keep' : `${lifetime}`);

/** A choice as its option reads. */
const choiceWords = (choice: Choice, keyExpiresAt: number | null): string => {
  if (choice === 'keep') return `As it is: ${expiryWords(keyExpiresAt, Date.now())}`;
  if (choice === 'never') return 'Never';
  return `${durationWords(Number(choice))} after approval`;
};

/** What a choice sends: undefined keeps the key's end, null is no end. */
const expiresAtOf = (choice: Choice, now: number): number | null | undefined => {
  if (choice === 'keep') return undefined;
  if (choice === 'never') return null;
  return now + Number(choice);
};

const Outcome = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
  <div className="max-w-[34rem] space-y-4">
    <h1 className="text-xl">{title}</h1>
    {children}
    <Link to="/orgs/$slug/keys" params={{ slug: useOrg().slug }} className={buttonStyles()}>
      See keys
    </Link>
  </div>
);

/** The answer just given on this page, if any: once given, the change reads as answered. */
const justAnswered = ({
  change,
  approving,
  rejecting,
}: {
  readonly change: OpenedKeyChange;
  readonly approving: AsyncResult.AsyncResult<KeyChange, unknown>;
  readonly rejecting: AsyncResult.AsyncResult<KeyChange, unknown>;
}): ReactNode => {
  if (AsyncResult.isSuccess(approving) && approving.value.id === change.id) {
    return (
      <Outcome title="Approved">
        <p className="text-muted">
          {change.key.name} holds the new set now, under the same key. It{' '}
          {expiryWords(approving.value.key.expiresAt, Date.now())}.
        </p>
      </Outcome>
    );
  }
  if (AsyncResult.isSuccess(rejecting) && rejecting.value.id === change.id) {
    return (
      <Outcome title="Rejected">
        <p className="text-muted">{change.key.name} holds what it held, and keeps working.</p>
      </Outcome>
    );
  }
  return null;
};

/** One environment as a row: its address in mono and the access the line is about. */
const EnvironmentRow = ({
  item,
  access,
}: {
  readonly item: OpenedRequestItem;
  readonly access: ReactNode;
}) => (
  <Row className="flex flex-wrap items-center gap-x-3 gap-y-1">
    <Code className="min-w-0 flex-1 font-medium">
      {addressOf({ orgSlug: item.orgSlug, name: item.openedEnvironmentName })}
    </Code>
    <span className="text-sm">{access}</span>
  </Row>
);

const Part = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
  <div>
    <h2 className="mb-2 text-md">{title}</h2>
    <Rows>{children}</Rows>
  </div>
);

const Decision = ({ change }: { readonly change: OpenedKeyChange }) => {
  const owner = useOwner();
  const [approving, approve] = useAtom(approveKeyChangeAtom(change.id));
  const [rejecting, reject] = useAtom(rejectKeyChangeAtom(change.id));
  const items = [...change.holds, ...change.add, ...change.giveBack];
  const isUnopened = items.some(item => item.openedEnvironmentName === null);
  const [choice, setChoice] = useState<Choice>(choiceOf(change.lifetime));
  const isBusy = approving.waiting || rejecting.waiting;
  const choices: ReadonlyArray<Choice> = [
    'keep',
    ...[
      ...new Set<Choice>([
        ...LIFETIMES.map(lifetime => choiceOf(lifetime)),
        ...(change.lifetime === null ? [] : [choiceOf(change.lifetime)]),
      ]),
    ].toSorted((a, b) => Number(a) - Number(b)),
    'never',
  ];
  const heldOn = (environmentId: string) =>
    change.holds.find(held => held.environmentId === environmentId);
  const isGivingBackAll = givesBackAll(change);
  const hasKeyEnded = change.key.expiresAt !== null && change.key.expiresAt <= Date.now();
  // Approve is offered only when it can work; Reject always is.
  const cannotApprove = isUnopened || !isApprovable(change, Date.now());

  return (
    <div className="max-w-[34rem] space-y-5">
      <div>
        <h1 className="text-xl">Approve this change?</h1>
        <p className="mt-2 text-muted">
          The CLI login <span className="font-medium text-foreground">{change.maker.name}</span>{' '}
          asks to change the{' '}
          {change.key.intent === 'service-account' ? 'service account' : 'agent key'}{' '}
          <span className="font-medium text-foreground">{change.key.name}</span>,{' '}
          <Time at={change.createdAt} />. It keeps the same key.
        </p>
      </div>
      <Claim label="Why">
        <p>“{change.reason}”</p>
      </Claim>
      <Part title="What it holds now">
        {change.holds.length === 0 ? (
          <Row className="text-sm text-muted">Nothing.</Row>
        ) : (
          change.holds.map(item => (
            <EnvironmentRow key={item.environmentId} item={item} access={grantWords(item)} />
          ))
        )}
      </Part>
      {change.add.length > 0 && (
        <Part title="What it adds">
          {change.add.map(item => {
            const held = heldOn(item.environmentId);
            return (
              <EnvironmentRow
                key={item.environmentId}
                item={item}
                access={
                  <>
                    + {grantWords(item)}
                    {held !== undefined && (
                      <span className="text-muted"> (holds {grantWords(held)})</span>
                    )}
                  </>
                }
              />
            );
          })}
        </Part>
      )}
      {change.giveBack.length > 0 && (
        <Part title="What it gives back">
          {change.giveBack.map(item => (
            <EnvironmentRow
              key={item.environmentId}
              item={item}
              access={<span className="text-muted">− {grantWords(item)}</span>}
            />
          ))}
        </Part>
      )}
      <div className="w-full sm:w-96">
        <SelectField
          label="Ends"
          value={choice}
          onValueChange={setChoice}
          options={choices.map(option => ({
            value: option,
            label: [
              choiceWords(option, change.key.expiresAt),
              option === choiceOf(change.lifetime) && option !== 'keep' && '(your agent’s pick)',
            ]
              .filter(Boolean)
              .join(' '),
          }))}
        />
      </div>
      <p>
        {change.add.length > 0
          ? 'What it reads stays read after it ends or you revoke it.'
          : 'It gains nothing.'}
        {isGivingBackAll && ' It gives back everything it holds.'}
        {choice === 'never' && ' With no end, it works until you revoke it.'} Rejecting leaves it as
        it is.
      </p>
      {isUnopened && (
        <Notice tone="warn">
          An environment’s name does not open with your vault, so this change cannot be approved.
        </Notice>
      )}
      {hasKeyEnded && (
        <Notice tone="warn">
          {change.key.name} has ended, so this change cannot be approved. Reject it; its CLI login
          asks for a new key.
        </Notice>
      )}
      {change.isMissingEnvironment && (
        <Notice tone="warn">
          An environment this change names was removed for good, so it cannot be approved. Reject
          it; its CLI login can ask again.
        </Notice>
      )}
      {(failureMessage(approving) ?? failureMessage(rejecting)) && (
        <Notice>{failureMessage(approving) ?? failureMessage(rejecting)}</Notice>
      )}
      <div className="flex flex-wrap gap-2">
        {!cannotApprove && (
          <Button
            intent="primary"
            disabled={isBusy}
            onClick={() =>
              approve({
                owner,
                change,
                expiresAt: expiresAtOf(choice, Date.now()),
              })
            }
          >
            {approving.waiting ? 'Approving…' : 'Approve'}
          </Button>
        )}
        <Button disabled={isBusy} onClick={() => reject(change.id)}>
          {rejecting.waiting ? 'Rejecting…' : 'Reject'}
        </Button>
      </div>
    </div>
  );
};

const OUTCOME_WORDS = {
  approved: 'it was approved',
  applied: 'it gave access back, which needs no approval',
  rejected: 'it was rejected',
  expired: 'nobody answered within an hour',
} as const;

const OUTCOME_TITLES = {
  approved: 'Already approved',
  applied: 'Already done',
  rejected: 'Already rejected',
  expired: 'This change expired',
} as const;

export const AskChangePage = ({ id }: { readonly id: string }) => {
  const result = useAtomValue(keyChangeAtom(useOwner())(id));
  const approving = useAtomValue(approveKeyChangeAtom(id));
  const rejecting = useAtomValue(rejectKeyChangeAtom(id));
  const org = useOrg();
  const found = latest(result);
  // Only an ask of the org the address names: one of another org is not at this link.
  const change = found !== null && found.org.id === org.id ? found : null;
  if (change === null) {
    const isMissing =
      found !== null ||
      (AsyncResult.isFailure(result) &&
        Option.match(AsyncResult.error(result), {
          onNone: () => false,
          onSome: error => error._tag === 'NotFoundError',
        }));
    if (isMissing) {
      return (
        <Outcome title="No change at this link">
          <p className="text-muted">
            Open the whole link <Code>baymutt ask change</Code> printed.
          </p>
        </Outcome>
      );
    }
    const failure = failureMessage(result);
    return failure === null ? <Skeleton rows={4} /> : <Notice>{failure}</Notice>;
  }
  const answered = justAnswered({ change, approving, rejecting });
  if (answered !== null) return answered;
  if (change.status === 'pending') return <Decision change={change} />;
  return (
    <Outcome title={OUTCOME_TITLES[change.status]}>
      <p className="text-muted">
        {change.maker.name} asked to change {change.key.name}, and {OUTCOME_WORDS[change.status]}
        {change.resolvedAt !== null && `: ${exactTime(change.resolvedAt)}`}.
      </p>
    </Outcome>
  );
};
