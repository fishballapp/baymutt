import { utf8, VaultError } from '@internal/zk-vault';

/** JSON rather than a separator: `${a}:${b}` is not injective. Every part is a string, so one binding has one spelling. */
export const tuple = (...parts: readonly string[]): Uint8Array<ArrayBuffer> =>
  utf8(JSON.stringify(parts));

/** Crockford's base32: no I, L, O or U, so a key copied by hand has one spelling. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const toCrockford = (bytes: Uint8Array): string => {
  const bits = Array.from(bytes, byte => byte.toString(2).padStart(8, '0')).join('');
  return Array.from({ length: Math.ceil(bits.length / 5) }, (_, index) =>
    CROCKFORD.charAt(Number.parseInt(bits.slice(index * 5, index * 5 + 5).padEnd(5, '0'), 2)),
  ).join('');
};

/** Reads what a person typed: any case, with or without the dashes, and the letters Crockford folds (`O` as 0, `I` and `L` as 1). */
export const fromCrockford = (
  text: string,
  byteLength: number,
  what: string,
): Uint8Array<ArrayBuffer> => {
  const symbols = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  const values = Array.from(symbols, symbol => CROCKFORD.indexOf(symbol));
  if (values.includes(-1) || symbols.length !== Math.ceil((byteLength * 8) / 5)) {
    throw new VaultError('malformed', `${what} is not ${byteLength} bytes of Crockford base32`);
  }
  const bits = values.map(value => value.toString(2).padStart(5, '0')).join('');
  if (/1/.test(bits.slice(byteLength * 8))) {
    throw new VaultError('malformed', `${what} has stray bits after its last byte`);
  }
  return Uint8Array.from({ length: byteLength }, (_, index) =>
    Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2),
  );
};

export const sha256Base64Url = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).toBase64({
    alphabet: 'base64url',
    omitPadding: true,
  });

export const randomToken = (): string =>
  crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: 'base64url', omitPadding: true });
