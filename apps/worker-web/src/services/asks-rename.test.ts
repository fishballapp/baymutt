/**
 * Migration 0008: `plan`, `plan_step` and `plan_item` become `ask`, `ask_step` and `ask_item`, and
 * `plan_id` becomes `ask_id`. Built on a store at 0007 that holds every shape an ask can be in, with
 * values, hints and notes sealed for real before the migration, then read row by row, opened from
 * what the Worker serves after it, and loaded the way a 0.11.0 CLI loads.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  generateServiceAccountToken,
  openHint,
  openNote,
  openProposedValue,
  sealHint,
  sealNote,
  sealProposedValue,
  serviceAccountKeyFromToken,
} from '@baymutt/keys';
import { tokenHash } from '@baymutt/keys/wire';
import { json } from '@internal/effect-worker/testing';
import { describe, expect, it } from 'vitest';
import { indexOf, sealedOf, VAULT_PROOF } from '../test-store.ts';
import { keyLike, sealedLike, send, testWorld } from '../test-support.ts';

const NOW = Date.now();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const ORG = 'org-one';
const PRODUCTION = '10000000-0000-4000-8000-000000000001';
/** An environment the waiting ask's first step creates: it does not exist yet. */
const PREVIEW = '10000000-0000-4000-8000-000000000002';

const ASK = {
  waiting: '20000000-0000-4000-8000-000000000001',
  approved: '20000000-0000-4000-8000-000000000002',
  rejected: '20000000-0000-4000-8000-000000000003',
  expired: '20000000-0000-4000-8000-000000000004',
  cancelled: '20000000-0000-4000-8000-000000000005',
} as const;

const BY_OWNER = JSON.stringify({ kind: 'owner', id: 'a', name: 'u' });

const insert = (db: DatabaseSync, table: string, rows: ReadonlyArray<Record<string, unknown>>) => {
  for (const row of rows) {
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO "${table}" (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    ).run(...(Object.values(row) as (string | number | null)[]));
  }
};

const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all();

/** Every row of every table, by table: what the migration must leave as it was. */
const everyRow = (db: DatabaseSync) =>
  Object.fromEntries(
    (
      all(
        db,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      ) as Array<{ name: string }>
    ).map(({ name }) => [name, all(db, `SELECT * FROM "${name}" ORDER BY 1, 2, 3`)]),
  );

const keyOf = async () => serviceAccountKeyFromToken(generateServiceAccountToken());

/** What the store held at 0007, sealed with real keys, and a snapshot of every row. */
const seed = async () => {
  const account = await keyOf();
  const login = await keyOf();
  const reader = await keyOf();
  /** The key the waiting ask's `access` step makes. */
  const asked = await keyOf();
  const keys = { account, login, reader, asked };

  const valueSlot = { askId: ASK.waiting, stepIndex: 1, environmentId: PREVIEW, name: 'API_KEY' };
  const hintSlot = { ...valueSlot, name: 'STRIPE_KEY' };
  const sealed = {
    value: await sealProposedValue({
      loginKey: login.privateKey,
      accountPublicKey: account.publicKey,
      slot: valueSlot,
      value: 'sk_test_proposed',
    }),
    hint: await sealHint({
      loginKey: login.privateKey,
      accountPublicKey: account.publicKey,
      slot: hintSlot,
      hint: 'Stripe dashboard, Developers, API keys',
    }),
    approvedNote: await sealNote({
      accountKey: account.privateKey,
      loginPublicKey: login.publicKey,
      step: { askId: ASK.approved, stepIndex: 0, decision: 'approved' },
      note: 'set, carry on',
    }),
    rejectedNote: await sealNote({
      accountKey: account.privateKey,
      loginPublicKey: login.publicKey,
      step: { askId: ASK.rejected, stepIndex: 0, decision: 'rejected' },
      note: 'not this one',
    }),
  };
  const kept: { rows: Record<string, unknown[]> } = { rows: {} };

  const run = (db: DatabaseSync) => {
    db.exec(`
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('u', 'u', 'u@example.test', 1, 'now', 'now');
      INSERT INTO organization (id, name, slug, createdAt) VALUES ('${ORG}', 'One', 'one', 'now');
      INSERT INTO member (id, organizationId, userId, role, createdAt)
        VALUES ('m', '${ORG}', 'u', 'owner', 'now');
    `);
    insert(db, 'store_account', [
      {
        id: 'a',
        user_id: 'u',
        name: 'u',
        public_key: account.publicKey,
        encrypted_private_key: sealedLike('sk'),
        recovery_wrapped_dek: sealedLike('dek'),
        vault_proof_hash: VAULT_PROOF_HASH,
        created_at: NOW - 30 * 24 * HOUR,
      },
    ]);
    insert(db, 'environment', [
      {
        id: PRODUCTION,
        org_id: ORG,
        name: indexOf(ORG, 'app/production'),
        sealed_name: sealedOf('app/production'),
        public_key: keyLike('p'),
        key_version: 1,
        created_by: BY_OWNER,
        created_at: NOW - 20 * 24 * HOUR,
      },
    ]);
    insert(db, 'member_wrap', [
      {
        environment_id: PRODUCTION,
        account_id: 'a',
        wrap: sealedLike('member', 120),
        proof: sealedLike('member-proof', 100),
        key_version: 1,
        created_at: NOW - 20 * 24 * HOUR,
      },
    ]);
    const credential = (
      key: Awaited<ReturnType<typeof keyOf>>,
      name: string,
      isLogin: boolean,
    ) => ({
      id: key.credentialId,
      account_id: 'a',
      name,
      description: isLogin ? null : `why ${name}`,
      public_key: key.publicKey,
      bearer_hash: key.bearerHash,
      parent_id: isLogin ? null : login.credentialId,
      endorsement: isLogin ? sealedLike('endorsement', 100) : null,
      key_voucher_owner: isLogin ? null : sealedLike('to-owner', 100),
      key_voucher_maker: isLogin ? null : sealedLike('to-maker', 100),
      account_voucher: isLogin ? null : sealedLike('account', 100),
      created_at: NOW - 6 * HOUR,
      intent: isLogin ? null : 'agent',
      org_id: isLogin ? null : ORG,
    });
    insert(db, 'credential', [
      credential(login, 'laptop', true),
      credential(reader, 'reader', false),
      credential(asked, 'deploy', false),
    ]);
    insert(db, 'environment_grant', [
      {
        environment_id: PRODUCTION,
        credential_id: reader.credentialId,
        read_wrap: sealedLike('reader-wrap', 120),
        key_proof: sealedLike('reader-proof', 100),
        key_version: 1,
        created_at: NOW - 5 * HOUR,
      },
    ]);
    insert(
      db,
      'names_key_wrap',
      ['a', login.credentialId, reader.credentialId].map(reader_id => ({
        org_id: ORG,
        reader_id,
        wrap: sealedLike(`names-${reader_id}`, 80),
        created_at: NOW - 6 * HOUR,
      })),
    );
    insert(db, 'secret', [
      {
        environment_id: PRODUCTION,
        name: indexOf(PRODUCTION, 'API_KEY'),
        sealed_name: sealedOf('API_KEY'),
        current_version: 2,
        latest_version: 2,
        updated_at: NOW - HOUR,
        updated_by: BY_OWNER,
        write_id: 'w1',
      },
    ]);
    insert(
      db,
      'secret_version',
      [1, 2].map(version => ({
        environment_id: PRODUCTION,
        name: indexOf(PRODUCTION, 'API_KEY'),
        version,
        key_version: 1,
        ciphertext: sealedLike(`api-key-v${version}`, 96),
        created_by: BY_OWNER,
        created_at: NOW - (3 - version) * HOUR,
      })),
    );

    insert(
      db,
      'plan',
      [
        { id: ASK.waiting, reason: 'set up the preview', created_at: NOW - 10 * MINUTE },
        { id: ASK.approved, reason: 'rotate the key', created_at: NOW - 3 * HOUR },
        { id: ASK.rejected, reason: 'a second key', created_at: NOW - 3 * HOUR },
        { id: ASK.expired, reason: 'nobody came', created_at: NOW - 3 * HOUR },
        {
          id: ASK.cancelled,
          reason: 'changed my mind',
          created_at: NOW - 20 * MINUTE,
          cancelled_at: NOW - 15 * MINUTE,
        },
      ].map(row => ({ org_id: ORG, credential_id: login.credentialId, ...row })),
    );
    insert(db, 'plan_step', [
      // Waiting: a new environment, then values for it, which wait for it; then a new key.
      { plan_id: ASK.waiting, position: 0, type: 'environments', status: 'pending' },
      { plan_id: ASK.waiting, position: 1, type: 'secrets', status: 'pending', reason: 'its keys' },
      {
        plan_id: ASK.waiting,
        position: 2,
        type: 'access',
        status: 'pending',
        key_id: asked.credentialId,
        key_end: 'after',
        lifetime: HOUR,
        command: 'gh secret set BAYMUTT_KEY',
      },
      {
        plan_id: ASK.approved,
        position: 0,
        type: 'secrets',
        status: 'approved',
        note: sealed.approvedNote,
        resolved_at: NOW - 2 * HOUR,
        answer_id: 'answer-approved',
      },
      // A change that only gave a read back, which took effect at once.
      {
        plan_id: ASK.approved,
        position: 1,
        type: 'change',
        status: 'applied',
        key_id: reader.credentialId,
        key_end: 'keep',
        resolved_at: NOW - 3 * HOUR,
      },
      {
        plan_id: ASK.rejected,
        position: 0,
        type: 'secrets',
        status: 'rejected',
        note: sealed.rejectedNote,
        resolved_at: NOW - 2 * HOUR,
        answer_id: 'answer-rejected',
      },
      // One the daily run wrote down, and one still pending past its hour.
      {
        plan_id: ASK.expired,
        position: 0,
        type: 'secrets',
        status: 'expired',
        resolved_at: NOW - HOUR,
      },
      { plan_id: ASK.expired, position: 1, type: 'environments', status: 'pending' },
      {
        plan_id: ASK.cancelled,
        position: 0,
        type: 'secrets',
        status: 'cancelled',
        resolved_at: NOW - 15 * MINUTE,
      },
    ]);
    const secretItem = (name: string) => ({
      environment_id: PRODUCTION,
      secret_name: indexOf(PRODUCTION, name),
      secret_sealed_name: sealedOf(name),
    });
    insert(db, 'plan_item', [
      {
        plan_id: ASK.waiting,
        step_position: 0,
        position: 0,
        op: 'create',
        environment_id: PREVIEW,
        environment_name: indexOf(ORG, 'app/preview'),
        environment_sealed_name: sealedOf('app/preview'),
      },
      {
        plan_id: ASK.waiting,
        step_position: 1,
        position: 0,
        op: 'set',
        environment_id: PREVIEW,
        secret_name: indexOf(PREVIEW, 'API_KEY'),
        secret_sealed_name: sealedOf('API_KEY'),
        proposed_value: sealed.value,
      },
      {
        plan_id: ASK.waiting,
        step_position: 1,
        position: 1,
        op: 'paste',
        environment_id: PREVIEW,
        secret_name: indexOf(PREVIEW, 'STRIPE_KEY'),
        secret_sealed_name: sealedOf('STRIPE_KEY'),
        sealed_hint: sealed.hint,
      },
      {
        plan_id: ASK.waiting,
        step_position: 2,
        position: 0,
        op: 'read',
        environment_id: PRODUCTION,
      },
      // Answered: what it proposed was cleared, as answering does.
      { plan_id: ASK.approved, step_position: 0, position: 0, op: 'set', ...secretItem('API_KEY') },
      {
        plan_id: ASK.approved,
        step_position: 1,
        position: 0,
        op: 'give-back',
        environment_id: PRODUCTION,
      },
      {
        plan_id: ASK.rejected,
        step_position: 0,
        position: 0,
        op: 'generate',
        ...secretItem('NEW'),
      },
      {
        plan_id: ASK.expired,
        step_position: 0,
        position: 0,
        op: 'rollback',
        ...secretItem('API_KEY'),
        version: 1,
      },
      {
        plan_id: ASK.expired,
        step_position: 1,
        position: 0,
        op: 'delete',
        environment_id: PRODUCTION,
      },
      {
        plan_id: ASK.cancelled,
        step_position: 0,
        position: 0,
        op: 'delete',
        ...secretItem('API_KEY'),
      },
    ]);
    // What 0.11.0 logged about asks, beside what this release still logs.
    insert(
      db,
      'activity_event',
      (['plan.create', 'step.approve', 'plan.cancel'] as const).map((action, at) => ({
        id: `01J00000000000000000000${at}`,
        org_id: ORG,
        at: NOW - HOUR + at,
        actor: JSON.stringify({ kind: 'credential', id: login.credentialId, name: 'laptop' }),
        action,
        detail: action === 'step.approve' ? 'step 1: secrets' : 'set up the preview',
      })),
    );
    kept.rows = everyRow(db);
  };

  return { legacy: { before: '0008', seed: run }, kept, keys, sealed };
};

const VAULT_PROOF_HASH = await tokenHash(VAULT_PROOF);

/** A store seeded at 0007, migrated to now, and the Worker over it. */
const migrated = async () => {
  const { legacy, kept, keys, sealed } = await seed();
  const world = testWorld({ legacy });
  const owner = { ...world.signIn('u'), 'x-baymutt-vault-proof': VAULT_PROOF };
  const asLogin = { authorization: `Bearer ${keys.login.bearer}` };
  const get = async (path: string, headers: Record<string, string>) =>
    json(await world.api(`/api/v1${path}`, { headers }));
  return { world, sqlite: world.sqlite, kept: kept.rows, keys, sealed, owner, asLogin, get };
};

/** The rows of a renamed table as they were stored before: `ask_id` back under its old name. */
const asStoredBefore = (rows: unknown[]) =>
  (rows as Array<Record<string, unknown>>).map(({ ask_id, ...row }) =>
    ask_id === undefined ? row : { plan_id: ask_id, ...row },
  );

type Body = Record<string, unknown> & {
  steps: Array<Record<string, unknown> & { items?: Array<Record<string, unknown>> }>;
};

describe('migration 0008', () => {
  it('renames the tables, their column and their indexes, and nothing else', async () => {
    const { sqlite, kept } = await migrated();
    const tables = all(sqlite, "SELECT name FROM sqlite_master WHERE type = 'table'").map(
      row => row.name,
    );
    expect(tables).toEqual(expect.arrayContaining(['ask', 'ask_step', 'ask_item']));
    for (const gone of ['plan', 'plan_step', 'plan_item']) expect(tables).not.toContain(gone);
    expect(tables.toSorted()).toEqual(
      Object.keys(kept)
        .map(name => name.replace(/^plan/, 'ask'))
        .toSorted(),
    );
    expect(
      all(
        sqlite,
        "SELECT name FROM sqlite_master WHERE sql LIKE '%plan%' OR name LIKE '%plan%' ORDER BY name",
      ),
    ).toEqual([]);
    expect(
      all(
        sqlite,
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE 'ask%' AND sql IS NOT NULL ORDER BY name",
      ),
    ).toEqual([
      { name: 'ask_credential_idx', tbl_name: 'ask' },
      { name: 'ask_item_environment_idx', tbl_name: 'ask_item' },
      { name: 'ask_org_idx', tbl_name: 'ask' },
      { name: 'ask_step_key_idx', tbl_name: 'ask_step' },
      { name: 'ask_step_status_idx', tbl_name: 'ask_step' },
    ]);
  });

  it('points each foreign key at the renamed table, and every row still meets them', async () => {
    const { sqlite } = await migrated();
    expect(all(sqlite, 'PRAGMA foreign_key_list(ask_step)')).toContainEqual(
      expect.objectContaining({ table: 'ask', from: 'ask_id', to: 'id', on_delete: 'CASCADE' }),
    );
    expect(all(sqlite, 'PRAGMA foreign_key_list(ask_item)')).toEqual([
      expect.objectContaining({ table: 'ask_step', from: 'ask_id', to: 'ask_id', seq: 0 }),
      expect.objectContaining({ table: 'ask_step', from: 'step_position', to: 'position', seq: 1 }),
    ]);
    expect(all(sqlite, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(all(sqlite, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  });

  it('keeps every row of every table byte for byte, the sealed ones included', async () => {
    const { sqlite, kept } = await migrated();
    const after = everyRow(sqlite);
    for (const [table, rows] of Object.entries(kept)) {
      const renamed = table.replace(/^plan/, 'ask');
      expect(asStoredBefore(after[renamed] ?? [])).toEqual(rows);
    }
    expect(kept.plan_item).toHaveLength(10);
    expect(kept.plan_step).toHaveLength(9);
  });

  it('cascades as before: removing an ask removes its steps and items', async () => {
    const { sqlite } = await migrated();
    sqlite.prepare('DELETE FROM ask WHERE id = ?').run(ASK.cancelled);
    expect(all(sqlite, `SELECT * FROM ask_step WHERE ask_id = '${ASK.cancelled}'`)).toEqual([]);
    expect(all(sqlite, `SELECT * FROM ask_item WHERE ask_id = '${ASK.cancelled}'`)).toEqual([]);
  });

  it('serves a waiting ask whose value and hint, sealed before, open after', async () => {
    const { keys, sealed, owner, get } = await migrated();
    const answer = await get(`/asks/${ASK.waiting}`, owner);
    expect(answer.status).toBe(200);
    const ask = answer.body as Body;
    expect(ask).toMatchObject({
      id: ASK.waiting,
      reason: 'set up the preview',
      maker: { id: keys.login.credentialId, publicKey: keys.login.publicKey },
      cancelledAt: null,
    });
    expect(ask.steps.map(({ type, status, waitsFor }) => ({ type, status, waitsFor }))).toEqual([
      { type: 'environments', status: 'pending', waitsFor: [] },
      // Its values name the environment step 0 creates, so it waits for that one.
      { type: 'secrets', status: 'pending', waitsFor: [0] },
      { type: 'access', status: 'pending', waitsFor: [] },
    ]);
    const [set, paste] = ask.steps[1]?.items ?? [];
    expect(set).toMatchObject({ op: 'set', value: sealed.value });
    expect(paste).toMatchObject({ op: 'paste', sealedHint: sealed.hint });
    expect(
      await openProposedValue({
        accountKey: keys.account.privateKey,
        loginPublicKey: keys.login.publicKey,
        slot: { askId: ask.id as string, stepIndex: 1, environmentId: PREVIEW, name: 'API_KEY' },
        ciphertext: set?.value as string,
      }),
    ).toBe('sk_test_proposed');
    expect(
      await openHint({
        accountKey: keys.account.privateKey,
        loginPublicKey: keys.login.publicKey,
        slot: { askId: ask.id as string, stepIndex: 1, environmentId: PREVIEW, name: 'STRIPE_KEY' },
        ciphertext: paste?.sealedHint as string,
      }),
    ).toBe('Stripe dashboard, Developers, API keys');
    expect(ask.steps[2]).toMatchObject({
      key: { id: keys.asked.credentialId, publicKey: keys.asked.publicKey },
      command: 'gh secret set BAYMUTT_KEY',
      end: HOUR,
    });
  });

  it('serves each answered ask as it was answered, its notes opening for the login that asked', async () => {
    const { keys, owner, asLogin, get } = await migrated();
    const read = async (id: string, headers: Record<string, string>) => {
      const answer = await get(`/asks/${id}`, headers);
      expect(answer.status).toBe(200);
      return answer.body as Body;
    };
    const statuses = async (id: string) =>
      (await read(id, owner)).steps.map(({ status }) => status);
    expect(await statuses(ASK.approved)).toEqual(['approved', 'applied']);
    expect(await statuses(ASK.rejected)).toEqual(['rejected']);
    // The step past its hour is expired however it is read, written down or not.
    expect(await statuses(ASK.expired)).toEqual(['expired', 'expired']);
    expect(await statuses(ASK.cancelled)).toEqual(['cancelled']);
    expect(await read(ASK.cancelled, owner)).toMatchObject({ cancelledAt: NOW - 15 * MINUTE });

    for (const [id, decision, note] of [
      [ASK.approved, 'approved', 'set, carry on'],
      [ASK.rejected, 'rejected', 'not this one'],
    ] as const) {
      const ask = await read(id, asLogin);
      expect(
        await openNote({
          loginKey: keys.login.privateKey,
          accountPublicKey: keys.account.publicKey,
          step: { askId: id, stepIndex: 0, decision },
          ciphertext: ask.steps[0]?.note as string,
        }),
      ).toBe(note);
    }
  });

  it('lists only the waiting ask, and answers a step of it through the renamed tables', async () => {
    const { owner, get, world, sqlite } = await migrated();
    const listed = await get(`/asks?orgId=${ORG}`, owner);
    expect(listed.status).toBe(200);
    expect((listed.body as { asks: Array<{ id: string }> }).asks.map(({ id }) => id)).toEqual([
      ASK.waiting,
    ]);
    const rejected = await json(
      await world.api(`/api/v1/asks/${ASK.waiting}/steps/2/reject`, send('POST', {}, owner)),
    );
    expect(rejected).toMatchObject({ status: 200 });
    expect(
      all(sqlite, `SELECT status FROM ask_step WHERE ask_id = '${ASK.waiting}' ORDER BY position`),
    ).toEqual([{ status: 'pending' }, { status: 'pending' }, { status: 'rejected' }]);
    expect(all(sqlite, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('reads the activity 0.11.0 logged as it was written', async () => {
    const { owner, get } = await migrated();
    const answer = await get(`/activity?orgId=${ORG}`, owner);
    expect(answer.status).toBe(200);
    expect(
      (answer.body as { events: Array<{ action: string; detail: string }> }).events.map(
        ({ action, detail }) => ({ action, detail }),
      ),
    ).toEqual([
      { action: 'plan.cancel', detail: 'set up the preview' },
      { action: 'step.approve', detail: 'step 1: secrets' },
      { action: 'plan.create', detail: 'set up the preview' },
    ]);
  });

  // A 0.11.0 CLI or plugin loads with `GET /environments` and the bundle, and decodes both whole:
  // their shapes are pinned here as that release reads them.
  it('loads for a key as it did, in the shapes a 0.11.0 CLI and plugin decode', async () => {
    const { keys, get } = await migrated();
    const asReader = { authorization: `Bearer ${keys.reader.bearer}` };
    expect(await get('/environments', asReader)).toEqual({
      status: 200,
      body: {
        environments: [
          {
            id: PRODUCTION,
            orgId: ORG,
            orgSlug: 'one',
            name: indexOf(ORG, 'app/production'),
            sealedName: sealedOf('app/production'),
            publicKey: keyLike('p'),
            keyVersion: 1,
            keyProof: sealedLike('reader-proof', 100),
            secretCount: 1,
            createdAt: NOW - 20 * 24 * HOUR,
            createdBy: { kind: 'owner', id: 'a', name: 'u' },
            canRead: true,
            canWrite: false,
          },
        ],
        namesKeys: [{ orgId: ORG, wrap: sealedLike(`names-${keys.reader.credentialId}`, 80) }],
      },
    });
    expect(await get(`/environments/${PRODUCTION}/bundle`, asReader)).toEqual({
      status: 200,
      body: {
        environment: {
          id: PRODUCTION,
          name: indexOf(ORG, 'app/production'),
          sealedName: sealedOf('app/production'),
          publicKey: keyLike('p'),
          keyVersion: 1,
        },
        wrap: sealedLike('reader-wrap', 120),
        readerId: keys.reader.credentialId,
        secrets: [
          {
            name: indexOf(PRODUCTION, 'API_KEY'),
            sealedName: sealedOf('API_KEY'),
            version: 2,
            keyVersion: 1,
            ciphertext: sealedLike('api-key-v2', 96),
          },
        ],
      },
    });
  });
});
