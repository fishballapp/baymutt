/**
 * R2's multipart rules, and how its Worker binding reports a refusal. From
 * <https://developers.cloudflare.com/r2/platform/limits/> and
 * <https://developers.cloudflare.com/r2/objects/upload-objects/#multipart-upload>.
 */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** One request's ceiling: a single PUT, or one part of a multipart upload. */
export const R2_SINGLE_PUT_MAX_BYTES = 5 * GIB - 5 * MIB;
/** The largest object, which only a multipart upload can make. */
export const R2_MAX_OBJECT_BYTES = 5 * 1024 * GIB - 5 * GIB;
export const R2_MAX_PARTS = 10_000;
/** Every part but the last must be at least this. */
export const R2_MIN_PART_BYTES = 5 * MIB;

/** The smallest part we plan: R2's minimum with headroom, and few enough requests for a small file. */
const DEFAULT_MIN_PART_BYTES = 10 * MIB;

export type MultipartPlan = { readonly partSize: number; readonly partCount: number };

/**
 * How to cut an object of `size` bytes. R2 requires every part but the last to be the same size, so
 * one size is chosen up front: whole MiB, at least `minPartBytes`, and large enough that the object
 * fits in {@link R2_MAX_PARTS}. Any size up to {@link R2_MAX_OBJECT_BYTES} gives a part under
 * {@link R2_SINGLE_PUT_MAX_BYTES} (about 524 MiB at the largest).
 */
export const planMultipart = (
  size: number,
  { minPartBytes = DEFAULT_MIN_PART_BYTES }: { readonly minPartBytes?: number } = {},
): MultipartPlan => {
  const fitting = Math.ceil(Math.ceil(size / R2_MAX_PARTS) / MIB) * MIB;
  const partSize = Math.max(minPartBytes, fitting);
  return { partSize, partCount: Math.max(1, Math.ceil(size / partSize)) };
};

/**
 * Why R2 refused a multipart call, from the code its binding puts on the error (`R2Error.code`, and
 * at the end of the message, `… (10024)`). `null` is any other failure: R2's own fault.
 *
 * - `no-such-upload` (10024): never started, already completed, or aborted (R2 aborts an incomplete
 *   upload after 7 days by default).
 * - `rejected`: the part list is wrong, and the upload stays open to complete again. A part missing
 *   or its ETag wrong (10025), under the 5 MiB minimum (10011), or the parts not all one size but
 *   the last (10048). The binding sorts the parts by number itself, and answers a number listed
 *   twice with its internal error (10001): refuse that list before calling it.
 */
export type R2MultipartRefusal = 'no-such-upload' | 'rejected';

const REJECTED_CODES = new Set([10011, 10025, 10048]);
const NO_SUCH_UPLOAD = 10024;

const r2ErrorCode = (error: unknown): number | null => {
  if (!(error instanceof Error)) return null;
  if ('code' in error && typeof error.code === 'number') return error.code;
  const match = /\((\d{5})\)\s*$/.exec(error.message);
  return match?.[1] === undefined ? null : Number(match[1]);
};

export const r2MultipartRefusal = (error: unknown): R2MultipartRefusal | null => {
  const code = r2ErrorCode(error);
  if (code === NO_SUCH_UPLOAD) return 'no-such-upload';
  if (code !== null && REJECTED_CODES.has(code)) return 'rejected';
  return null;
};
