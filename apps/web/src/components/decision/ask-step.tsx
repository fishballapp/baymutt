// What one step of an ask names, in `.grants`, and the sentences around its answer: what approving
// makes, what stays after, and why it waits or is blocked. The page (pages/ask.tsx)
// composes these around the step's answer.

import type { Ask } from '@baymutt/api';
import { EyeIcon, EyeSlashIcon } from '@phosphor-icons/react';
import { Fragment, type ReactNode } from 'react';
import { type Blocked, isValueItem, stepsWords, stepTitle } from '../../lib/asks.ts';
import type { OpenedAsk, OpenedAskStep, OpenedSecretItem } from '../../lib/data.ts';
import { bytes, expiryWords } from '../../lib/format.ts';
import { Field, TextArea } from '../ui/field.tsx';
import { IconButton } from '../ui/icon-button.tsx';
import { RelativeTime } from '../ui/page.tsx';
import { useSecretValue } from '../ui/secret-value.tsx';
import { Address, Code, SealedName } from '../ui/text.tsx';

type Step<T extends OpenedAskStep['type']> = Extract<OpenedAskStep, { readonly type: T }>;

/** Who asks, and for what when the ask is one step: the ask's first line, and an Asks row's. */
export const AskWords = ({ ask }: { readonly ask: OpenedAsk | Ask }) => {
  const maker = <b>{ask.maker.name}</b>;
  const [only] = ask.steps;
  if (ask.steps.length > 1 || only === undefined) {
    return (
      <>
        {maker} asks you to decide {ask.steps.length} steps
      </>
    );
  }
  if (only.type === 'access') {
    return (
      <>
        {maker} asks for a new key, <b>{only.key.name}</b>
      </>
    );
  }
  if (only.type === 'change') {
    return (
      <>
        {only.key.intent === 'service-account' ? (
          <>
            {maker} asks to change the service account <b>{only.key.name}</b>
          </>
        ) : (
          <>
            {maker} asks to change the agent key <b>{only.key.name}</b>
          </>
        )}
      </>
    );
  }
  const title = stepTitle(only);
  return (
    <>
      {only.type === 'environments' ? (
        <>
          {maker} asks to {title.charAt(0).toLowerCase()}
          {title.slice(1)}
        </>
      ) : (
        <>
          {maker} asks to {title.charAt(0).toLowerCase()}
          {title.slice(1)}
        </>
      )}
    </>
  );
};

/** The step of the ask that creates or restores each environment, by environment id. */
export const makersOf = (ask: OpenedAsk): ReadonlyMap<string, Step<'environments'>> =>
  new Map(
    ask.steps.flatMap(step =>
      step.type === 'environments'
        ? step.items.filter(({ op }) => op !== 'delete').map(item => [item.environmentId, step])
        : [],
    ),
  );

/**
 * What an environment a step names says beside it, by the earlier step that makes it: "step 1
 * creates it" while that waits, "step 1 was rejected" once it will not exist. Nothing otherwise.
 */
const madeBy = (
  makers: ReadonlyMap<string, Step<'environments'>>,
  step: OpenedAskStep,
  environmentId: string,
): string | null => {
  const maker = makers.get(environmentId);
  if (maker === undefined || maker.index >= step.index) return null;
  const which = stepsWords([maker.index]);
  const restores = maker.items.some(
    item => item.environmentId === environmentId && item.op === 'restore',
  );
  if (maker.status === 'pending') {
    return restores ? `${which} restores it` : `${which} creates it`;
  }
  const lost = LOST[maker.status];
  return lost === null ? null : lost(which);
};

/** How an earlier step that makes an environment went, when it will not exist. */
const LOST = {
  pending: null,
  approved: null,
  applied: null,
  rejected: (which: string) => `${which} was rejected`,
  expired: (which: string) => `${which} expired`,
  cancelled: (which: string) => `${which} was withdrawn`,
} as const satisfies Record<OpenedAskStep['status'], ((which: string) => string) | null>;

/** A step being answered: what the owner pasted so far, by the item's place, and how to paste more. */
export type Answering = {
  readonly pasted: ReadonlyMap<number, string>;
  readonly onPaste: (position: number, value: string) => void;
  /** It is blocked: nothing is pasted. */
  readonly isBlocked: boolean;
};

type Named = { readonly environmentId: string; readonly openedEnvironmentName: string | null };

const EnvironmentLine = ({
  orgSlug,
  item,
  children,
}: {
  readonly orgSlug: string;
  readonly item: Named;
  readonly children?: ReactNode;
}) => (
  <li>
    <Address orgSlug={orgSlug} name={item.openedEnvironmentName} />
    {children !== undefined && children !== null && <span className="muted">{children}</span>}
  </li>
);

/** A value the agent proposes: masked with its size and Reveal, or revealed on a line of its own. */
const ProposedLine = ({
  name,
  value,
}: {
  readonly name: string | null;
  readonly value: string;
}) => {
  const label = name ?? 'secret';
  const state = useSecretValue({ name: label, version: 0, open: () => Promise.resolve(value) });
  const size = <span>{bytes(new TextEncoder().encode(value).length)}</span>;
  if (state.shown.kind === 'revealed') {
    return (
      <li className="field">
        <span className="line">
          <SealedName name={name} />
          <span className="line-value muted">
            {size}
            <IconButton
              label={`Hide proposed value for ${label}`}
              tooltip="Hide"
              icon={<EyeSlashIcon aria-hidden="true" className="gl" />}
              onClick={state.hide}
            />
          </span>
        </span>
        <span className="secret-value">
          <span className="value">{state.shown.value}</span>
        </span>
      </li>
    );
  }
  return (
    <li>
      <SealedName name={name} />
      <span className="line-value muted">
        <span className="mask" role="img" aria-label="Value hidden">
          ••••••••••
        </span>
        {size}
        <IconButton
          label={`Reveal proposed value for ${label}`}
          tooltip="Reveal"
          icon={<EyeIcon aria-hidden="true" className="gl" />}
          onClick={state.reveal}
        />
      </span>
    </li>
  );
};

/** What happens to a secret that is not given a value here. */
const OP_WORDS = {
  generate: 'generate a value',
  delete: 'delete',
  restore: 'restore',
} as const;

/** What a value of an answered step was to be, where the step no longer shows it or a field. */
const DECIDED_WORDS = {
  set: 'proposed value',
  paste: 'paste a value',
} as const;

const SecretLine = ({
  item,
  position,
  answer,
}: {
  readonly item: OpenedSecretItem;
  readonly position: number;
  readonly answer: Answering | null;
}) => {
  if ((item.op === 'set' || item.op === 'paste') && answer === null) {
    return (
      <li>
        <SealedName name={item.openedName} />
        <span className="muted">{DECIDED_WORDS[item.op]}</span>
      </li>
    );
  }
  if (item.op === 'set') {
    if (item.proposed === null) {
      return (
        <li>
          <SealedName name={item.openedName} />
          <span className="warn">Proposed value could not be verified</span>
        </li>
      );
    }
    return <ProposedLine name={item.openedName} value={item.proposed} />;
  }
  if (item.op === 'paste') {
    return (
      <Field
        isListItem
        labelClassName="line"
        label={
          <>
            <SealedName name={item.openedName} />
            <span className="muted">paste a value</span>
          </>
        }
        hint={(() => {
          if (item.openedHint !== null) return `Where to find it: ${item.openedHint}`;
          if (item.sealedHint === null) return undefined;
          return <span className="warn">Where to find it could not be verified</span>;
        })()}
      >
        <TextArea
          rows={1}
          value={answer?.pasted.get(position) ?? ''}
          onValueChange={value => answer?.onPaste(position, value)}
          disabled={answer?.isBlocked ?? true}
        />
      </Field>
    );
  }
  return (
    <li>
      <SealedName name={item.openedName} />
      <span className="muted">
        {item.op === 'rollback' ? `roll back to version ${item.version}` : OP_WORDS[item.op]}
      </span>
    </li>
  );
};

/** What an environments step does to each environment, when its items do different things. */
const ENVIRONMENT_OP_WORDS = {
  create: 'create',
  delete: 'delete',
  restore: 'restore',
} as const;

/**
 * `.grants` for one step: the environments it names, under the headings its type has, each with
 * what an earlier step does to it; for secrets, each secret under its environment, with a value
 * to see, to paste, or what happens to it.
 */
export const StepGrants = ({
  ask,
  step,
  makers,
  answer,
  isOnly,
}: {
  readonly ask: OpenedAsk;
  readonly step: OpenedAskStep;
  readonly makers: ReadonlyMap<string, Step<'environments'>>;
  /** Null for a step already answered: its values show as what they were to be. */
  readonly answer: Answering | null;
  /** The ask's only step, which reads as a decision of its own: a key's reads as "read" lines. */
  readonly isOnly: boolean;
}) => {
  const orgSlug = ask.org.slug;
  const mark = (environmentId: string) => madeBy(makers, step, environmentId);
  if (step.type === 'environments') {
    const isMixed = new Set(step.items.map(({ op }) => op)).size > 1;
    return (
      <div className="grants">
        <ul>
          {step.items.map(item => (
            <EnvironmentLine key={item.environmentId} orgSlug={orgSlug} item={item}>
              {isMixed ? ENVIRONMENT_OP_WORDS[item.op] : null}
            </EnvironmentLine>
          ))}
        </ul>
      </div>
    );
  }
  if (step.type === 'access') {
    return (
      <div className="grants">
        {!isOnly && <h3>Read</h3>}
        <ul>
          {step.read.map(item => (
            <EnvironmentLine key={item.environmentId} orgSlug={orgSlug} item={item}>
              {isOnly ? 'read' : mark(item.environmentId)}
            </EnvironmentLine>
          ))}
        </ul>
      </div>
    );
  }
  if (step.type === 'change') {
    return (
      <div className="grants">
        <h3>Already reads</h3>
        <ul>
          {step.holds.length === 0 ? (
            <li className="muted">No environments</li>
          ) : (
            step.holds.map(held => (
              <EnvironmentLine key={held.environmentId} orgSlug={orgSlug} item={held} />
            ))
          )}
        </ul>
        {step.read.length > 0 && (
          <>
            <h3>Add read access</h3>
            <ul>
              {step.read.map(item => (
                <EnvironmentLine key={item.environmentId} orgSlug={orgSlug} item={item}>
                  {mark(item.environmentId)}
                </EnvironmentLine>
              ))}
            </ul>
          </>
        )}
        {step.giveBack.length > 0 && (
          <>
            <h3>Give back access</h3>
            <ul>
              {step.giveBack.map(item => (
                <EnvironmentLine key={item.environmentId} orgSlug={orgSlug} item={item} />
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }
  const groups = Map.groupBy(
    step.items.map((item, position) => ({ item, position })),
    ({ item }) => item.environmentId,
  );
  return (
    <div className="grants">
      {[...groups].map(([environmentId, lines]) => {
        const [first] = lines;
        if (first === undefined) return null;
        const said = mark(environmentId);
        return (
          <Fragment key={environmentId}>
            <h3>
              <Address orgSlug={orgSlug} name={first.item.openedEnvironmentName} />
              {said !== null && <span className="muted"> {said}</span>}
            </h3>
            <ul>
              {lines.map(({ item, position }) => (
                <SecretLine key={item.name} item={item} position={position} answer={answer} />
              ))}
            </ul>
          </Fragment>
        );
      })}
    </div>
  );
};

/** `.makes`: what approving makes or does, when that is not already plain from the step. */
export const makesOf = (step: OpenedAskStep, makerName: string): ReactNode => {
  if (step.type === 'access') {
    if (step.command === null) {
      return <>The new key will be given to {makerName}. It can only read.</>;
    }
    return (
      <>
        The new service account key can only read. Once approved, it is piped into{' '}
        <Code>{step.command}</Code>; it is never shown or kept in a file.
      </>
    );
  }
  if (step.type === 'change') {
    return 'The key will have the access shown when you approve this step.';
  }
  if (step.type === 'secrets') {
    return step.items.some(isValueItem)
      ? 'Values are sealed in your browser. baymutt cannot read them.'
      : null;
  }
  const count = (op: Step<'environments'>['items'][number]['op']) =>
    step.items.filter(item => item.op === op).length;
  const one = step.items.length === 1;
  return (
    [
      count('create') > 0 &&
        (one
          ? 'The environment is created as soon as you approve.'
          : 'The environments are created as soon as you approve.'),
      count('delete') > 0 &&
        (one
          ? 'The environment goes to the bin for 30 days.'
          : 'Deleted environments go to the bin for 30 days.'),
    ]
      .filter(Boolean)
      .join(' ') || null
  );
};

/** `.then` once the step can be approved: what stays after it. */
export const thenOf = (
  step: OpenedAskStep,
  { isNever, givesBackAll }: { readonly isNever: boolean; readonly givesBackAll: boolean },
): string | null => {
  const never = isNever ? ' This key never expires.' : '';
  if (step.type === 'access') {
    return `The key can read these environments until it ends. A value already read cannot be unread.${never}`;
  }
  if (step.type !== 'change') return null;
  return [
    step.read.length > 0
      ? 'The key can read the added environments until it ends.'
      : 'It gains nothing.',
    givesBackAll && ' It will have no environments.',
    never,
    ' Rejecting leaves the key exactly as it is.',
  ]
    .filter(Boolean)
    .join('');
};

/** "the value is pasted", "both values are pasted", "all 3 values are pasted". */
const pastedWords = (count: number) => {
  if (count === 1) return 'the value is pasted';
  if (count === 2) return 'both values are pasted';
  return `all ${count} values are pasted`;
};

/**
 * Why Approve is closed while the step waits: for the earlier step that makes what it names,
 * then for the values still to paste. Null when nothing holds it.
 */
export const waitsOf = ({
  ask,
  step,
  makers,
  pasted,
}: {
  readonly ask: OpenedAsk;
  readonly step: OpenedAskStep;
  readonly makers: ReadonlyMap<string, Step<'environments'>>;
  readonly pasted: ReadonlyMap<number, string>;
}): ReactNode => {
  const pastes = step.type === 'secrets' ? step.items.filter(({ op }) => op === 'paste').length : 0;
  const isMissingPaste =
    step.type === 'secrets' &&
    step.items.some((item, position) => item.op === 'paste' && (pasted.get(position) ?? '') === '');
  const waits = step.waitsFor;
  if (waits.length === 0 && !isMissingPaste) return null;
  if (waits.length === 0) return `You can approve when ${pastedWords(pastes)}.`;
  const which = stepsWords(waits);
  if (isMissingPaste) {
    return waits.length === 1
      ? `You can approve when ${which} is approved and ${pastedWords(pastes)}.`
      : `You can approve when ${which} are approved and ${pastedWords(pastes)}.`;
  }
  const [waited] = waits;
  const made = [...makers]
    .filter(([, maker]) => waits.length === 1 && maker.index === waited)
    .map(([environmentId, maker]) => ({
      environmentId,
      name: maker.items.find(item => item.environmentId === environmentId)?.openedEnvironmentName,
      op: maker.items.find(item => item.environmentId === environmentId)?.op,
    }))
    .filter(({ environmentId }) => namesOf(step).includes(environmentId));
  const [only] = made;
  if (made.length !== 1 || only === undefined || only.name === undefined) {
    return waits.length === 1
      ? `You can approve when ${which} is approved.`
      : `You can approve when ${which} are approved.`;
  }
  const address = <Address orgSlug={ask.org.slug} name={only.name} />;
  return only.op === 'restore' ? (
    <>
      You can approve when {which} restores {address}.
    </>
  ) : (
    <>
      You can approve when {which} creates {address}.
    </>
  );
};

/** Every environment a step names, by id. */
const namesOf = (step: OpenedAskStep): ReadonlyArray<string> => {
  if (step.type === 'access') return step.read.map(({ environmentId }) => environmentId);
  if (step.type === 'change') {
    return [...step.read, ...step.giveBack].map(({ environmentId }) => environmentId);
  }
  return step.items.map(({ environmentId }) => environmentId);
};

/** `.warnline`: why a step is blocked. */
export const blockedWords = ({
  ask,
  step,
  makers,
  blocked,
}: {
  readonly ask: OpenedAsk;
  readonly step: OpenedAskStep;
  readonly makers: ReadonlyMap<string, Step<'environments'>>;
  readonly blocked: Exclude<Blocked, null>;
}): ReactNode => {
  if (blocked === 'unopened') {
    return 'A name could not be opened by your vault. This step can only be rejected.';
  }
  if (blocked === 'unverified') {
    return `Your vault could not verify that the proposed value came from ${ask.maker.name}. This step can only be rejected.`;
  }
  const lost = namesOf(step).flatMap(environmentId => {
    const maker = makers.get(environmentId);
    const status = maker === undefined || maker.index >= step.index ? null : maker.status;
    if (
      maker === undefined ||
      (status !== 'rejected' && status !== 'expired' && status !== 'cancelled')
    ) {
      return [];
    }
    const name = maker.items.find(item => item.environmentId === environmentId);
    return [{ maker, status, name: name?.openedEnvironmentName ?? null }];
  })[0];
  if (lost !== undefined) {
    const n = lost.maker.index + 1;
    const address = <Address orgSlug={ask.org.slug} name={lost.name} />;
    if (lost.status === 'rejected') {
      return (
        <>
          Step {n} was rejected, so {address} is unavailable. This step can only be rejected.
        </>
      );
    }
    if (lost.status === 'expired') {
      return (
        <>
          Step {n} expired, so {address} is unavailable. This step can only be rejected.
        </>
      );
    }
    return (
      <>
        Step {n} was withdrawn, so {address} is unavailable. This step can only be rejected.
      </>
    );
  }
  if (step.type === 'change' && step.key.expiresAt !== null && step.key.expiresAt <= Date.now()) {
    return `${step.key.name} has ended. This step can only be rejected.`;
  }
  return 'Something this step needs is no longer available. This step can only be rejected.';
};

/** When a key an approved step made or changed now ends, as the sentence after "Approved". */
export const KeyEnd = ({ expiresAt }: { readonly expiresAt: number | null }) =>
  expiresAt === null ? (
    'never expires'
  ) : (
    <RelativeTime at={expiresAt}>{() => expiryWords(expiresAt, Date.now())}</RelativeTime>
  );
