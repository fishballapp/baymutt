/**
 * Migration 0007: every key loses write, a key that held only write or never became one is
 * revoked, and the tables of the asks a plan replaced go. Built on a store at 0006 that holds every
 * shape a live vault can, then read row by row, and through the Worker's own read path.
 */
import type { DatabaseSync } from 'node:sqlite';
import { tokenHash } from '@baymutt/keys/wire';
import { json } from '@internal/effect-worker/testing';
import { describe, expect, it } from 'vitest';
import { indexOf, sealedOf } from '../test-store.ts';
import { keyLike, sealedLike, testWorld } from '../test-support.ts';

const NOW = Date.now();
const HOUR = 3600 * 1000;

/** Fixed ids: a key's id is the UUID in its bearer. */
const ID = {
  login: '00000000-0000-4000-8000-000000000001',
  // A key that reads: approved, read only.
  reader: '00000000-0000-4000-8000-000000000002',
  // Approved for read and write on production, and write alone on staging.
  both: '00000000-0000-4000-8000-000000000003',
  // Approved for write alone.
  writer: '00000000-0000-4000-8000-000000000004',
  // Asked for and not answered.
  pending: '00000000-0000-4000-8000-000000000005',
  // Rejected or expired, and never tidied away.
  rejected: '00000000-0000-4000-8000-000000000006',
  expired: '00000000-0000-4000-8000-000000000007',
  // Rejected and revoked at the time, as rejecting does.
  closed: '00000000-0000-4000-8000-000000000008',
  // Approved, then gave everything back: held nothing before the migration.
  empty: '00000000-0000-4000-8000-000000000009',
  // From before requests (0.7): no request row, a read grant.
  old: '00000000-0000-4000-8000-00000000000a',
  // An `access` step's key, waiting for the owner.
  planned: '00000000-0000-4000-8000-00000000000b',
} as const;

const ORG = 'org-one';
const PRODUCTION = '10000000-0000-4000-8000-000000000001';
const STAGING = '10000000-0000-4000-8000-000000000002';

const secretOf = (key: keyof typeof ID) => keyLike(key.slice(0, 1).toUpperCase());

/** The value a key's grant is stored with: what must come out of the migration byte for byte. */
const grantRow = (
  environmentId: string,
  key: keyof typeof ID,
  canWrite: 0 | 1,
  reads: boolean,
) => ({
  environment_id: environmentId,
  credential_id: ID[key],
  can_write: canWrite,
  read_wrap: reads ? sealedLike(`wrap-${key}-${environmentId.slice(-1)}`, 120) : null,
  key_proof: sealedLike(`proof-${key}-${environmentId.slice(-1)}`, 100),
  key_version: 1,
  created_at: NOW - 5 * HOUR,
});

const GRANTS = [
  grantRow(PRODUCTION, 'reader', 0, true),
  grantRow(PRODUCTION, 'both', 1, true),
  grantRow(STAGING, 'both', 1, false),
  grantRow(PRODUCTION, 'writer', 1, false),
  grantRow(STAGING, 'old', 0, true),
];

const insert = (db: DatabaseSync, table: string, rows: ReadonlyArray<Record<string, unknown>>) => {
  for (const row of rows) {
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO "${table}" (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    ).run(...(Object.values(row) as (string | number | null)[]));
  }
};

const all = (db: DatabaseSync, sql: string) => db.prepare(sql).all();

/** What the store held at 0006, with a snapshot of what must come through unchanged. */
const seed = async () => {
  const hashes = Object.fromEntries(
    await Promise.all(
      (Object.keys(ID) as (keyof typeof ID)[]).map(
        async key => [key, await tokenHash(secretOf(key))] as const,
      ),
    ),
  ) as Record<keyof typeof ID, string>;
  const kept: Record<string, unknown> = {};

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
        public_key: keyLike('a'),
        encrypted_private_key: sealedLike('sk'),
        recovery_wrapped_dek: sealedLike('dek'),
        vault_proof_hash: keyLike('v'),
        created_at: NOW - 30 * 24 * HOUR,
      },
    ]);
    insert(
      db,
      'environment',
      [PRODUCTION, STAGING].map((id, at) => ({
        id,
        org_id: ORG,
        name: indexOf(ORG, at === 0 ? 'app/production' : 'app/staging'),
        sealed_name: sealedOf(at === 0 ? 'app/production' : 'app/staging'),
        public_key: keyLike('p'),
        key_version: 1,
        created_by: JSON.stringify({ kind: 'owner', id: 'a', name: 'u' }),
        created_at: NOW - 20 * 24 * HOUR,
      })),
    );
    insert(
      db,
      'member_wrap',
      [PRODUCTION, STAGING].map(environment_id => ({
        environment_id,
        account_id: 'a',
        wrap: sealedLike(`member-${environment_id}`, 120),
        proof: sealedLike(`member-proof-${environment_id}`, 100),
        key_version: 1,
        created_at: NOW - 20 * 24 * HOUR,
      })),
    );
    insert(
      db,
      'credential',
      (Object.keys(ID) as (keyof typeof ID)[]).map(key => ({
        id: ID[key],
        account_id: 'a',
        name: key,
        description: key === 'login' ? null : `why ${key}`,
        public_key: keyLike(key.slice(0, 1)),
        bearer_hash: key === 'closed' ? '' : hashes[key],
        parent_id: key === 'login' ? null : ID.login,
        key_voucher_owner: key === 'login' ? null : sealedLike('to-owner', 100),
        key_voucher_maker: key === 'login' ? null : sealedLike('to-maker', 100),
        account_voucher: key === 'login' ? null : sealedLike('account', 100),
        created_at: NOW - 6 * HOUR,
        expires_at: null,
        revoked_at: key === 'closed' ? NOW - 5 * HOUR : null,
        intent: key === 'login' ? null : 'agent',
        org_id: key === 'login' ? null : ORG,
      })),
    );
    insert(db, 'environment_grant', GRANTS);
    insert(
      db,
      'names_key_wrap',
      ['a', ...Object.values(ID)].map(reader_id => ({
        org_id: ORG,
        reader_id,
        wrap: sealedLike(`names-${reader_id}`, 80),
        created_at: NOW - 6 * HOUR,
      })),
    );
    insert(db, 'access_request', [
      ...(['reader', 'both', 'writer', 'empty'] as const).map(key => ({
        credential_id: ID[key],
        status: 'approved',
        command: null,
        lifetime: null,
        created_at: NOW - 6 * HOUR,
        resolved_at: NOW - 5 * HOUR,
      })),
      { credential_id: ID.pending, status: 'pending', created_at: NOW - 10 * 60 * 1000 },
      { credential_id: ID.rejected, status: 'rejected', created_at: NOW - 6 * HOUR },
      { credential_id: ID.expired, status: 'expired', created_at: NOW - 6 * HOUR },
      { credential_id: ID.closed, status: 'rejected', created_at: NOW - 6 * HOUR },
    ]);
    insert(db, 'access_request_item', [
      { credential_id: ID.reader, environment_id: PRODUCTION, can_read: 1, can_write: 0 },
      { credential_id: ID.both, environment_id: PRODUCTION, can_read: 1, can_write: 1 },
      { credential_id: ID.both, environment_id: STAGING, can_read: 0, can_write: 1 },
      { credential_id: ID.writer, environment_id: PRODUCTION, can_read: 0, can_write: 1 },
      { credential_id: ID.pending, environment_id: PRODUCTION, can_read: 1, can_write: 0 },
    ]);
    insert(db, 'key_change', [
      {
        id: 'change',
        credential_id: ID.both,
        status: 'pending',
        reason: 'more',
        lifetime: null,
        created_at: NOW - 10 * 60 * 1000,
      },
    ]);
    insert(db, 'key_change_item', [
      {
        change_id: 'change',
        environment_id: STAGING,
        can_read: 1,
        can_write: 0,
        gives_back: 0,
      },
    ]);
    insert(db, 'environment_request', [
      {
        id: 'new-env',
        org_id: ORG,
        name: indexOf(ORG, 'app/preview'),
        sealed_name: sealedOf('app/preview'),
        reason: 'a preview',
        status: 'pending',
        created_by: JSON.stringify({ kind: 'credential', id: ID.login, name: 'login' }),
        created_at: NOW - 10 * 60 * 1000,
      },
    ]);
    insert(
      db,
      'paste_link',
      (['pending', 'fulfilled'] as const).map(status => ({
        id: `paste-${status}`,
        environment_id: PRODUCTION,
        name: indexOf(PRODUCTION, 'STRIPE_KEY'),
        sealed_name: sealedOf('STRIPE_KEY'),
        reason: 'the vendor key',
        hint: 'the dashboard',
        status,
        created_by: JSON.stringify({ kind: 'credential', id: ID.login, name: 'login' }),
        created_at: NOW - 10 * 60 * 1000,
        resolved_at: status === 'fulfilled' ? NOW - 5 * 60 * 1000 : null,
      })),
    );
    // Three versions of a live secret, and one in the bin.
    const by = JSON.stringify({ kind: 'owner', id: 'a', name: 'u' });
    insert(db, 'secret', [
      {
        environment_id: PRODUCTION,
        name: indexOf(PRODUCTION, 'API_KEY'),
        sealed_name: sealedOf('API_KEY'),
        current_version: 3,
        latest_version: 3,
        updated_at: NOW - HOUR,
        updated_by: by,
        write_id: 'w1',
      },
      {
        environment_id: PRODUCTION,
        name: indexOf(PRODUCTION, 'OLD'),
        sealed_name: sealedOf('OLD'),
        current_version: null,
        latest_version: 1,
        updated_at: NOW - HOUR,
        updated_by: by,
        write_id: 'w2',
        purge_at: NOW + 29 * 24 * HOUR,
      },
    ]);
    insert(db, 'secret_version', [
      ...[1, 2, 3].map(version => ({
        environment_id: PRODUCTION,
        name: indexOf(PRODUCTION, 'API_KEY'),
        version,
        key_version: 1,
        ciphertext: sealedLike(`api-key-v${version}`, 96),
        created_by: by,
        created_at: NOW - (4 - version) * HOUR,
      })),
      {
        environment_id: PRODUCTION,
        name: indexOf(PRODUCTION, 'OLD'),
        version: 1,
        key_version: 1,
        ciphertext: sealedLike('old-v1', 96),
        created_by: by,
        created_at: NOW - 2 * HOUR,
      },
    ]);
    // A plan mid-way: its environments step approved; a new key, a change to the key that only
    // wrote, a change to the key that reads and writes, and a proposed value, all waiting.
    insert(db, 'plan', [
      {
        id: 'plan',
        org_id: ORG,
        credential_id: ID.login,
        reason: 'set up',
        created_at: NOW - 10 * 60 * 1000,
      },
    ]);
    insert(db, 'plan_step', [
      { plan_id: 'plan', position: 0, type: 'environments', status: 'approved', resolved_at: NOW },
      {
        plan_id: 'plan',
        position: 1,
        type: 'access',
        status: 'pending',
        key_id: ID.planned,
        key_end: 'never',
      },
      {
        plan_id: 'plan',
        position: 2,
        type: 'change',
        status: 'pending',
        key_id: ID.writer,
        key_end: 'keep',
      },
      {
        plan_id: 'plan',
        position: 3,
        type: 'change',
        status: 'pending',
        key_id: ID.both,
        key_end: 'keep',
      },
      { plan_id: 'plan', position: 4, type: 'secrets', status: 'pending' },
    ]);
    insert(db, 'plan_item', [
      {
        plan_id: 'plan',
        step_position: 0,
        position: 0,
        op: 'create',
        environment_id: '10000000-0000-4000-8000-000000000003',
        environment_name: indexOf(ORG, 'app/preview'),
        environment_sealed_name: sealedOf('app/preview'),
      },
      { plan_id: 'plan', step_position: 1, position: 0, op: 'read', environment_id: PRODUCTION },
      { plan_id: 'plan', step_position: 2, position: 0, op: 'read', environment_id: STAGING },
      { plan_id: 'plan', step_position: 3, position: 0, op: 'read', environment_id: STAGING },
      {
        plan_id: 'plan',
        step_position: 4,
        position: 0,
        op: 'set',
        environment_id: PRODUCTION,
        secret_name: indexOf(PRODUCTION, 'API_KEY'),
        secret_sealed_name: sealedOf('API_KEY'),
        proposed_value: sealedLike('proposed', 120),
      },
    ]);
    insert(
      db,
      'activity_event',
      (
        ['request.create', 'request.approve', 'key-change.create', 'paste-link.fulfil'] as const
      ).map((action, at) => ({
        id: `01J00000000000000000000${at}`,
        org_id: ORG,
        at: NOW - HOUR + at,
        actor: JSON.stringify({ kind: 'credential', id: ID.login, name: 'login' }),
        action,
        environment_id: PRODUCTION,
        environment_name: indexOf(ORG, 'app/production'),
        environment_sealed_name: sealedOf('app/production'),
        detail: 'writer',
      })),
    );

    for (const table of ['member_wrap', 'secret', 'secret_version', 'activity_event', 'plan']) {
      kept[table] = all(db, `SELECT * FROM ${table} ORDER BY 1, 2, 3`);
    }
    kept.planItems = all(db, 'SELECT * FROM plan_item ORDER BY step_position, position');
    kept.credentials = all(db, 'SELECT * FROM credential ORDER BY id');
  };

  return { legacy: { before: '0007', seed: run }, kept, hashes };
};

/** A store seeded at 0006, migrated to now, and the Worker over it. */
const migrated = async () => {
  const { legacy, kept, hashes } = await seed();
  const world = testWorld({ legacy });
  return { world, sqlite: world.sqlite, kept, hashes };
};

describe('migration 0007', () => {
  it('drops the tables of the asks a plan replaced, and `can_write`', async () => {
    const { sqlite } = await migrated();
    const tables = all(sqlite, "SELECT name FROM sqlite_master WHERE type = 'table'").map(
      row => row.name,
    );
    for (const gone of [
      'access_request',
      'access_request_item',
      'key_change',
      'key_change_item',
      'environment_request',
      'paste_link',
      'key_revoke_0007',
      'environment_grant_0007',
    ]) {
      expect(tables).not.toContain(gone);
    }
    expect(all(sqlite, 'PRAGMA table_info(environment_grant)')).toEqual([
      expect.objectContaining({ name: 'environment_id', notnull: 1 }),
      expect.objectContaining({ name: 'credential_id', notnull: 1 }),
      expect.objectContaining({ name: 'read_wrap', notnull: 1 }),
      expect.objectContaining({ name: 'key_proof', notnull: 1 }),
      expect.objectContaining({ name: 'key_version', notnull: 1 }),
      expect.objectContaining({ name: 'created_at', notnull: 1 }),
    ]);
    expect(all(sqlite, 'PRAGMA index_list(environment_grant)')).toContainEqual(
      expect.objectContaining({ name: 'environment_grant_credential_idx' }),
    );
    expect(all(sqlite, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('keeps every read grant byte for byte, and removes every grant that only wrote', async () => {
    const { sqlite } = await migrated();
    const reads = GRANTS.filter(grant => grant.read_wrap !== null).map(
      ({ can_write: _, ...grant }) => grant,
    );
    expect(
      all(sqlite, 'SELECT * FROM environment_grant ORDER BY credential_id, environment_id'),
    ).toEqual(
      reads.sort((one, other) =>
        `${one.credential_id}${one.environment_id}`.localeCompare(
          `${other.credential_id}${other.environment_id}`,
        ),
      ),
    );
  });

  it('revokes a key left with nothing, and a key whose request never became one; leaves the rest', async () => {
    const { sqlite, kept, hashes } = await migrated();
    const before = new Map(
      (kept.credentials as Array<Record<string, unknown>>).map(row => [row.id, row]),
    );
    const after = all(sqlite, 'SELECT * FROM credential ORDER BY id') as Array<
      Record<string, unknown>
    >;
    const revoked = ['writer', 'pending', 'rejected', 'expired'].map(
      key => ID[key as keyof typeof ID],
    );
    for (const row of after) {
      if (revoked.includes(row.id as (typeof revoked)[number])) {
        expect(row).toEqual({
          ...before.get(row.id),
          revoked_at: expect.any(Number),
          bearer_hash: '',
        });
      } else {
        // The login, the keys that read, the key that already held nothing, the one revoked
        // before, and the plan's waiting key: exactly as they were.
        expect(row).toEqual(before.get(row.id));
      }
    }
    expect(after.find(row => row.id === ID.closed)).toMatchObject({ revoked_at: NOW - 5 * HOUR });
    expect(after.find(row => row.id === ID.reader)).toMatchObject({
      revoked_at: null,
      bearer_hash: hashes.reader,
    });
  });

  it('takes the names key copies of the keys it revokes, and only theirs', async () => {
    const { sqlite } = await migrated();
    expect(
      all(sqlite, 'SELECT reader_id FROM names_key_wrap ORDER BY reader_id').map(
        row => row.reader_id,
      ),
    ).toEqual(['a', ID.login, ID.reader, ID.both, ID.closed, ID.empty, ID.old, ID.planned].sort());
  });

  it('rejects a plan step waiting to change a key it revokes, and leaves the rest of the plan', async () => {
    const { sqlite, kept } = await migrated();
    expect(
      all(sqlite, 'SELECT position, status, resolved_at FROM plan_step ORDER BY position'),
    ).toEqual([
      { position: 0, status: 'approved', resolved_at: NOW },
      { position: 1, status: 'pending', resolved_at: null },
      { position: 2, status: 'rejected', resolved_at: expect.any(Number) },
      { position: 3, status: 'pending', resolved_at: null },
      { position: 4, status: 'pending', resolved_at: null },
    ]);
    expect(all(sqlite, 'SELECT * FROM plan_item ORDER BY step_position, position')).toEqual(
      kept.planItems,
    );
    expect(all(sqlite, 'SELECT * FROM plan ORDER BY 1, 2, 3')).toEqual(kept.plan);
  });

  it('leaves member copies, secrets, every version, the bin and the activity log as they were', async () => {
    const { sqlite, kept } = await migrated();
    for (const table of ['member_wrap', 'secret', 'secret_version', 'activity_event']) {
      expect(all(sqlite, `SELECT * FROM ${table} ORDER BY 1, 2, 3`)).toEqual(kept[table]);
    }
  });

  it('serves a surviving key through the read path, and refuses a revoked one', async () => {
    const { world } = await migrated();
    const load = async (key: keyof typeof ID) =>
      json(
        await world.api(`/api/v1/environments/${PRODUCTION}/bundle`, {
          headers: { authorization: `Bearer baymutt_${ID[key]}_${secretOf(key)}` },
        }),
      );
    for (const key of ['reader', 'both'] as const) {
      expect(await load(key)).toEqual({
        status: 200,
        body: {
          environment: {
            id: PRODUCTION,
            name: indexOf(ORG, 'app/production'),
            sealedName: sealedOf('app/production'),
            publicKey: keyLike('p'),
            keyVersion: 1,
          },
          wrap: GRANTS.find(
            grant => grant.credential_id === ID[key] && grant.environment_id === PRODUCTION,
          )?.read_wrap,
          readerId: ID[key],
          secrets: [
            {
              name: indexOf(PRODUCTION, 'API_KEY'),
              sealedName: sealedOf('API_KEY'),
              version: 3,
              keyVersion: 1,
              ciphertext: sealedLike('api-key-v3', 96),
            },
          ],
        },
      });
    }
    // Lists what it reads, and no write: a key only reads.
    expect(
      await json(
        await world.api('/api/v1/environments', {
          headers: { authorization: `Bearer baymutt_${ID.both}_${secretOf('both')}` },
        }),
      ),
    ).toMatchObject({
      status: 200,
      body: { environments: [{ id: PRODUCTION, canRead: true, canWrite: false }] },
    });
    expect(await load('writer')).toMatchObject({ status: 401 });
    expect(await load('pending')).toMatchObject({ status: 401 });
  });
});
