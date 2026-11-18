import { CheckIcon, CopyIcon, EyeIcon, EyeSlashIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCopied } from './command-line.tsx';
import { IconButton } from './icon-button.tsx';

/** A revealed value hides itself again this long after it was revealed. */
const REVEAL_MS = 30_000;

const OPEN_FAILED = "Couldn't open this value. Try again.";
const COPY_REFUSED = 'This browser refused the clipboard. Reveal it to select it.';

type Shown =
  | { readonly kind: 'sealed' }
  | { readonly kind: 'opening' }
  | { readonly kind: 'revealed'; readonly value: string };

/**
 * One secret's value in its row: sealed or revealed, its Reveal/Hide and Copy, and the error of
 * either. A revealed value hides again after 30 seconds, at once when the tab is hidden, when the
 * row leaves the page, and when `version` changes; nothing is read again by itself. Render its
 * three parts with `SecretValue`, `SecretValueActions` and the row's `error`.
 */
export const useSecretValue = ({
  name,
  version,
  open,
}: {
  readonly name: string;
  /** The current version: a change hides a revealed value. */
  readonly version: number;
  /** Opens the current value in this browser; Activity records it. */
  readonly open: () => Promise<string>;
}) => {
  const [shown, setShown] = useState<Shown>({ kind: 'sealed' });
  const [error, setError] = useState<string | null>(null);
  const [isCopying, setCopying] = useState(false);
  const { isCopied, copy } = useCopied();
  const isRevealed = shown.kind === 'revealed';

  // The reveal in flight. Anything that hides the value moves it on, so a value that opens after
  // its row was hidden, or for a version since replaced, is dropped and never shown.
  const attempt = useRef(0);
  const seal = useCallback(() => {
    attempt.current += 1;
    setShown({ kind: 'sealed' });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version is the reason to hide.
  useEffect(seal, [seal, version]);

  useEffect(() => {
    const hideWhenHidden = () => {
      if (document.visibilityState === 'hidden') seal();
    };
    document.addEventListener('visibilitychange', hideWhenHidden);
    return () => document.removeEventListener('visibilitychange', hideWhenHidden);
  }, [seal]);

  useEffect(() => {
    if (!isRevealed) return;
    const timer = setTimeout(seal, REVEAL_MS);
    return () => clearTimeout(timer);
  }, [isRevealed, seal]);

  const reveal = async () => {
    setError(null);
    attempt.current += 1;
    const mine = attempt.current;
    setShown({ kind: 'opening' });
    try {
      const value = await open();
      if (attempt.current === mine) setShown({ kind: 'revealed', value });
    } catch {
      if (attempt.current !== mine) return;
      setShown({ kind: 'sealed' });
      setError(OPEN_FAILED);
    }
  };

  const copyValue = async () => {
    setError(null);
    if (shown.kind === 'revealed') {
      if (!(await copy(shown.value))) setError(COPY_REFUSED);
      return;
    }
    setCopying(true);
    const opening = open();
    const isTaken = await copy(opening);
    setCopying(false);
    if (isTaken) return;
    const hasOpened = await opening.then(
      () => true,
      () => false,
    );
    setError(hasOpened ? COPY_REFUSED : OPEN_FAILED);
  };

  return {
    name,
    shown,
    error,
    isCopied,
    isCopying,
    reveal: () => void reveal(),
    hide: seal,
    copy: () => void copyValue(),
  };
};

type SecretValueState = ReturnType<typeof useSecretValue>;

/** `.secret-value`: ten muted dots named "Value hidden", or the value as typed, in one place. */
export const SecretValue = ({ state }: { readonly state: SecretValueState }) => (
  <div className="secret-value">
    {state.shown.kind === 'revealed' ? (
      <span className="value">{state.shown.value}</span>
    ) : (
      <span className="mask" role="img" aria-label="Value hidden">
        ••••••••••
      </span>
    )}
  </div>
);

/**
 * `.acts`: Reveal or Hide, then Copy, each an icon with its tooltip. Copy turns to Check in
 * `accent` for two seconds and announces "DATABASE_URL copied".
 */
export const SecretValueActions = ({ state }: { readonly state: SecretValueState }) => {
  const { name, shown, isCopied, isCopying } = state;
  return (
    <div className="acts">
      {shown.kind === 'revealed' ? (
        <IconButton
          label={`Hide ${name}`}
          tooltip="Hide"
          icon={<EyeSlashIcon aria-hidden="true" className="gl" />}
          onClick={state.hide}
        />
      ) : (
        <IconButton
          label={`Reveal ${name}`}
          tooltip={shown.kind === 'opening' ? 'Revealing…' : 'Reveal'}
          disabled={shown.kind === 'opening'}
          icon={<EyeIcon aria-hidden="true" className="gl" />}
          onClick={state.reveal}
        />
      )}
      <IconButton
        label={`Copy ${name}`}
        tooltip={(() => {
          if (isCopied) return 'Copied';
          if (isCopying) return 'Copying…';
          return 'Copy';
        })()}
        disabled={isCopying}
        isCopied={isCopied}
        icon={
          isCopied ? (
            <CheckIcon aria-hidden="true" className="gl" />
          ) : (
            <CopyIcon aria-hidden="true" className="gl" />
          )
        }
        onClick={state.copy}
      />
      <span role="status" className="visually-hidden">
        {isCopied ? `${name} copied` : ''}
      </span>
    </div>
  );
};
