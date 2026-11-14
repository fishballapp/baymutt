/// <reference types="node" />
// Tests run the REAL code (real SQL through the real `D1Client` over an in-memory `node:sqlite`
// with every migration applied, the real services, HTTP app and guards) and fake only Better Auth:
// a session is a row in a map, and an org is written as the organization plugin writes one.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createTestD1 } from '@internal/effect-worker/testing';
import { APIError } from 'better-auth/api';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as Layer from 'effect/Layer';
import { onTestFinished } from 'vitest';
import { HttpApp } from './http/app.ts';
import { makeWorkerLayer } from './layer.ts';
import { Auth } from './platform/auth.ts';
import type { BaymuttAuth } from './platform/better-auth.ts';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url).href);

export const ORIGIN = 'http://localhost:5183';

type TestSession = { readonly userId: string; readonly createdAt: Date };

const fakeAuth = (sqlite: DatabaseSync, sessions: Record<string, TestSession>): BaymuttAuth =>
  ({
    handler: async () => new Response('better-auth'),
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const token = /better-auth\.session_token=([^;]+)/.exec(headers.get('cookie') ?? '')?.[1];
        const session = token === undefined ? undefined : sessions[token];
        return session === undefined
          ? null
          : {
              user: { id: session.userId, email: `${session.userId}@example.test` },
              session: { createdAt: session.createdAt, token },
            };
      },
      createOrganization: async ({
        body: { userId, name, slug },
      }: {
        body: { userId: string; name: string; slug: string };
      }) => {
        if (sqlite.prepare('SELECT 1 FROM organization WHERE slug = ?').get(slug) !== undefined) {
          throw new APIError('BAD_REQUEST', {
            message: 'Organization already exists',
            code: 'ORGANIZATION_ALREADY_EXISTS',
          });
        }
        const id = crypto.randomUUID();
        // biome-ignore lint/plugin/no-date: the plugin stores a date as ISO text, as this mirrors.
        const createdAt = new Date().toISOString();
        insert(sqlite, 'organization', { id, name, slug, createdAt });
        insert(sqlite, 'member', {
          id: crypto.randomUUID(),
          organizationId: id,
          userId,
          role: 'owner',
          createdAt,
        });
        return { id, name, slug, createdAt };
      },
    },
    $context: Promise.resolve({
      password: {
        hash: async (value: string) => `hashed:${value}`,
        verify: async ({ hash, password }: { hash: string; password: string }) =>
          hash === `hashed:${password}`,
      },
    }),
  }) as unknown as BaymuttAuth;

type Row = Record<string, SQLInputValue>;

const insert = (sqlite: DatabaseSync, table: string, row: Row): void => {
  const columns = Object.keys(row);
  sqlite
    .prepare(
      `INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...Object.values(row));
};

/** A base64 string of `length` characters: the store checks a sealed value's shape, never its content. */
export const sealedLike = (seed: string, length = 64): string =>
  btoa(seed.repeat(length)).replaceAll('=', '').slice(0, length);

/** A syntactically valid public key or hash (43 base64url characters, spare bits zero). */
export const keyLike = (seed: string): string => `${seed.repeat(43).slice(0, 42)}A`;

export type Headers_ = Record<string, string>;

/** `api` is the real HTTP app; `fetch` is the same app as a `fetch`, for a real client under test. */
export const testWorld = () => {
  const { sqlite, d1, beforeStatement } = createTestD1({ migrationsDir });
  const env = {
    DB: d1,
    MODE: 'development',
    BETTER_AUTH_SECRET: 'test-secret',
    MAIL_SENDER: 'noreply@example.test',
    FORWARD_EMAIL_ALIAS_PASSWORD: 'unused',
  } as unknown as Env;
  const sessions: Record<string, TestSession> = {};
  const services = makeWorkerLayer(env, {
    auth: Auth.layerFromInstance(() => fakeAuth(sqlite, sessions)),
  });

  const { handler, dispose } = HttpRouter.toWebHandler(HttpApp.pipe(Layer.provideMerge(services)), {
    disableLogger: true,
  });
  onTestFinished(dispose);

  /** A signed-in user with one passkey, and no account (vault) yet. */
  const user = (id = 'user-1') => {
    // biome-ignore lint/plugin/no-date: Better Auth's `user` table: its createdAt column is a date, which this fixture writes as the ISO text the adapter stores.
    const now = new Date().toISOString();
    insert(sqlite, 'user', {
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: 0,
      createdAt: now,
      updatedAt: now,
    });
    const passkey = (name = 'first') => {
      const row = { passkeyId: `${id}-passkey-${name}`, credentialId: `${id}-webauthn-${name}` };
      insert(sqlite, 'passkey', {
        id: row.passkeyId,
        name,
        publicKey: 'public-key',
        userId: id,
        credentialID: row.credentialId,
        counter: 0,
        deviceType: 'multiDevice',
        backedUp: 1,
        createdAt: now,
      });
      return row;
    };
    return { id, passkey, first: passkey() };
  };

  /** A session with the vault locked: what a magic link gives. */
  const signIn = (userId: string): Headers_ => {
    const token = `session-${userId}-${Object.keys(sessions).length}`;
    // biome-ignore lint/plugin/no-date: Better Auth types a session's createdAt as Date; this fake session mirrors it.
    sessions[token] = { userId, createdAt: new Date() };
    return { cookie: `__Secure-better-auth.session_token=${token}`, origin: ORIGIN };
  };

  return {
    sqlite,
    beforeStatement,
    user,
    signIn,
    services,
    api: (path: string, init?: RequestInit) => handler(new Request(`${ORIGIN}${path}`, init)),
    fetch: ((input, init) => handler(new Request(input, init))) satisfies typeof fetch,
  };
};

export type TestWorld = ReturnType<typeof testWorld>;

export const send = (method: string, body?: unknown, headers: Headers_ = {}): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
