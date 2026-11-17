/**
 * A key belongs to exactly one org: the store refuses an ask, a key change or a grant across
 * orgs, and migration 0005 gave each existing key its org.
 */
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createTestD1 } from '@internal/effect-worker/testing';
import { describe, expect, it } from 'vitest';
import { call, NAMES_KEY_WRAP, ok, storeWorld } from '../test-store.ts';
import { sealedLike, send } from '../test-support.ts';

/** The org a key belongs to, as the store has it. */
const orgOfKey = (w: { sqlite: DatabaseSync }, keyId: string) =>
  (w.sqlite.prepare('SELECT org_id FROM credential WHERE id = ?').get(keyId) as { org_id: string })
    .org_id;

describe('a key', () => {
  const setup = async () => {
    const world = await storeWorld();
    const other = await world.org('other');
    const production = await world.environment('app/production');
    const elsewhere = await world.environment('app/production', other);
    const login = await world.pair('laptop');
    return { ...world, other, production, elsewhere, login };
  };

  it('belongs to the org of the environments it was asked for, and an ask across orgs is refused', async () => {
    const { w, owner, orgId, production, elsewhere, login, ask, approve } = await setup();

    const across = await ask(login, [
      { environmentId: production, read: true },
      { environmentId: elsewhere, read: true },
    ]);
    expect(across.answer).toMatchObject({
      status: 400,
      body: {
        code: 'InvalidRequestError',
        message: expect.stringMatching(/belongs to one org.*2 \(org-user-1, other\).*once per org/),
      },
    });
    expect(w.sqlite.prepare('SELECT COUNT(*) AS n FROM access_request').get()).toEqual({ n: 0 });

    const request = await ask(login, [{ environmentId: production, read: true }], {
      name: 'deploy',
    });
    expect(request.answer).toMatchObject({
      status: 201,
      body: { org: { id: orgId, slug: 'org-user-1' } },
    });
    await approve(request.id);
    const { credentials } = await ok<{
      credentials: Array<{ id: string; org: { id: string; slug: string } | null }>;
    }>(w, 'GET', '/credentials', owner);
    expect(credentials.map(({ id, org }) => ({ id, org }))).toEqual([
      { id: login.id, org: null },
      { id: request.id, org: { id: orgId, slug: 'org-user-1' } },
    ]);
  });

  it('is changed to add environments of its own org only, and keeps its org once it holds nothing', async () => {
    const { w, owner, orgId, production, elsewhere, login, serviceAccount } = await setup();
    const key = await serviceAccount([{ environmentId: production, read: true }], {
      maker: login,
    });
    const change = (body: { add: unknown[]; giveBack: string[] }) =>
      call(w, 'POST', '/key-changes', login.headers, {
        id: crypto.randomUUID(),
        keyId: key.id,
        reason: 'more',
        lifetime: null,
        ...body,
      });

    expect(
      await change({
        add: [{ environmentId: elsewhere, canRead: true, canWrite: false }],
        giveBack: [],
      }),
    ).toMatchObject({
      status: 400,
      body: {
        code: 'InvalidRequestError',
        message: expect.stringMatching(/belongs to org-user-1/),
      },
    });
    expect(await change({ add: [], giveBack: [production] })).toMatchObject({
      status: 201,
      body: { status: 'applied', org: { id: orgId } },
    });
    const { credentials } = await ok<{
      credentials: Array<{ id: string; org: unknown; grants: unknown[] }>;
    }>(w, 'GET', '/credentials', owner);
    expect(credentials.find(({ id }) => id === key.id)).toMatchObject({
      org: { id: orgId },
      grants: [],
    });
  });

  it('is given access by the owner on environments of its own org only', async () => {
    const { w, owner, production, elsewhere, login, serviceAccount } = await setup();
    const key = await serviceAccount([{ environmentId: production, read: true }], {
      maker: login,
    });
    const refused = { status: 400, body: { code: 'InvalidRequestError' } };
    expect(
      await call(w, 'PUT', `/credentials/${key.id}/grants/${elsewhere}`, owner, {
        canRead: false,
        canWrite: true,
        keyProof: sealedLike('key-proof'),
      }),
    ).toMatchObject(refused);
    expect(
      await call(w, 'PUT', `/environments/${elsewhere}/grants/${key.id}`, owner, {
        canWrite: true,
        readWrap: null,
        keyProof: sealedLike('key-proof'),
        keyVersion: 1,
      }),
    ).toMatchObject(refused);
    expect(
      w.sqlite
        .prepare('SELECT COUNT(*) AS n FROM environment_grant WHERE environment_id = ?')
        .get(elsewhere),
    ).toEqual({ n: 0 });
  });

  it('gets the names key of its own org alone: sealing, a wrap put later, and the list refuse or leave out another', async () => {
    const { w, owner, accountId, org, production, login, serviceAccount, seal } = await setup();
    const key = await serviceAccount([{ environmentId: production, read: true }], {
      maker: login,
    });
    const third = await org('third', { isSealed: false });
    const unsealed = await ok<{ environments: unknown[]; secrets: unknown[] }>(
      w,
      'GET',
      `/orgs/${third}/unsealed-names`,
      owner,
    );
    expect(
      await call(w, 'POST', `/orgs/${third}/seal-names`, owner, {
        wraps: [accountId, login.id, key.id].map(readerId => ({ readerId, wrap: NAMES_KEY_WRAP })),
        ...unsealed,
      }),
    ).toMatchObject({ status: 400, body: { code: 'InvalidRequestError' } });
    await seal(third);
    expect(
      await call(w, 'PUT', `/orgs/${third}/names-key-wraps/${key.id}`, owner, {
        wrap: NAMES_KEY_WRAP,
      }),
    ).toMatchObject({ status: 400, body: { code: 'InvalidRequestError' } });
    await ok(w, 'PUT', `/orgs/${third}/names-key-wraps/${login.id}`, owner, {
      wrap: NAMES_KEY_WRAP,
    });
    // A row left from before 0.10 is not handed out.
    w.sqlite
      .prepare(
        'INSERT INTO names_key_wrap (org_id, reader_id, wrap, created_at) VALUES (?, ?, ?, 0)',
      )
      .run(third, key.id, NAMES_KEY_WRAP);
    const listed = await ok<{ namesKeys: Array<{ orgId: string }> }>(
      w,
      'GET',
      '/environments',
      key.headers,
    );
    expect(listed.namesKeys.map(({ orgId }) => orgId)).toEqual([orgOfKey(w, key.id)]);
    const byLogin = await ok<{ namesKeys: Array<{ orgId: string }> }>(
      w,
      'GET',
      '/environments',
      login.headers,
    );
    expect(byLogin.namesKeys.map(({ orgId }) => orgId)).toContain(third);
  });

  it('goes with its org when the org is deleted', async () => {
    const { w, owner, other, elsewhere, login, serviceAccount } = await setup();
    const key = await serviceAccount([{ environmentId: elsewhere, read: true }], { maker: login });
    await ok(w, 'DELETE', `/environments/${elsewhere}`, owner);
    // A purge answers 204, with no body.
    const purged = await w.api(
      `/api/v1/environments/${elsewhere}/purge`,
      send('POST', undefined, owner),
    );
    expect(purged.status).toBe(204);
    await ok(w, 'DELETE', `/orgs/${other}`, owner);
    expect(w.sqlite.prepare('SELECT id FROM credential WHERE id = ?').get(key.id)).toBeUndefined();
    expect(w.sqlite.prepare('SELECT id FROM credential WHERE id = ?').get(login.id)).toBeDefined();
  });
});

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url).href);

const NOW = 1_700_000_000_000;

/** An account in two orgs, `one` and `two`, each with an environment, and a CLI login `login`. */
const seedAccount = (db: DatabaseSync) =>
  db.exec(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES ('u', 'u', 'u@example.test', 1, 'now', 'now');
    INSERT INTO store_account (id, user_id, name, public_key, encrypted_private_key,
      recovery_wrapped_dek, vault_proof_hash, created_at)
      VALUES ('a', 'u', 'u', 'pk', 'sk', 'dek', 'proof', ${NOW});
    INSERT INTO organization (id, name, slug, createdAt)
      VALUES ('one', 'One', 'one', 'now'), ('two', 'Two', 'two', 'now');
    INSERT INTO member (id, organizationId, userId, role, createdAt)
      VALUES ('m1', 'one', 'u', 'owner', 'now'), ('m2', 'two', 'u', 'owner', 'now');
    INSERT INTO environment (id, org_id, name, public_key, key_version, created_by, created_at)
      VALUES ('e1', 'one', 'app', 'pk', 1, '{}', ${NOW}), ('e2', 'two', 'app', 'pk', 1, '{}', ${NOW});
    INSERT INTO credential (id, account_id, name, public_key, bearer_hash, parent_id, created_at)
      VALUES ('login', 'a', 'laptop', 'pk', 'h', NULL, ${NOW});
  `);

it('gives a key the org of its request, its grants or its key changes, and a CLI login none', () => {
  const { sqlite } = createTestD1({
    migrationsDir,
    legacy: {
      before: '0005',
      seed: db => {
        seedAccount(db);
        db.exec(`
          INSERT INTO credential (id, account_id, name, public_key, bearer_hash, parent_id, created_at, revoked_at)
            VALUES ('asked', 'a', 'asked', 'pk', 'h', 'login', ${NOW}, NULL),
                   ('granted', 'a', 'granted', 'pk', 'h', 'login', ${NOW}, NULL),
                   ('gave-back', 'a', 'gave-back', 'pk', 'h', 'login', ${NOW}, NULL),
                   ('revoked', 'a', 'revoked', 'pk', '', 'login', ${NOW}, ${NOW});
          INSERT INTO access_request (credential_id, status, command, lifetime, created_at)
            VALUES ('asked', 'pending', NULL, NULL, ${NOW});
          INSERT INTO access_request_item (credential_id, environment_id, can_read, can_write)
            VALUES ('asked', 'e2', 1, 0);
          INSERT INTO environment_grant (environment_id, credential_id, can_write, read_wrap, key_proof, key_version, created_at)
            VALUES ('e1', 'granted', 1, NULL, 'proof', 1, ${NOW});
          INSERT INTO key_change (id, credential_id, status, reason, lifetime, created_at, resolved_at)
            VALUES ('k', 'gave-back', 'applied', 'done', NULL, ${NOW}, ${NOW});
          INSERT INTO key_change_item (change_id, environment_id, can_read, can_write, gives_back)
            VALUES ('k', 'e2', 1, 0, 1);
        `);
      },
    },
  });
  const orgs = Object.fromEntries(
    (
      sqlite.prepare('SELECT id, org_id FROM credential').all() as {
        id: string;
        org_id: string | null;
      }[]
    ).map(({ id, org_id }) => [id, org_id]),
  );
  expect(orgs).toEqual({
    login: null,
    asked: 'two',
    granted: 'one',
    // It holds nothing now, and still belongs to the org it gave back to.
    'gave-back': 'two',
    // Revoked, with nothing to tell its org by: nothing lists it.
    revoked: null,
  });
  expect(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'key_org_%'").all(),
  ).toEqual([]);
});

it('stops on a key that spans orgs rather than pick one', () => {
  expect(() =>
    createTestD1({
      migrationsDir,
      legacy: {
        before: '0005',
        seed: db => {
          seedAccount(db);
          db.exec(`
            INSERT INTO credential (id, account_id, name, public_key, bearer_hash, parent_id, created_at)
              VALUES ('both', 'a', 'both', 'pk', 'h', 'login', ${NOW});
            INSERT INTO environment_grant (environment_id, credential_id, can_write, read_wrap, key_proof, key_version, created_at)
              VALUES ('e1', 'both', 1, NULL, 'proof', 1, ${NOW}), ('e2', 'both', 1, NULL, 'proof', 1, ${NOW});
          `);
        },
      },
    }),
  ).toThrow(/CHECK constraint failed/);
});

it('revokes a live key with nothing to tell its org by, and guesses none for it', () => {
  const { sqlite } = createTestD1({
    migrationsDir,
    legacy: {
      before: '0005',
      seed: db => {
        seedAccount(db);
        db.exec(`
          INSERT INTO credential (id, account_id, name, public_key, bearer_hash, parent_id, created_at)
            VALUES ('bare', 'a', 'bare', 'pk', 'h', 'login', ${NOW});
          INSERT INTO access_request (credential_id, status, command, lifetime, created_at)
            VALUES ('bare', 'pending', NULL, NULL, ${NOW});
        `);
      },
    },
  });
  expect(
    sqlite
      .prepare('SELECT org_id, revoked_at, bearer_hash FROM credential WHERE id = ?')
      .get('bare'),
  ).toMatchObject({ org_id: null, revoked_at: expect.any(Number), bearer_hash: '' });
  expect(
    sqlite.prepare('SELECT status FROM access_request WHERE credential_id = ?').get('bare'),
  ).toEqual({ status: 'expired' });
  expect(sqlite.prepare('SELECT revoked_at FROM credential WHERE id = ?').get('login')).toEqual({
    revoked_at: null,
  });
});

it('takes back the names key of another org from a key, and leaves a CLI login’s and the account’s', () => {
  const { sqlite } = createTestD1({
    migrationsDir,
    legacy: {
      before: '0005',
      seed: db => {
        seedAccount(db);
        db.exec(`
          INSERT INTO credential (id, account_id, name, public_key, bearer_hash, parent_id, created_at)
            VALUES ('key', 'a', 'key', 'pk', 'h', 'login', ${NOW});
          INSERT INTO environment_grant (environment_id, credential_id, can_write, read_wrap, key_proof, key_version, created_at)
            VALUES ('e1', 'key', 1, NULL, 'proof', 1, ${NOW});
          INSERT INTO names_key_wrap (org_id, reader_id, wrap, created_at)
            VALUES ('one', 'a', 'w', ${NOW}), ('two', 'a', 'w', ${NOW}),
                   ('one', 'login', 'w', ${NOW}), ('two', 'login', 'w', ${NOW}),
                   ('one', 'key', 'w', ${NOW}), ('two', 'key', 'w', ${NOW});
        `);
      },
    },
  });
  expect(
    sqlite.prepare('SELECT org_id, reader_id FROM names_key_wrap ORDER BY reader_id, org_id').all(),
  ).toEqual([
    { org_id: 'one', reader_id: 'a' },
    { org_id: 'two', reader_id: 'a' },
    { org_id: 'one', reader_id: 'key' },
    { org_id: 'one', reader_id: 'login' },
    { org_id: 'two', reader_id: 'login' },
  ]);
});
