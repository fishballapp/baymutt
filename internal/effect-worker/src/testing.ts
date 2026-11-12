/// <reference types="node" />
/**
 * Test doubles for an Effect Worker, so its tests run the REAL code — real SQL through the real
 * `D1Client` over an in-memory `node:sqlite` with every migration applied — and fake only the
 * Cloudflare bindings (KV, R2, Queue) at the edge. Each product's own `testWorld` builds its service
 * graph over these.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import * as Cause from 'effect/Cause';
import * as Logger from 'effect/Logger';
import * as References from 'effect/References';

/** Rows as an older deployment left them: `seed` runs just before the migration named `before`. */
export type LegacyRows = { readonly before: string; readonly seed: (sqlite: DatabaseSync) => void };

const D1_MAX_BOUND_PARAMETERS = 100;

/**
 * A `D1Database` over `node:sqlite` with every migration in `migrationsDir` applied — with foreign
 * keys enforced, as D1 applies them — plus the raw handle for seeding and asserting. `batch` is
 * transactional like D1's, and returns each statement's rows (RETURNING), and a statement over D1's
 * 100 bound parameters fails as it does on D1. `legacy` seeds rows partway, to test a migration's
 * conversion of them.
 *
 * `beforeStatement` stages a race deterministically: `interleave` runs once, just before the next
 * statement whose SQL matches `pattern` — a concurrent request's write landing between this request's
 * statements (or, if it throws, the request dying there). `afterBatch` runs `act` once, after the next
 * batch holding a statement that matches commits: if it throws, the write landed but its reply is
 * lost.
 */
export const createTestD1 = ({
  migrationsDir,
  legacy,
}: {
  migrationsDir: string;
  legacy?: LegacyRows | undefined;
}): {
  sqlite: DatabaseSync;
  d1: D1Database;
  beforeStatement: (pattern: RegExp, interleave: () => void) => void;
  afterBatch: (pattern: RegExp, act: () => void) => void;
} => {
  const sqlite = new DatabaseSync(':memory:');
  // D1 enforces foreign keys; node:sqlite does not by default.
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(migrationsDir)
    .filter(n => n.endsWith('.sql'))
    .sort()) {
    if (legacy !== undefined && name.startsWith(legacy.before)) legacy.seed(sqlite);
    // D1 runs each migration file in a transaction.
    sqlite.exec(`BEGIN; ${readFileSync(join(migrationsDir, name), 'utf8')}\nCOMMIT;`);
  }

  const interleavings: { pattern: RegExp; interleave: () => void }[] = [];
  const interleaveBefore = (sql: string): void => {
    const index = interleavings.findIndex(({ pattern }) => pattern.test(sql));
    if (index === -1) return;
    const [staged] = interleavings.splice(index, 1);
    staged?.interleave();
  };

  const afterBatches: { pattern: RegExp; act: () => void }[] = [];
  const actAfter = (sqls: readonly string[]): void => {
    const index = afterBatches.findIndex(({ pattern }) => sqls.some(sql => pattern.test(sql)));
    if (index === -1) return;
    const [staged] = afterBatches.splice(index, 1);
    staged?.act();
  };

  const totalChanges = (): number =>
    Number(sqlite.prepare('SELECT total_changes() AS c').get()?.c ?? 0);

  // D1 refuses a statement with more than 100 bound parameters; node:sqlite would take 32766.
  const refuseOverD1Limit = (params: SQLInputValue[]): void => {
    if (params.length > D1_MAX_BOUND_PARAMETERS) {
      throw new Error(`D1_ERROR: too many SQL variables (${params.length}): SQLITE_ERROR`);
    }
  };

  const bound = (sql: string, params: SQLInputValue[]) => ({
    sql,
    /** The statement, run now: what a batch runs, so nothing reaches the connection mid-batch. */
    allNow() {
      refuseOverD1Limit(params);
      interleaveBefore(sql);
      const before = totalChanges();
      const results = sqlite.prepare(sql).all(...params);
      return { results, success: true, meta: { changes: totalChanges() - before } };
    },
    async all() {
      return this.allNow();
    },
    async first() {
      refuseOverD1Limit(params);
      return sqlite.prepare(sql).get(...params) ?? null;
    },
    async run() {
      return this.allNow();
    },
    async raw() {
      refuseOverD1Limit(params);
      interleaveBefore(sql);
      return sqlite
        .prepare(sql)
        .all(...params)
        .map(row => Object.values(row));
    },
  });

  const d1 = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => bound(sql, params as SQLInputValue[]),
      ...bound(sql, []),
    }),
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    // D1 runs a batch as one unit; one shared node:sqlite connection is isolated only if nothing else
    // runs while its transaction is open, so the whole batch runs synchronously.
    async batch(statements: ReadonlyArray<ReturnType<typeof bound>>) {
      const results = (() => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const committed = statements.map(statement => statement.allNow());
          sqlite.exec('COMMIT');
          return committed;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      })();
      actAfter(statements.map(statement => statement.sql));
      return results;
    },
  } as unknown as D1Database;

  return {
    sqlite,
    d1,
    beforeStatement: (pattern, interleave) => void interleavings.push({ pattern, interleave }),
    afterBatch: (pattern, act) => void afterBatches.push({ pattern, act }),
  };
};

/** An in-memory KV namespace (get / put / delete — with the TTL each put asked for, unenforced), or
 * one that rejects every call, as KV does past its one write per key per second. */
export const fakeKv = (
  options: { fail?: boolean } = {},
): KVNamespace & {
  readonly store: Map<string, string>;
  readonly ttls: Map<string, number | undefined>;
} => {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const reject = () => {
    if (options.fail) throw new Error('KV failed: 429 Too Many Requests');
  };
  return {
    store,
    ttls,
    get: async (key: string) => {
      reject();
      return store.get(key) ?? null;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      reject();
      store.set(key, value);
      ttls.set(key, options?.expirationTtl);
    },
    delete: async (key: string) => {
      reject();
      store.delete(key);
      ttls.delete(key);
    },
  } as unknown as KVNamespace & {
    readonly store: Map<string, string>;
    readonly ttls: Map<string, number | undefined>;
  };
};

export type FakeObject = {
  body: string | Uint8Array;
  contentType?: string;
  /** When it was written; defaults to the epoch, so an orphan sweep sees it as old. */
  uploaded?: Date;
};

/** An in-memory R2 bucket (head / get with range / put / delete / list by prefix), with the objects
 * it holds by key. */
export const fakeR2 = (
  initial: Record<string, FakeObject> = {},
): R2Bucket & { readonly objects: Map<string, FakeObject> } => {
  const objects = new Map(Object.entries(initial));
  // A copy, so its buffer is a plain `ArrayBuffer` whatever the stored view's was.
  const bytesOf = (object: FakeObject) =>
    (typeof object.body === 'string' ? new TextEncoder().encode(object.body) : object.body).slice();
  const meta = (key: string, object: FakeObject) => ({
    key,
    size: bytesOf(object).byteLength,
    // biome-ignore lint/plugin/no-date: R2's `uploaded` is a Date in the Workers runtime; the fake's default mirrors it.
    uploaded: object.uploaded ?? new Date(0),
    httpEtag: `"${key}"`,
    httpMetadata: object.contentType === undefined ? {} : { contentType: object.contentType },
  });
  return {
    objects,
    head: async (key: string) => {
      const object = objects.get(key);
      return object === undefined ? null : meta(key, object);
    },
    get: async (key: string, options?: { range?: { offset: number; length: number } }) => {
      const object = objects.get(key);
      if (object === undefined) return null;
      const all = bytesOf(object);
      const range = options?.range;
      const bytes =
        range === undefined ? all : all.slice(range.offset, range.offset + range.length);
      return {
        ...meta(key, object),
        body: new Blob([bytes]).stream(),
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    },
    put: async (
      key: string,
      value: ArrayBuffer | Uint8Array | string,
      options?: { httpMetadata?: { contentType?: string } },
    ) => {
      const body = typeof value === 'string' ? value : new Uint8Array(value);
      objects.set(key, {
        body,
        ...(options?.httpMetadata?.contentType === undefined
          ? {}
          : { contentType: options.httpMetadata.contentType }),
      });
      return meta(key, { body });
    },
    delete: async (keys: string | string[]) => {
      for (const key of [keys].flat()) objects.delete(key);
    },
    list: async (options?: { prefix?: string }) => ({
      objects: [...objects.entries()]
        .filter(([key]) => key.startsWith(options?.prefix ?? ''))
        .map(([key, object]) => meta(key, object)),
      truncated: false,
      delimitedPrefixes: [],
    }),
  } as unknown as R2Bucket & { readonly objects: Map<string, FakeObject> };
};

/** A Queue that records each message it was sent (or rejects every send, to exercise a failure). */
export const fakeQueue = <Body>(
  options: { fail?: boolean } = {},
): Queue<Body> & { readonly sent: Body[] } => {
  const sent: Body[] = [];
  const reject = () => {
    if (options.fail) throw new Error('queue unavailable');
  };
  return {
    sent,
    send: async (body: Body) => {
      reject();
      sent.push(body);
    },
    sendBatch: async (messages: Iterable<{ body: Body }>) => {
      reject();
      for (const message of messages) sent.push(message.body);
    },
  } as unknown as Queue<Body> & { readonly sent: Body[] };
};

/** A log line as a test sees it: its level, its message, its annotations and the cause it carries. */
export type CapturedLog = {
  readonly level: string;
  readonly message: string;
  readonly annotations: Readonly<Record<string, unknown>>;
  readonly cause: string;
};

/** A logger that keeps every line, replacing the default ones — provide `layer` with the services. */
export const captureLogs = () => {
  const logs: CapturedLog[] = [];
  const layer = Logger.layer([
    Logger.make(({ logLevel, message, fiber, cause }) => {
      logs.push({
        level: logLevel,
        message: [message].flat().map(String).join(' '),
        annotations: fiber.getRef(References.CurrentLogAnnotations),
        cause: Cause.pretty(cause),
      });
    }),
  ]);
  return { logs, layer };
};

/** A response's status and JSON body, for one assertion over both. */
export const json = async (res: Response): Promise<{ status: number; body: unknown }> => ({
  status: res.status,
  body: await res.json(),
});
