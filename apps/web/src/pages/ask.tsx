// The page `baymutt ask` links to: one ask, a reason and ordered steps, each decided whole here.
// Who asks and why, an outline of the steps, then one step open; answering it opens the next that
// can be answered. Everything a step makes is made in this browser (data.ts: `approveStepAtom`).

import { Button as BaseButton } from '@base-ui/react/button';
import type { Ask } from '@baymutt/api';
import { MAX_NOTE_BYTES } from '@baymutt/keys';
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { Link } from '@tanstack/react-router';
import * as Exit from 'effect/Exit';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  askState,
  expiresAtOf,
  type Lifetime,
  lifetimeOf,
  lifetimeOptions,
} from '../components/decision/ask.tsx';
import {
  AskWords,
  blockedWords,
  KeyEnd,
  makersOf,
  makesOf,
  StepGrants,
  thenOf,
  waitsOf,
} from '../components/decision/ask-step.tsx';
import { DecisionColumn, DecisionLoading, Outcome } from '../components/decision/frame.tsx';
import { ExactTime, Vouch } from '../components/decision/parts.tsx';
import { useOwner } from '../components/gate.tsx';
import { useOrg } from '../components/org-scope.tsx';
import { useTitle } from '../components/shell.tsx';
import { Button, buttonClass } from '../components/ui/button.tsx';
import { TextField } from '../components/ui/field.tsx';
import { RelativeTime } from '../components/ui/page.tsx';
import { Select } from '../components/ui/select.tsx';
import { Code } from '../components/ui/text.tsx';
import {
  approveLabel,
  type Blocked,
  nextFocus,
  statusWord,
  stepsWords,
  stepTitle,
} from '../lib/asks.ts';
import {
  approveStepAtom,
  askAtom,
  type OpenedAsk,
  type OpenedAskStep,
  rejectStepAtom,
} from '../lib/data.ts';
import { expiryWords } from '../lib/format.ts';
import { failureMessage } from '../lib/result.ts';

/**
 * Why a pending step is blocked: the store says something it needs is gone, a name it
 * shows does not open here, or a value it proposes did not open as its login's.
 */
const blockedOf = (step: OpenedAskStep): Blocked => {
  if (step.status !== 'pending') return null;
  if (step.canOnlyReject) return 'gone';
  const names = (() => {
    if (step.type === 'access') return step.read.map(item => item.openedEnvironmentName);
    if (step.type === 'change') {
      return [...step.read, ...step.giveBack].map(item => item.openedEnvironmentName);
    }
    if (step.type === 'environments') return step.items.map(item => item.openedEnvironmentName);
    return step.items.flatMap(item => [item.openedEnvironmentName, item.openedName]);
  })();
  if (names.includes(null)) return 'unopened';
  if (
    step.type === 'secrets' &&
    step.items.some(item => item.op === 'set' && item.proposed === null)
  ) {
    return 'unverified';
  }
  return null;
};

/** Ends on a key step: as asked, another length, never; on a change also its end as it is. */
type End = 'as-it-is' | Lifetime;

const askedEnd = (step: OpenedAskStep): End | null => {
  if (step.type !== 'access' && step.type !== 'change') return null;
  if (step.end === 'keep') return 'as-it-is';
  return step.end === 'never' ? 'never' : lifetimeOf(step.end);
};

/** What the owner has typed and chosen on a step, kept while focus moves and through a refusal. */
type Draft = {
  /** By the item's place in the step. */
  readonly pasted: ReadonlyMap<number, string>;
  /** Null while the note field is closed. */
  readonly note: string | null;
  readonly end: End | null;
};

const EMPTY_DRAFT: Draft = { pasted: new Map(), note: null, end: null };

const noteBytes = (note: string) => new TextEncoder().encode(note).length;

/** How an answered step reads in place of its answer: its word, when, what followed, the note. */
const Decided = ({
  ask,
  step,
  sentNote,
}: {
  readonly ask: OpenedAsk;
  readonly step: OpenedAskStep;
  readonly sentNote: string | undefined;
}) => {
  const after = (() => {
    if (step.status === 'applied') {
      return ' This step only gave access back, which needs no approval.';
    }
    if (step.status !== 'approved') return null;
    if (step.type === 'access') {
      return (
        <>
          {' '}
          The key <KeyEnd expiresAt={step.key.expiresAt} />.
        </>
      );
    }
    if (step.type === 'change') {
      return (
        <>
          {' '}
          The key <KeyEnd expiresAt={step.key.expiresAt} />.
        </>
      );
    }
    return null;
  })();
  const said = (() => {
    if (sentNote !== undefined && sentNote !== '') return `Your note: “${sentNote}”`;
    if (step.note !== null) return `You sent a note to ${ask.maker.name}.`;
    return null;
  })();
  return (
    <>
      <p className="step-status">
        {step.resolvedAt === null ? (
          <>
            <b>{statusWord(step)}</b>.
          </>
        ) : (
          <>
            <b>{statusWord(step)}</b> <RelativeTime at={step.resolvedAt} />.
          </>
        )}
        {after}
      </p>
      {said !== null && <p className="step-said">{said}</p>}
    </>
  );
};

/**
 * The step in focus, open to answer: what it names, its end for a key, then one row with Approve
 * (worded for the step), Reject and the note toggle, the store's refusal under it, and why Approve is
 * closed or what stays after.
 */
const OpenStep = ({
  ask,
  step,
  draft,
  onDraft,
  onAnswered,
}: {
  readonly ask: OpenedAsk;
  readonly step: OpenedAskStep;
  readonly draft: Draft;
  readonly onDraft: (draft: Draft) => void;
  readonly onAnswered: (answered: Ask, note: string) => void;
}) => {
  const owner = useOwner();
  const atomKey = `${ask.id}/${step.index}`;
  const approving = useAtomValue(approveStepAtom(atomKey));
  const rejecting = useAtomValue(rejectStepAtom(atomKey));
  const approve = useAtomSet(approveStepAtom(atomKey), { mode: 'promiseExit' });
  const reject = useAtomSet(rejectStepAtom(atomKey), { mode: 'promiseExit' });
  const makers = makersOf(ask);
  const blocked = blockedOf(step);
  const isBlocked = blocked !== null;
  const asked = askedEnd(step);
  const end = draft.end ?? asked;
  const note = draft.note ?? '';
  const isNoteTooLong = noteBytes(note) > MAX_NOTE_BYTES;
  const isBusy = approving.waiting || rejecting.waiting;
  const waits = isBlocked ? null : waitsOf({ ask, step, makers, pasted: draft.pasted });
  const { label, working, isDanger } = approveLabel(step);
  const makes = isBlocked ? null : makesOf(step, ask.maker.name);
  const then =
    isBlocked || waits !== null
      ? null
      : thenOf(step, {
          isNever: end === 'never',
          givesBackAll:
            step.type === 'change' &&
            step.holds.length > 0 &&
            step.holds.every(held =>
              step.giveBack.some(({ environmentId }) => environmentId === held.environmentId),
            ),
        });
  const answered = (exit: Exit.Exit<Ask, unknown>) => {
    if (Exit.isSuccess(exit)) onAnswered(exit.value, note);
  };
  return (
    <>
      <StepGrants
        ask={ask}
        step={step}
        makers={makers}
        isOnly={ask.steps.length === 1}
        answer={{
          pasted: draft.pasted,
          onPaste: (position, value) =>
            onDraft({ ...draft, pasted: new Map(draft.pasted).set(position, value) }),
          isBlocked,
        }}
      />
      {makes !== null && <p className="makes">{makes}</p>}
      {end !== null && (step.type === 'access' || step.type === 'change') && (
        <Select<End>
          label="Ends"
          labelPlacement="beside"
          value={end}
          onValueChange={chosen => onDraft({ ...draft, end: chosen })}
          isDisabled={isBlocked}
          options={[
            ...(step.type === 'change'
              ? [
                  {
                    value: 'as-it-is' as const,
                    label: `Keep as it is: ${expiryWords(step.key.expiresAt, Date.now())}`,
                  },
                ]
              : []),
            ...lifetimeOptions(asked === 'as-it-is' ? null : asked),
          ]}
        />
      )}
      {blocked !== null && (
        <p className="warnline">{blockedWords({ ask, step, makers, blocked })}</p>
      )}
      <div className="step-answer">
        {!isBlocked && (
          <Button
            size="lg"
            kind={isDanger ? 'danger' : 'primary'}
            disabled={isBusy || waits !== null || isNoteTooLong}
            isPending={approving.waiting}
            pendingLabel={working}
            onClick={async () => {
              const expiresAt = (() => {
                if (end === null) return undefined;
                if (end === 'as-it-is') return undefined;
                return expiresAtOf(end, Date.now());
              })();
              answered(
                await approve({
                  owner,
                  ask,
                  index: step.index,
                  note,
                  pasted: draft.pasted,
                  expiresAt,
                }),
              );
            }}
          >
            {label}
          </Button>
        )}
        <Button
          size="lg"
          disabled={isBusy || isNoteTooLong}
          isPending={rejecting.waiting}
          pendingLabel="Rejecting…"
          onClick={async () => answered(await reject({ owner, ask, index: step.index, note }))}
        >
          Reject
        </Button>
        {draft.note === null && (
          <Button kind="quiet" disabled={isBusy} onClick={() => onDraft({ ...draft, note: '' })}>
            Add a note
          </Button>
        )}
      </div>
      {(() => {
        const failure = failureMessage(approving) ?? failureMessage(rejecting);
        return (
          failure !== null && (
            <p className="error" role="alert">
              {failure}
            </p>
          )
        );
      })()}
      {waits !== null && <p className="then">{waits}</p>}
      {then !== null && <p className="then">{then}</p>}
      {draft.note !== null && (
        <TextField
          className="step-note"
          label={`Note to ${ask.maker.name}`}
          value={draft.note}
          onValueChange={(value: string) => onDraft({ ...draft, note: value })}
          disabled={isBusy}
          autoFocus
          hint={`Sealed in your browser to ${ask.maker.name}; baymutt cannot read it.`}
          error={
            isNoteTooLong
              ? `The note can be at most ${MAX_NOTE_BYTES.toLocaleString('en')} bytes; this is ${noteBytes(note).toLocaleString('en')} bytes.`
              : null
          }
        />
      )}
    </>
  );
};

/** The outline: every step on one line, its number, what it does and how it stands. */
const OutlineWord = ({ step }: { readonly step: OpenedAskStep }) => {
  const word = statusWord(step);
  if (word !== null) return word.toLowerCase();
  if (blockedOf(step) !== null) return <span className="warn">reject only</span>;
  if (step.waitsFor.length > 0) return `waits for ${stepsWords(step.waitsFor)}`;
  return null;
};

const AskDecision = ({ ask }: { readonly ask: OpenedAsk }) => {
  const [focus, setFocus] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<ReadonlyMap<number, Draft>>(new Map());
  const [sentNotes, setSentNotes] = useState<ReadonlyMap<number, string>>(new Map());
  // Moving focus by an answer or the outline takes keyboard focus to the step's heading.
  const [hasMoved, setMoved] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shown = focus ?? nextFocus(ask.steps, blockedOf, -1) ?? 0;
  const step = ask.steps[shown];
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new step in focus is the reason to move.
  useEffect(() => {
    if (hasMoved) headingRef.current?.focus();
  }, [shown, hasMoved]);
  if (step === undefined) return <DecisionLoading />;
  const isOne = ask.steps.length === 1;
  const moveTo = (index: number) => {
    setFocus(index);
    setMoved(true);
  };
  const onAnswered = (answered: Ask, note: string) => {
    setSentNotes(new Map(sentNotes).set(step.index, note));
    const after = ask.steps.map(each => {
      const fresh = answered.steps[each.index];
      return fresh === undefined
        ? each
        : {
            ...each,
            status: fresh.status,
            waitsFor: fresh.waitsFor,
            canOnlyReject: fresh.canOnlyReject,
          };
    });
    const next = nextFocus(after, blockedOf, step.index);
    if (next !== null) moveTo(next);
  };
  const expires = (
    <RelativeTime at={ask.expiresAt}>{() => expiryWords(ask.expiresAt, Date.now())}</RelativeTime>
  );
  const body =
    step.status === 'pending' ? (
      <OpenStep
        key={step.index}
        ask={ask}
        step={step}
        draft={drafts.get(step.index) ?? EMPTY_DRAFT}
        onDraft={draft => setDrafts(new Map(drafts).set(step.index, draft))}
        onAnswered={onAnswered}
      />
    ) : (
      <>
        <StepGrants
          ask={ask}
          step={step}
          makers={makersOf(ask)}
          answer={null}
          isOnly={ask.steps.length === 1}
        />
        <Decided ask={ask} step={step} sentNote={sentNotes.get(step.index)} />
      </>
    );
  if (isOne) {
    return (
      <DecisionColumn>
        <p className="ask">
          <AskWords ask={ask} />
        </p>
        <h1 className="claim">“{ask.reason}”</h1>
        {step.reason !== null && <p className="claim-sub">“{step.reason}”</p>}
        {body}
        <Vouch askedAt={ask.createdAt} maker={ask.maker}>
          This ask {expires}.
        </Vouch>
      </DecisionColumn>
    );
  }
  return (
    <DecisionColumn>
      <p className="ask">
        <AskWords ask={ask} />
      </p>
      <h1 className="claim">“{ask.reason}”</h1>
      <Vouch askedAt={ask.createdAt} maker={ask.maker}>
        This ask {expires}.
      </Vouch>
      <ol className="outline" aria-label="Steps of this ask">
        {ask.steps.map(each => (
          <li key={each.index}>
            <BaseButton
              className="outline-item"
              aria-current={each.index === shown ? 'step' : undefined}
              onClick={() => moveTo(each.index)}
            >
              <span className="num">{each.index + 1}</span>
              <span className="t">{stepTitle(each)}</span>
              <span className="outline-word t-small">
                <OutlineWord step={each} />
              </span>
            </BaseButton>
          </li>
        ))}
      </ol>
      <section className="step" aria-labelledby={`step-${step.index}`}>
        <h2 id={`step-${step.index}`} ref={headingRef} tabIndex={-1}>
          <span className="muted num">{step.index + 1}</span> {stepTitle(step)}
        </h2>
        {step.reason !== null && <p className="claim-sub">“{step.reason}”</p>}
        {body}
      </section>
    </DecisionColumn>
  );
};

/** An answered ask's outline: each step's result on its line, the note this page sent under it. */
const Results = ({ ask }: { readonly ask: OpenedAsk }) => (
  <ol className="outline">
    {ask.steps.map(step => (
      <li key={step.index}>
        <span className="outline-item">
          <span className="num">{step.index + 1}</span>
          <span className="t">{stepTitle(step)}</span>
          <span className="outline-word t-small">{statusWord(step)?.toLowerCase()}</span>
        </span>
      </li>
    ))}
  </ol>
);

const SeeAsks = () => (
  <Link
    to="/orgs/$slug/asks"
    params={{ slug: useOrg().slug }}
    className={buttonClass({ size: 'lg' })}
  >
    See asks
  </Link>
);

/** The ask once no step waits: answered, expired, or withdrawn by the agent. */
const answeredScreen = (ask: OpenedAsk): { readonly title: string; readonly body: ReactNode } => {
  const unanswered = (status: OpenedAskStep['status']) =>
    ask.steps.filter(step => step.status === status).map(({ index }) => index);
  const outcome = (title: string, sentence: ReactNode) => ({
    title,
    body: (
      <DecisionColumn isOutcome>
        <h1>{title}</h1>
        <p>{sentence}</p>
        <Results ask={ask} />
        <SeeAsks />
      </DecisionColumn>
    ),
  });
  const withdrawn = unanswered('cancelled');
  if (withdrawn.length > 0) {
    return outcome(
      'Ask withdrawn',
      (() => {
        const which = stepsWords(withdrawn);
        const one = withdrawn.length === 1;
        if (ask.cancelledAt === null) {
          return one ? (
            <>
              {ask.maker.name} withdrew {which}. Earlier approvals still apply.
            </>
          ) : (
            <>
              {ask.maker.name} withdrew {which}. Earlier approvals still apply.
            </>
          );
        }
        const at = <ExactTime at={ask.cancelledAt} />;
        return one ? (
          <>
            {ask.maker.name} withdrew it before {which} was answered: {at}.
          </>
        ) : (
          <>
            {ask.maker.name} withdrew it before {which} were answered: {at}.
          </>
        );
      })(),
    );
  }
  const expired = unanswered('expired');
  if (expired.length > 0) {
    return outcome(
      'Ask expired',
      `${ask.maker.name} asked for it, and nobody answered ${stepsWords(expired)} within an hour.`,
    );
  }
  return outcome(
    'Ask answered',
    `${ask.maker.name} can see your decisions. Each approved step has taken effect.`,
  );
};

export const AskPage = ({ id }: { readonly id: string }) => {
  const org = useOrg();
  const state = askState(
    useAtomValue(askAtom(useOwner())(id)),
    ({ org: { id: orgId } }) => orgId === org.id,
  );
  const screen = ((): { readonly title: string | null; readonly body: ReactNode } => {
    if (state.kind === 'loading') return { title: null, body: <DecisionLoading /> };
    if (state.kind === 'failed') {
      const title = 'Could not open ask';
      return {
        title,
        body: (
          <Outcome title={title} tone="danger" action={<SeeAsks />}>
            {state.message}
          </Outcome>
        ),
      };
    }
    if (state.kind === 'missing') {
      const title = 'Ask not found';
      return {
        title,
        body: (
          <Outcome title={title} action={<SeeAsks />}>
            Check the link, or ask the agent to send it again with <Code>baymutt ask</Code>.
          </Outcome>
        ),
      };
    }
    const ask = state.ask;
    if (!ask.steps.some(({ status }) => status === 'pending')) return answeredScreen(ask);
    const [only] = ask.steps;
    const title = (() => {
      if (ask.steps.length > 1 || only === undefined) return `Ask: ${ask.reason}`;
      if (only.type === 'access') return `New key: ${only.key.name}`;
      return stepTitle(only);
    })();
    return { title, body: <AskDecision ask={ask} /> };
  })();
  useTitle(screen.title, org.name);
  return screen.body;
};
