/** Which fields of a printed object to show: a name, or a name and what to show inside it. */
export type Shown = readonly (string | readonly [string, Shown])[];

/**
 * One line of a terminal transcript: what was typed and by whom, what went to a person, what went
 * to a parser, and a note on what happened off screen (never something the CLI prints).
 */
export type TerminalLine =
  | { readonly kind: 'command'; readonly by: 'you' | 'agent'; readonly text: string }
  | {
      readonly kind: 'stderr';
      readonly text: string;
      readonly isClipped?: boolean;
      /** A part of the line marked as the same thing elsewhere on the page (a pairing code). */
      readonly match?: string;
    }
  | {
      readonly kind: 'stdout';
      readonly value: Readonly<Record<string, unknown>>;
      /** Print only these fields, and an ellipsis for each run of the rest. */
      readonly only?: Shown;
    }
  | { readonly kind: 'note'; readonly text: string };
