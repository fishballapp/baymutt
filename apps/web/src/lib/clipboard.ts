/**
 * Copies text that is still on its way. The clipboard is claimed in the click itself, so a browser
 * that wants the user's gesture (Safari) still has it when the text arrives.
 */
export const copyWhenReady = async (text: Promise<string>): Promise<'copied' | 'failed'> => {
  const blob = text.then(value => new Blob([value], { type: 'text/plain' }));
  // The clipboard can refuse before the text settles; a later failure of the text is the caller's
  // to report (it awaits `text` itself), not an unhandled rejection here.
  blob.catch(() => undefined);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    return 'copied';
  } catch {
    return 'failed';
  }
};
