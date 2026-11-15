// What the CLI prints on stdout is `JSON.stringify(value, null, 2)` (apps/cli/src/output.ts). The
// page shows exactly that text, split into tokens only so keys and values can be told apart, with
// an ellipsis where an abridged object leaves fields out.

import type { Shown } from './terminal.ts';

export type JsonToken = {
  readonly text: string;
  readonly kind: 'key' | 'string' | 'number' | 'literal' | 'punctuation';
};

/** A key no printed object has: it stands for a run of fields left out. */
const ELIDED = '\u0000elided';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const abridge = (value: unknown, only: Shown): unknown => {
  if (Array.isArray(value)) return value.map(item => abridge(item, only));
  if (!isRecord(value)) return value;
  const shown = new Map(only.map(field => (typeof field === 'string' ? [field, null] : field)));
  const entries: [string, unknown][] = [];
  for (const [key, field] of Object.entries(value)) {
    if (!shown.has(key)) {
      const isAfterElided = entries.at(-1)?.[0].startsWith(ELIDED) === true;
      if (!isAfterElided) entries.push([`${ELIDED}${entries.length}`, null]);
      continue;
    }
    const inner = shown.get(key);
    entries.push([key, inner === null || inner === undefined ? field : abridge(field, inner)]);
  }
  return Object.fromEntries(entries);
};

const valueKind = (text: string): JsonToken['kind'] => {
  if (text.startsWith('"')) return 'string';
  if (/^-?\d/.test(text)) return 'number';
  if (text === 'true' || text === 'false' || text === 'null') return 'literal';
  return 'punctuation';
};

const LINE = /^(?<indent>\s*)(?:(?<key>"(?:[^"\\]|\\.)*"): )?(?<value>.*?)(?<comma>,?)$/;

/** One array of tokens per printed line, `only` naming the fields shown when it is abridged. */
export const jsonLines = (value: unknown, only?: Shown): readonly (readonly JsonToken[])[] =>
  JSON.stringify(only === undefined ? value : abridge(value, only), null, 2)
    .split('\n')
    .map(line => {
      const groups = LINE.exec(line)?.groups;
      if (groups === undefined) throw new Error(`Unexpected JSON line: ${line}`);
      const { indent = '', key, value: text = '', comma = '' } = groups;
      if (key !== undefined && JSON.parse(key).startsWith(ELIDED)) {
        return [{ text: `${indent}…`, kind: 'punctuation' as const }];
      }
      return [
        { text: indent, kind: 'punctuation' as const },
        ...(key !== undefined
          ? [
              { text: key, kind: 'key' as const },
              { text: ': ', kind: 'punctuation' as const },
            ]
          : []),
        { text, kind: valueKind(text) },
        { text: comma, kind: 'punctuation' as const },
      ].filter(token => token.text !== '');
    });
