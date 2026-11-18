// The page `baymutt ask change` links to: one change to a key an agent already holds, approved or
// rejected here as a whole. It shows what the key holds now, what the change adds and what it
// gives back; the owner changes only when the key ends.
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
import { AccessWords, accessText, Code } from '../components/ui/text.tsx';
import {
  approveKeyChangeAtom,
  hasEnded,
  keyChangeAtom,
  type OpenedKeyChange,
  rejectKeyChangeAtom,
} from '../lib/data.ts';
import { expiryWords } from '../lib/format.ts';
import { givesBackAll, isApprovable } from '../lib/key-changes.ts';
import { failureMessage } from '../lib/result.ts';

/** Ends: the key's own end as it is, or a new one. */
type End = 'as-it-is' | Lifetime;

const Decision = ({ change }: { readonly change: OpenedKeyChange }) => {
  const owner = useOwner();
  const [approving, approve] = useAtom(approveKeyChangeAtom(change.id));
  const [rejecting, reject] = useAtom(rejectKeyChangeAtom(change.id));
  const asked = change.lifetime === null ? null : lifetimeOf(change.lifetime);
  const [end, setEnd] = useState<End>(asked ?? 'as-it-is');
  const now = Date.now();
  const isUnopened = [...change.holds, ...change.add, ...change.giveBack].some(
    item => item.openedEnvironmentName === null,
  );
  const isBlocked = isUnopened || !isApprovable(change, now);
  const isBusy = approving.waiting || rejecting.waiting;
  const heldOn = (environmentId: string) =>
    change.holds.find(held => held.environmentId === environmentId);
  return (
    <DecisionColumn>
      <p className="ask">
        <b>{change.maker.name}</b> asks to change the{' '}
        {change.key.intent === 'service-account' ? 'service account' : 'agent key'}{' '}
        <b>{change.key.name}</b>. It keeps the same key.
      </p>
      <h1 className="claim">“{change.reason}”</h1>
      <div className="grants">
        <h3>It holds now</h3>
        <ul>
          {change.holds.length === 0 ? (
            <li className="muted">Nothing.</li>
          ) : (
            change.holds.map(item => (
              <Grant key={item.environmentId} item={item}>
                <AccessWords canRead={item.canRead} canWrite={item.canWrite} />
              </Grant>
            ))
          )}
        </ul>
        {change.add.length > 0 && (
          <>
            <h3>It adds</h3>
            <ul>
              {change.add.map(item => {
                const held = heldOn(item.environmentId);
                return (
                  <Grant key={item.environmentId} item={item}>
                    <AccessWords canRead={item.canRead} canWrite={item.canWrite} />
                    {held !== undefined && ` (holds ${accessText(held)})`}
                  </Grant>
                );
              })}
            </ul>
          </>
        )}
        {change.giveBack.length > 0 && (
          <>
            <h3>It gives back</h3>
            <ul>
              {change.giveBack.map(item => (
                <Grant key={item.environmentId} item={item}>
                  <AccessWords canRead={item.canRead} canWrite={item.canWrite} />
                </Grant>
              ))}
            </ul>
          </>
        )}
      </div>
      <Select
        label="Ends"
        labelPlacement="beside"
        value={end}
        onValueChange={setEnd}
        isDisabled={isBlocked}
        options={[
          { value: 'as-it-is', label: `As it is: ${expiryWords(change.key.expiresAt, now)}` },
          ...lifetimeOptions(asked),
        ]}
      />
      {isUnopened && (
        <p className="warnline">
          An environment’s name does not open with your vault, so this change cannot be approved.
        </p>
      )}
      {hasEnded(change.key, now) && (
        <p className="warnline">
          {change.key.name} has ended, so this change cannot be approved. Reject it; its CLI login
          asks for a new key.
        </p>
      )}
      {change.isMissingEnvironment && (
        <p className="warnline">
          An environment this change names was removed for good, so it cannot be approved. Reject
          it; its CLI login can ask again.
        </p>
      )}
      <Answer isSingle={isBlocked} error={failureMessage(approving) ?? failureMessage(rejecting)}>
        <Button
          size="lg"
          disabled={isBusy}
          isPending={rejecting.waiting}
          pendingLabel="Rejecting…"
          onClick={() => reject(change.id)}
        >
          Reject
        </Button>
        {!isBlocked && (
          <Button
            size="lg"
            kind="primary"
            disabled={isBusy}
            isPending={approving.waiting}
            pendingLabel="Approving…"
            onClick={() =>
              approve({
                owner,
                change,
                expiresAt: end === 'as-it-is' ? undefined : expiresAtOf(end, Date.now()),
              })
            }
          >
            Approve the change
          </Button>
        )}
      </Answer>
      {!isBlocked && (
        <p className="then">
          {change.add.length > 0
            ? 'What it reads stays read after it ends or you revoke it.'
            : 'It gains nothing.'}
          {givesBackAll(change) && ' It gives back everything it holds.'}
          {end === 'never' && ' With no end, it works until you revoke it.'} Rejecting leaves it as
          it is.
        </p>
      )}
      <Vouch askedAt={change.createdAt} maker={change.maker} />
    </DecisionColumn>
  );
};

const ANSWERED_EARLIER = {
  approved: { title: 'Already approved', words: 'it was approved' },
  applied: { title: 'Already done', words: 'it gave access back, which needs no approval' },
  rejected: { title: 'Already rejected', words: 'it was rejected' },
} as const;

export const AskChangePage = ({ id }: { readonly id: string }) => {
  const org = useOrg();
  const state = askState(
    useAtomValue(keyChangeAtom(useOwner())(id)),
    ({ org: { id: orgId } }) => orgId === org.id,
  );
  const approving = useAtomValue(approveKeyChangeAtom(id));
  const rejecting = useAtomValue(rejectKeyChangeAtom(id));
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
      return outcome('Couldn’t load this change', state.message, 'danger');
    }
    if (state.kind === 'missing') {
      return outcome(
        'No change at this link',
        <>
          Open the whole link <Code>baymutt ask change</Code> printed.
        </>,
      );
    }
    const change = state.ask;
    const keyName = change.key.name;
    // The answer just given: once given, the change reads as answered and the decision is gone.
    if (AsyncResult.isSuccess(approving)) {
      return outcome(
        'Approved',
        `${keyName} holds the new set now, under the same key. It ${expiryWords(approving.value.key.expiresAt, Date.now())}.`,
      );
    }
    if (AsyncResult.isSuccess(rejecting)) {
      return outcome(
        'Rejected',
        hasEnded(change.key, Date.now())
          ? `Nothing changed. ${keyName} has ended and no longer works.`
          : `${keyName} holds what it held, and keeps working.`,
      );
    }
    if (change.status === 'pending') {
      return { title: `Change ${keyName}?`, body: <Decision change={change} /> };
    }
    if (change.status === 'expired') {
      return outcome(
        'This change expired',
        `${change.maker.name} asked to change ${keyName}, and nobody answered within an hour.`,
      );
    }
    const { title, words } = ANSWERED_EARLIER[change.status];
    return outcome(
      title,
      <>
        {change.maker.name} asked to change {keyName}, and {words}
        {change.resolvedAt !== null && (
          <>
            : <ExactTime at={change.resolvedAt} />
          </>
        )}
        .
      </>,
    );
  })();
  useTitle(screen.title, org.name);
  return screen.body;
};
