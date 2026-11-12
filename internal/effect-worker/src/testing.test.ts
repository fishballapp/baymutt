import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestD1 } from './testing';

const testD1 = () => {
  const migrationsDir = mkdtempSync(join(tmpdir(), 'test-d1-'));
  writeFileSync(join(migrationsDir, '0001_t.sql'), 'CREATE TABLE t (n INTEGER NOT NULL);');
  return createTestD1({ migrationsDir });
};

describe('createTestD1', () => {
  it('runs each batch as one unit, as D1 does: two at once neither interleave nor fail', async () => {
    const { d1, sqlite } = testD1();
    const insert = (n: number) => d1.prepare('INSERT INTO t (n) VALUES (?) RETURNING n').bind(n);
    const [first, second] = await Promise.all([
      d1.batch([insert(1), insert(2)]),
      d1.batch([insert(3), insert(4)]),
    ]);
    expect(first.map(r => r.results)).toEqual([[{ n: 1 }], [{ n: 2 }]]);
    expect(second.map(r => r.results)).toEqual([[{ n: 3 }], [{ n: 4 }]]);
    expect(sqlite.prepare('SELECT n FROM t ORDER BY rowid').all()).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
      { n: 4 },
    ]);
  });

  it('rolls a failing batch back whole', async () => {
    const { d1, sqlite } = testD1();
    const ok = d1.prepare('INSERT INTO t (n) VALUES (1)');
    const bad = d1.prepare('INSERT INTO t (n) VALUES (NULL)');
    await expect(d1.batch([ok, bad])).rejects.toThrow();
    expect(sqlite.prepare('SELECT COUNT(*) AS c FROM t').get()).toEqual({ c: 0 });
  });

  it('loses the reply of a batch that committed, once, when afterBatch throws', async () => {
    const { d1, sqlite, afterBatch } = testD1();
    afterBatch(/INSERT INTO t/, () => {
      throw new Error('reply lost');
    });
    const insert = (n: number) => d1.prepare('INSERT INTO t (n) VALUES (?)').bind(n);

    await expect(d1.batch([insert(1)])).rejects.toThrow('reply lost');
    await d1.batch([insert(2)]);

    expect(sqlite.prepare('SELECT n FROM t ORDER BY rowid').all()).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
