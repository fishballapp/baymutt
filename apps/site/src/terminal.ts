/** One line of a terminal transcript: what was typed, what went to a person, what went to a parser. */
export type TerminalLine =
  | { readonly kind: 'command'; readonly text: string }
  | { readonly kind: 'stderr'; readonly text: string; readonly isClipped?: boolean }
  | {
      readonly kind: 'stdout';
      readonly value: Readonly<Record<string, unknown>>;
      /** Print only these fields, one line each, then an ellipsis for the rest. */
      readonly only?: readonly string[];
    };
