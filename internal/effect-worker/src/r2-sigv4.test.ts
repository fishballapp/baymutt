import * as Redacted from 'effect/Redacted';
import { describe, expect, it } from 'vitest';
import { presignPutUrl, type R2Creds } from './r2-sigv4';

const creds: R2Creds = {
  accessKeyId: 'AKIAEXAMPLE0000000000',
  secretAccessKey: Redacted.make('wJalrXUtnFEMI0000EXAMPLEKEY'),
  host: 'acc123.r2.cloudflarestorage.com',
  bucket: 'media-bucket',
};

const FIXED = Date.parse('2026-06-22T00:00:00.000Z');
const KEY = 'assets/org_x/asset_y/clip.mp4';

describe('presignPutUrl for a multipart part (AWS SigV4)', () => {
  it('builds a well-formed presigned PUT URL', async () => {
    const url = await presignPutUrl({
      creds,
      key: KEY,
      expiresInSeconds: 3600,
      now: FIXED,
      part: { uploadId: 'UPLOAD-ID-1', partNumber: 1 },
    });
    expect(url.startsWith('https://acc123.r2.cloudflarestorage.com/media-bucket/')).toBe(true);
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(url).toContain(
      'X-Amz-Credential=AKIAEXAMPLE0000000000%2F20260622%2Fauto%2Fs3%2Faws4_request',
    );
    expect(url).toContain('X-Amz-Date=20260622T000000Z');
    expect(url).toContain('X-Amz-Expires=3600');
    expect(url).toContain('X-Amz-SignedHeaders=host');
    expect(url).toContain('partNumber=1');
    expect(url).toContain('uploadId=UPLOAD-ID-1');
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
  });

  it('is deterministic for fixed inputs', async () => {
    const a = await presignPutUrl({
      creds,
      key: KEY,
      expiresInSeconds: 3600,
      now: FIXED,
      part: { uploadId: 'UPLOAD-ID-1', partNumber: 1 },
    });
    const b = await presignPutUrl({
      creds,
      key: KEY,
      expiresInSeconds: 3600,
      now: FIXED,
      part: { uploadId: 'UPLOAD-ID-1', partNumber: 1 },
    });
    expect(a).toBe(b);
  });

  it('signs each part number distinctly', async () => {
    const part1 = await presignPutUrl({
      creds,
      key: KEY,
      expiresInSeconds: 3600,
      now: FIXED,
      part: { uploadId: 'UPLOAD-ID-1', partNumber: 1 },
    });
    const part2 = await presignPutUrl({
      creds,
      key: KEY,
      expiresInSeconds: 3600,
      now: FIXED,
      part: { uploadId: 'UPLOAD-ID-1', partNumber: 2 },
    });
    const sig = (url: string) => /X-Amz-Signature=([0-9a-f]{64})/.exec(url)?.[1];
    expect(sig(part1)).not.toBe(sig(part2));
  });

  it('preserves key slashes but percent-encodes the path segments', async () => {
    const url = await presignPutUrl({
      creds,
      key: 'a b/c+d',
      expiresInSeconds: 60,
      now: FIXED,
      part: { uploadId: 'U', partNumber: 1 },
    });
    expect(url).toContain('/media-bucket/a%20b/c%2Bd?');
  });
});

describe('presignPutUrl (single-object SigV4)', () => {
  const THUMB_KEY = 'assets/org_x/asset_y/thumbnail.jpg';

  it('builds a well-formed presigned PUT URL with no multipart query params', async () => {
    const url = await presignPutUrl({ creds, key: THUMB_KEY, expiresInSeconds: 3600, now: FIXED });
    expect(
      url.startsWith(
        'https://acc123.r2.cloudflarestorage.com/media-bucket/assets/org_x/asset_y/thumbnail.jpg?',
      ),
    ).toBe(true);
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(url).toContain('X-Amz-SignedHeaders=host');
    expect(url).toContain('X-Amz-Expires=3600');
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
    expect(url).not.toContain('partNumber');
    expect(url).not.toContain('uploadId');
  });

  it('is deterministic for fixed inputs', async () => {
    const a = await presignPutUrl({ creds, key: THUMB_KEY, expiresInSeconds: 3600, now: FIXED });
    const b = await presignPutUrl({ creds, key: THUMB_KEY, expiresInSeconds: 3600, now: FIXED });
    expect(a).toBe(b);
  });
});

describe('presignPutUrl for a whole object of a fixed type', () => {
  it('signs the Content-Type, so the PUT must send exactly that type', async () => {
    const presign = (contentType?: string) =>
      presignPutUrl({
        creds,
        key: 'avatars/u.jpg',
        expiresInSeconds: 600,
        now: FIXED,
        contentType,
      });
    const typed = new URL(await presign('image/jpeg')).searchParams;
    expect(typed.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    // Checked against aws4fetch (`allHeaders: true`), an independent SigV4 signer.
    expect(typed.get('X-Amz-Signature')).toBe(
      'e15b2a7def8a0f8bb3e287cbed43e1e1991e6ae06fac2ca3eec555c682fe900e',
    );
    expect(new URL(await presign()).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });
});
