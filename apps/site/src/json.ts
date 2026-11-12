// What the CLI prints on stdout is `JSON.stringify(value, null, 2)` (apps/cli/src/output.ts). The
// page shows exactly that text, split into tokens only so keys and values can be told apart.

export type JsonToken = {
  readonly text: string;
  readonly kind: 'key' | 'string' | 'number' | 'literal' | 'punctuation';
};

const valueKind = (text: string): JsonToken['kind'] => {
  if (text.startsWith('"')) return 'string';
  if (/^-?\d/.test(text)) return 'number';
  if (text === 'true' || text === 'false' || text === 'null') return 'literal';
  return 'punctuation';
};

const LINE = /^(?<indent>\s*)(?:(?<key>"(?:[^"\\]|\\.)*"): )?(?<value>.*?)(?<comma>,?)$/;

/** One array of tokens per printed line. */
export const jsonLines = (value: unknown): readonly (readonly JsonToken[])[] =>
  JSON.stringify(value, null, 2)
    .split('\n')
    .map(line => {
      const groups = LINE.exec(line)?.groups;
      if (groups === undefined) throw new Error(`Unexpected JSON line: ${line}`);
      const { indent = '', key, value: text = '', comma = '' } = groups;
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
