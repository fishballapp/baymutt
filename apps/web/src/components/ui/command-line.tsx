import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { copyWhenReady } from '../../lib/clipboard.ts';
import { IconButton } from './icon-button.tsx';

/** How long a Copy shows its Check after copying. */
const COPIED_MS = 2000;

/**
 * The state of a Copy icon: `copied` for two seconds after a copy, then back. `copy` takes the
 * text, or a promise of it (a value still opening), and answers whether the browser took it. The
 * clipboard is claimed in the click itself, so Safari still sees the user's gesture when a promised
 * text arrives.
 */
export const useCopied = () => {
  const [isCopied, setCopied] = useState(false);
  useEffect(() => {
    if (!isCopied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [isCopied]);
  const copy = async (text: string | Promise<string>): Promise<boolean> => {
    const isTaken = (await copyWhenReady(Promise.resolve(text))) === 'copied';
    setCopied(isTaken);
    return isTaken;
  };
  return { isCopied, copy };
};

/**
 * `.cmd`: `$`, the command exactly as the CLI takes it, then its Copy icon. A long command scrolls
 * sideways, except in an empty state's example, which wraps (the stylesheet does both).
 */
export const CommandLine = ({ command }: { readonly command: string }) => {
  const { isCopied, copy } = useCopied();
  return (
    <div className="cmd">
      <span className="ps" aria-hidden="true">
        $
      </span>
      <code>{command}</code>
      <IconButton
        label="Copy the command"
        tooltip={isCopied ? 'Copied' : 'Copy'}
        isCopied={isCopied}
        icon={
          isCopied ? (
            <CheckIcon aria-hidden="true" className="gl" />
          ) : (
            <CopyIcon aria-hidden="true" className="gl" />
          )
        }
        onClick={() => void copy(command)}
      />
    </div>
  );
};
