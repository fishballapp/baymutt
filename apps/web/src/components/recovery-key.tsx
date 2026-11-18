import { useState } from 'react';
import { useTitle } from './shell.tsx';
import { Button } from './ui/button.tsx';
import { useCopied } from './ui/command-line.tsx';
import { Checkbox } from './ui/field.tsx';

/**
 * Shown once, as an entry page's parts (its `h1` first). The owner cannot go on until they say
 * they have kept it. Copying is a step they must take, so it is a word, and its result a sentence.
 */
export const RecoveryKey = ({
  recoveryKey,
  onDone,
}: {
  readonly recoveryKey: string;
  readonly onDone: () => void;
}) => {
  useTitle('Keep your recovery key');
  const [isKept, setIsKept] = useState(false);
  const [isTaken, setIsTaken] = useState<boolean | null>(null);
  const { copy } = useCopied();
  return (
    <>
      <h1>Keep your recovery key</h1>
      <p className="entry-lede">
        If you lose every passkey and your password, this key is the only way back into your vault.
        baymutt cannot read your secrets, so it cannot reset them for you. Keep it in a password
        manager or on paper, away from this browser.
      </p>
      <p className="entry-key code-big">{recoveryKey}</p>
      <div className="entry-body">
        <p>
          <Button kind="quiet" onClick={async () => setIsTaken(await copy(recoveryKey))}>
            Copy key
          </Button>
        </p>
        {isTaken === true && (
          <p role="status" className="t-small muted">
            Copied. Paste it somewhere safe, then clear your clipboard.
          </p>
        )}
        {isTaken === false && (
          <p role="alert" className="error">
            This browser would not copy it. Select the key and copy it yourself.
          </p>
        )}
        <p className="warn">It is shown once. Leaving this page without it cannot be undone.</p>
        <Checkbox
          label="I have kept the recovery key somewhere I can find it without this browser."
          checked={isKept}
          onCheckedChange={setIsKept}
        />
        <Button kind="primary" size="lg" isWide disabled={!isKept} onClick={onDone}>
          Continue
        </Button>
      </div>
    </>
  );
};
