import { describe, expect, it } from 'vitest';
import {
  planMultipart,
  R2_MAX_OBJECT_BYTES,
  R2_MAX_PARTS,
  R2_MIN_PART_BYTES,
  R2_SINGLE_PUT_MAX_BYTES,
  r2MultipartRefusal,
} from './r2-multipart';
import { fakeR2 } from './testing';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe('planMultipart', () => {
  it('cuts a small file into 10 MiB parts, and a tiny one into one part', () => {
    expect(planMultipart(25 * MIB)).toEqual({ partSize: 10 * MIB, partCount: 3 });
    expect(planMultipart(1)).toEqual({ partSize: 10 * MIB, partCount: 1 });
  });

  it('grows the part, in whole MiB, so any object R2 can hold fits its part rules', () => {
    for (const size of [100 * GIB, 1024 * GIB, R2_MAX_OBJECT_BYTES]) {
      const { partSize, partCount } = planMultipart(size);
      expect(partSize % MIB).toBe(0);
      expect(partSize).toBeGreaterThanOrEqual(R2_MIN_PART_BYTES);
      expect(partSize).toBeLessThanOrEqual(R2_SINGLE_PUT_MAX_BYTES);
      expect(partCount).toBeLessThanOrEqual(R2_MAX_PARTS);
      expect((partCount - 1) * partSize).toBeLessThan(size);
      expect(partCount * partSize).toBeGreaterThanOrEqual(size);
    }
    expect(planMultipart(100 * GIB).partSize).toBe(11 * MIB);
  });
});

describe('r2MultipartRefusal', () => {
  const thrown = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      return error;
    }
    throw new Error('expected a refusal');
  };

  it('reads a refused part list and a gone upload from what the binding throws', async () => {
    const r2 = fakeR2();
    const upload = await r2.createMultipartUpload('k');
    const first = await upload.uploadPart(1, new Uint8Array(R2_MIN_PART_BYTES));
    const second = await upload.uploadPart(2, new Uint8Array(R2_MIN_PART_BYTES + 1));
    const last = await upload.uploadPart(3, 'x');
    for (const parts of [
      [{ partNumber: 1, etag: 'wrong' }],
      [second, first],
      [last, first],
      [first, second, last],
    ]) {
      expect(r2MultipartRefusal(await thrown(() => upload.complete(parts)))).toBe('rejected');
    }
    expect((await upload.complete([first, last])).size).toBe(R2_MIN_PART_BYTES + 1);
    expect(r2MultipartRefusal(await thrown(() => upload.complete([first, last])))).toBe(
      'no-such-upload',
    );
  });

  it('reads the code from the message when the error carries none, and nothing else', () => {
    expect(
      r2MultipartRefusal(
        new Error(
          'completeMultipartUpload: The specified multipart upload does not exist. (10024)',
        ),
      ),
    ).toBe('no-such-upload');
    expect(
      r2MultipartRefusal(
        new Error('completeMultipartUpload: We encountered an internal error. (10001)'),
      ),
    ).toBeNull();
    expect(r2MultipartRefusal('boom')).toBeNull();
  });
});
