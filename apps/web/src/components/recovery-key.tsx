import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useCopy } from '../lib/clipboard.ts';
import { Code, Notice } from './parts.tsx';
import { Button } from './ui/button.tsx';

const COPIED_NOTE = {
  idle: '',
  copied: 'Copied. Paste it somewhere safe, then clear your clipboard.',
  failed: 'This browser would not copy it. Select the key and copy it yourself.',
} as const;

/** Shown once. The owner cannot go on until they say they have kept it. */
export const RecoveryKey = ({
  recoveryKey,
  onDone,
}: {
  readonly recoveryKey: string;
  readonly onDone: () => void;
}) => {
  const [isKept, setIsKept] = useState(false);
  const [copied, copy] = useCopy(recoveryKey);
  return (
    <div className="max-w-[34rem]">
      <h1 className="text-xl leading-tight">Keep your recovery key</h1>
      <p className="mt-2 text-muted">
        If you lose every passkey, this key is the only way back into your vault. baymutt cannot
        read your secrets, so it cannot reset them for you. Keep it in a password manager or on
        paper, away from this browser.
      </p>
      <div className="mt-6 rounded-panel border border-line bg-sunken">
        <Code className="block px-4 pt-4 pb-3 text-md leading-8 tracking-wide select-all">
          {recoveryKey}
        </Code>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-line border-t px-2 py-2">
          <Button size="sm" intent="subtle" onClick={copy}>
            {copied === 'copied' ? (
              <CheckIcon aria-hidden="true" className="size-4 text-accent" />
            ) : (
              <CopyIcon aria-hidden="true" className="size-4 text-muted" />
            )}
            Copy key
          </Button>
          <span aria-live="polite" className="text-sm text-muted">
            {COPIED_NOTE[copied]}
          </span>
        </div>
      </div>
      <Notice tone="warn" className="mt-4">
        It is shown once. Leaving this page without it cannot be undone.
      </Notice>
      <label className="mt-6 flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={isKept}
          onChange={event => setIsKept(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-accent"
        />
        <span>I have kept the recovery key somewhere I can find it without this browser.</span>
      </label>
      <Button
        intent="primary"
        className="mt-5 w-full sm:w-auto"
        disabled={!isKept}
        onClick={onDone}
      >
        Continue
      </Button>
    </div>
  );
};
