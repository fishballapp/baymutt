/**
 * AWS Signature V4 for R2's S3 API over WebCrypto — no AWS SDK, no `node:crypto`. Pure: the time is
 * an argument, so the signatures are deterministic in tests. Region is the S3 literal `auto` for R2;
 * payloads are signed as `UNSIGNED-PAYLOAD` (valid over HTTPS), so request bodies are never hashed.
 */
import * as Redacted from 'effect/Redacted';
import { hmacSha256 } from './crypto';

const REGION = 'auto';
const SERVICE = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const ALGORITHM = 'AWS4-HMAC-SHA256';

/** The R2 S3 API key pair and the bucket it signs for. */
export type R2Creds = {
  accessKeyId: string;
  /** Unwrapped only to derive the signing key. */
  secretAccessKey: Redacted.Redacted<string>;
  /** `<account-id>.r2.cloudflarestorage.com` */
  host: string;
  bucket: string;
};

/** One part of a multipart upload. */
export type UploadPart = { uploadId: string; partNumber: number };

const sha256Hex = async (data: string): Promise<string> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))).toHex();

/** RFC 3986 encoding (AWS-strict): `encodeURIComponent` plus the four characters it leaves alone. */
const uriEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!*'()]/g,
    c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** An object key encoded per segment, keeping its `/` separators. */
const encodeKey = (key: string): string => key.split('/').map(uriEncode).join('/');

const amzDates = (now: number): { amzDate: string; dateStamp: string } => {
  const amzDate = Temporal.Instant.fromEpochMilliseconds(now)
    .toString({ smallestUnit: 'second' })
    .replace(/[:-]/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
};

const signingKey = async (creds: R2Creds, dateStamp: string): Promise<ArrayBuffer> => {
  const kDate = await hmacSha256(
    new TextEncoder().encode(`AWS4${Redacted.value(creds.secretAccessKey)}`),
    dateStamp,
  );
  const kRegion = await hmacSha256(kDate, REGION);
  const kService = await hmacSha256(kRegion, SERVICE);
  return hmacSha256(kService, 'aws4_request');
};

const credentialScope = (dateStamp: string): string =>
  `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

export const canonicalQuery = (params: Record<string, string>): string =>
  Object.keys(params)
    .sort()
    .map(k => `${uriEncode(k)}=${uriEncode(params[k] ?? '')}`)
    .join('&');

const canonicalUri = (creds: R2Creds, key: string): string => `/${creds.bucket}/${encodeKey(key)}`;

export const objectUrl = (creds: R2Creds, key: string): string =>
  `https://${creds.host}${canonicalUri(creds, key)}`;

/** The hex signature of a canonical request: over its string-to-sign, with the day's signing key. */
const sign = async ({
  creds,
  amzDate,
  dateStamp,
  canonicalRequest,
}: {
  creds: R2Creds;
  amzDate: string;
  dateStamp: string;
  canonicalRequest: string;
}): Promise<string> => {
  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope(dateStamp),
    await sha256Hex(canonicalRequest),
  ].join('\n');
  return new Uint8Array(await hmacSha256(await signingKey(creds, dateStamp), stringToSign)).toHex();
};

/**
 * The headers that sign a Worker → R2 control call with `Authorization` (the multipart create and
 * complete calls, which carry no user bytes).
 */
export const signedControlHeaders = async ({
  creds,
  method,
  key,
  query,
  now,
}: {
  creds: R2Creds;
  method: string;
  key: string;
  query: Record<string, string>;
  now: number;
}): Promise<Record<string, string>> => {
  const { amzDate, dateStamp } = amzDates(now);
  const headers: Record<string, string> = {
    host: creds.host,
    'x-amz-content-sha256': UNSIGNED_PAYLOAD,
    'x-amz-date': amzDate,
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = `${signedHeaderNames.map(h => `${h}:${headers[h]}`).join('\n')}\n`;
  const signedHeaderList = signedHeaderNames.join(';');
  const canonicalRequest = [
    method,
    canonicalUri(creds, key),
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaderList,
    UNSIGNED_PAYLOAD,
  ].join('\n');
  const signed = await sign({ creds, amzDate, dateStamp, canonicalRequest });
  return {
    ...headers,
    Authorization:
      `${ALGORITHM} Credential=${creds.accessKeyId}/${credentialScope(dateStamp)}, ` +
      `SignedHeaders=${signedHeaderList}, Signature=${signed}`,
  };
};

/**
 * A query-presigned PUT URL for `key` that the browser uploads to directly: one `part` of a multipart
 * upload, or without it the whole object. The PUT's `Content-Type` is what R2 stores the object as:
 * unsigned, the browser sets it from the Blob; with `contentType`, the signature binds it, so the PUT
 * must send exactly that type.
 */
export const presignPutUrl = async ({
  creds,
  key,
  expiresInSeconds,
  now,
  part,
  contentType,
}: {
  creds: R2Creds;
  key: string;
  expiresInSeconds: number;
  now: number;
  part?: UploadPart | undefined;
  contentType?: string | undefined;
}): Promise<string> => {
  const { amzDate, dateStamp } = amzDates(now);
  const headers: Record<string, string> = {
    ...(contentType === undefined ? {} : { 'content-type': contentType }),
    host: creds.host,
  };
  const signedHeaderList = Object.keys(headers).join(';');
  const signedQuery = canonicalQuery({
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${creds.accessKeyId}/${credentialScope(dateStamp)}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': signedHeaderList,
    ...(part === undefined ? {} : { partNumber: String(part.partNumber), uploadId: part.uploadId }),
  });
  const canonicalRequest = [
    'PUT',
    canonicalUri(creds, key),
    signedQuery,
    Object.entries(headers)
      .map(([name, value]) => `${name}:${value}\n`)
      .join(''),
    signedHeaderList,
    UNSIGNED_PAYLOAD,
  ].join('\n');
  const signed = await sign({ creds, amzDate, dateStamp, canonicalRequest });
  return `${objectUrl(creds, key)}?${signedQuery}&X-Amz-Signature=${signed}`;
};
