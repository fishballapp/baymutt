/** Which fields of a printed object to show: a name, or a name and what to show inside it. */
export type Shown = readonly (string | readonly [string, Shown])[];

/**
 * One line of a terminal transcript: what an agent typed, what went to a person, what went
 * to a parser, and a note on what happened off screen (never something the CLI prints).
 */
export type TerminalLine =
  | { readonly kind: 'command'; readonly text: string }
  | { readonly kind: 'stderr'; readonly text: string }
  | {
      readonly kind: 'stdout';
      readonly value: Readonly<Record<string, unknown>>;
      /** Print only these fields, and an ellipsis for each run of the rest. */
      readonly only?: Shown;
    }
  | { readonly kind: 'note'; readonly text: string };
