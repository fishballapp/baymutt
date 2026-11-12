import { useState } from 'react';

/**
 * Copies `text` and remembers how that went, so the button can say so. A browser that refuses
 * (no permission, an insecure origin) answers `failed`, and the text stays there to select.
 */
export const useCopy = (text: string) => {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  return [state, copy] as const;
};
