// What the tests use of the Worker's test harness (`@baymutt/worker-web/testing`), declared by
// hand. The Worker's source is typed against workerd's globals and this package's against the
// DOM's, so one program cannot check both: tsconfig.test.json maps the import here, and Vitest
// loads the real module.
import type { DatabaseSync } from 'node:sqlite';

export declare const ORIGIN: string;

export type TestWorld = {
  readonly sqlite: DatabaseSync;
  readonly user: (id?: string) => {
    readonly id: string;
    readonly first: { readonly passkeyId: string; readonly credentialId: string };
  };
  readonly signIn: (userId: string) => Record<string, string>;
  readonly api: (path: string, init?: RequestInit) => Promise<Response>;
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

export declare const testWorld: () => TestWorld;

export declare const send: (
  method: string,
  body?: unknown,
  headers?: Record<string, string>,
) => RequestInit;
