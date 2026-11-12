// The WebAuthn PRF extension: the passkey gives 32 bytes for our label, the same every time, and
// those bytes wrap the vault's data key. One gesture signs in and unlocks.
import { PRF_INPUT_LABEL } from '@baymutt/keys';

/** WebAuthn Level 3's recommended timeout when user verification is required (§15.1). */
const TIMEOUT_MS = 300_000;

/**
 * Enable-only at creation: evaluating a PRF inside `create()` is not supported everywhere, and an
 * authenticator that answers `enabled` with no result must not be mistaken for one with none.
 */
export const PRF_ENABLE = { prf: {} } as AuthenticationExtensionsClientInputs;

export const prfEval = (): AuthenticationExtensionsClientInputs =>
  ({
    prf: { eval: { first: new TextEncoder().encode(PRF_INPUT_LABEL) } },
  }) as AuthenticationExtensionsClientInputs;

type PrfResults = { readonly enabled?: boolean; readonly results?: { readonly first?: unknown } };

const prfOf = (clientExtensionResults: unknown): PrfResults | undefined =>
  typeof clientExtensionResults === 'object' && clientExtensionResults !== null
    ? (clientExtensionResults as { readonly prf?: PrfResults }).prf
    : undefined;

/** `false` means this authenticator cannot do PRF at all. */
export const isPrfEnabled = (clientExtensionResults: unknown): boolean =>
  prfOf(clientExtensionResults)?.enabled === true;

/** The 32 bytes, or null when the authenticator returned none. */
export const prfOutput = (clientExtensionResults: unknown): Uint8Array | null => {
  const first = prfOf(clientExtensionResults)?.results?.first;
  // The spec says `BufferSource`; 1Password's extension has shipped a plain array.
  const bytes = (() => {
    if (first instanceof ArrayBuffer) return new Uint8Array(first);
    if (ArrayBuffer.isView(first)) {
      return new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
    }
    if (Array.isArray(first)) return Uint8Array.from(first);
    return null;
  })();
  return bytes?.length === 32 ? bytes : null;
};

/**
 * A local assertion that is sent nowhere, for the PRF of the passkey just created. The challenge
 * is random only so the ceremony is well formed.
 */
export const evaluatePrf = async (credentialId: string): Promise<Uint8Array | null> => {
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [
        { id: Uint8Array.fromBase64(credentialId, { alphabet: 'base64url' }), type: 'public-key' },
      ],
      userVerification: 'required',
      timeout: TIMEOUT_MS,
      extensions: prfEval(),
    },
  });
  return credential instanceof PublicKeyCredential
    ? prfOutput(credential.getClientExtensionResults())
    : null;
};
