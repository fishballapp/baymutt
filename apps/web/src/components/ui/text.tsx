import { cn } from 'cn';
import type { ReactNode } from 'react';
import { NAME_NOT_OPENED } from '../../lib/data.ts';

/** An exact string in a line: mono, always `foreground`, whatever the line around it. */
export const Code = ({ children }: { readonly children: ReactNode }) => (
  <span className="code">{children}</span>
);

/**
 * An environment's address, `acme/app/production`, its `acme/` muted. `name` null is a name that
 * does not open: the whole address is muted and reads "acme/name does not open".
 */
export const Address = ({
  orgSlug,
  name,
}: {
  readonly orgSlug: string;
  readonly name: string | null;
}) => (
  <span className={cn('code addr', name === null && 'unopened')}>
    <span className="org">{orgSlug}/</span>
    {name ?? NAME_NOT_OPENED}
  </span>
);

/** A secret's or other name that may not open: the name, or "name does not open", muted. */
export const SealedName = ({ name }: { readonly name: string | null }) =>
  name === null ? <span className="code unopened">{NAME_NOT_OPENED}</span> : <Code>{name}</Code>;

type Access = { readonly canRead: boolean; readonly canWrite: boolean };

/** `AccessWords` as plain text, for a filter that reads a sentence: "read and write". */
export const accessText = ({ canRead, canWrite }: Access): string => {
  if (canRead && canWrite) return 'read and write';
  return canWrite ? 'write' : 'read';
};

/**
 * What a key holds on one environment, in words: "read", "write" or "read and write", with
 * "write" in the heavier weight. Meaning never rests on colour.
 */
export const AccessWords = ({ canRead, canWrite }: Access) => {
  if (canRead && canWrite) {
    return (
      <>
        read and <span className="w">write</span>
      </>
    );
  }
  if (canWrite) return <span className="w">write</span>;
  return 'read';
};
