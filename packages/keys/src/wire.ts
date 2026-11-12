/**
 * The store's side of a machine's bearer: its wire form, and the hash the store keeps of it. No
 * key material and no imports, so the Worker takes this module without the rest of the schedule.
 *
 * ```
 * bearer  = "baymutt_<credentialId>_<secret>"     → `Authorization: Bearer …`
 * stored  = SHA-256(secret), base64url            → 256 random bits, so a plain hash has nothing to guess
 * ```
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SECRET = '[A-Za-z0-9_-]{43}';
const BEARER = new RegExp(`^baymutt_(?<credentialId>${UUID})_(?<secret>${SECRET})$`);

/** What the store keeps of a token it must recognise and never needs to read. */
export const tokenHash = async (token: string): Promise<string> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toBase64({
    alphabet: 'base64url',
    omitPadding: true,
  });

export const formatBearer = ({
  credentialId,
  secret,
}: {
  readonly credentialId: string;
  readonly secret: string;
}): string => `baymutt_${credentialId}_${secret}`;

/** Which credential a bearer names, and the hash to compare with the one the store keeps. */
export const parseBearer = async (
  bearer: string,
): Promise<{ readonly credentialId: string; readonly bearerHash: string } | null> => {
  const { credentialId, secret } = BEARER.exec(bearer)?.groups ?? {};
  if (credentialId === undefined || secret === undefined) return null;
  return { credentialId, bearerHash: await tokenHash(secret) };
};
