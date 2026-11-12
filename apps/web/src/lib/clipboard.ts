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

/**
 * Copies text that is still on its way. The clipboard is claimed in the click itself, so a browser
 * that wants the user's gesture (Safari) still has it when the text arrives.
 */
export const copyWhenReady = async (text: Promise<string>): Promise<'copied' | 'failed'> => {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': text.then(value => new Blob([value], { type: 'text/plain' })),
      }),
    ]);
    return 'copied';
  } catch {
    return 'failed';
  }
};
