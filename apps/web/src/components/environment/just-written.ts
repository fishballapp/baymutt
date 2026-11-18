import { type AnimationEvent, useEffect, useRef, useState } from 'react';

/**
 * Which rows of a list were just written: one that appeared, or whose stamp (a secret's version)
 * changed, since the list was first shown. Each flashes once (`Row isJustWritten`), and its flag
 * goes when the flash ends, so the next write flashes again. Rows present on the first load do
 * not flash.
 */
export const useJustWritten = (
  rows: ReadonlyArray<{ readonly id: string; readonly stamp: string }> | null,
) => {
  const seen = useRef<ReadonlyMap<string, string> | null>(null);
  const [written, setWritten] = useState<ReadonlySet<string>>(new Set());
  const signature = rows === null ? null : JSON.stringify(rows.map(({ id, stamp }) => [id, stamp]));

  useEffect(() => {
    if (signature === null) return;
    const current = new Map<string, string>(JSON.parse(signature));
    const previous = seen.current;
    seen.current = current;
    if (previous === null) return;
    const changed = [...current].filter(([id, stamp]) => previous.get(id) !== stamp);
    if (changed.length > 0) {
      setWritten(flagged => new Set([...flagged, ...changed.map(([id]) => id)]));
    }
  }, [signature]);

  return (id: string) => ({
    isJustWritten: written.has(id),
    onAnimationEnd: (event: AnimationEvent) => {
      // A flash of the row itself, not of something inside it.
      if (event.target !== event.currentTarget) return;
      setWritten(flagged => new Set([...flagged].filter(flaggedId => flaggedId !== id)));
    },
  });
};
