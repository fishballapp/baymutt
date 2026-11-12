/** HMAC-SHA256 of `data` under a raw `key`, over WebCrypto: what R2's SigV4 and webhook
 * signatures are built on. */
export const hmacSha256 = async (key: BufferSource, data: string): Promise<ArrayBuffer> => {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
};
