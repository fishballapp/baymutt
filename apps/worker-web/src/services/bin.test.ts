/** The bin: deleting, restoring, the owner removing for good, and the 30-day sweep. */
import { SecretSchema } from '@baymutt/api';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as Struct from 'effect/Struct';
import { describe, expect, it } from 'vitest';
import { call, ok, type StoreWorld, storeWorld } from '../test-store.ts';
import { sealedLike, send } from '../test-support.ts';
import { BIN_MS, Bin } from './bin.ts';

const DAY_MS = 24 * 3600 * 1000;

/** A purge answers 204, with no body. */
const purge = async (w: StoreWorld['w'], path: string, headers: Record<string, string>) => {
  const response = await w.api(`/api/v1${path}`, send('POST', undefined, headers));
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

const setup = async () => {
  const world = await storeWorld();
  const login = await world.pair('laptop');
  const environmentId = await world.environment('app/production', world.owner, [login.id]);
  const scoped = await world.pair('ci');
  // A scoped service account: one the login made, which holds only what it was handed.
  world.w.sqlite
    .prepare('UPDATE credential SET parent_id = ? WHERE id = ?')
    .run(login.id, scoped.id);
  await world.grant(environmentId, scoped.id, { read: true, write: true });
  await world.write(environmentId, 'API_KEY', 1);
  await world.write(environmentId, 'API_KEY', 2);
  return { ...world, login, scoped, environmentId };
};

const sweep = (w: StoreWorld['w']) =>
  Effect.runPromise(Effect.flatMap(Bin, bin => bin.sweep).pipe(Effect.provide(w.services)));

/** Moves everything in the bin `days` closer to being removed, as that many days passing would. */
const age = (w: StoreWorld['w'], days: number) => {
  w.sqlite.exec(`UPDATE secret SET purge_at = purge_at - ${days * DAY_MS},
    updated_at = updated_at - ${days * DAY_MS} WHERE current_version IS NULL`);
  w.sqlite.exec(`UPDATE environment SET purge_at = purge_at - ${days * DAY_MS},
    deleted_at = deleted_at - ${days * DAY_MS} WHERE deleted_at IS NOT NULL`);
};

const count = (w: StoreWorld['w'], table: string) =>
  (w.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const actions = (w: StoreWorld['w']) =>
  w.sqlite.prepare('SELECT action, actor, detail FROM audit_event ORDER BY id').all() as Array<{
    action: string;
    actor: string;
    detail: string | null;
  }>;

describe('a deleted secret', () => {
  it('goes to the bin for 30 days, and a rollback by whoever could delete it brings it back', async () => {
    const { w, owner, scoped, environmentId } = await setup();

    const deleted = await ok<{ updatedAt: number; purgeAt: number }>(
      w,
      'DELETE',
      `/environments/${environmentId}/secrets/API_KEY`,
      scoped.headers,
    );
    expect(deleted).toMatchObject({ currentVersion: null, latestVersion: 2 });
    expect(deleted.purgeAt - deleted.updatedAt).toBe(BIN_MS);
    // Deleting it again does not restart its 30 days.
    expect(
      await call(w, 'DELETE', `/environments/${environmentId}/secrets/API_KEY`, owner),
    ).toMatchObject({
      status: 404,
    });

    expect(await ok(w, 'GET', '/bin', owner)).toEqual({
      environments: [],
      secrets: [
        {
          environmentId,
          environmentName: 'app/production',
          name: 'API_KEY',
          latestVersion: 2,
          deletedAt: deleted.updatedAt,
          deletedBy: { kind: 'machine', id: scoped.id, name: 'ci' },
          purgeAt: deleted.purgeAt,
        },
      ],
    });

    expect(
      await call(
        w,
        'POST',
        `/environments/${environmentId}/secrets/API_KEY/rollback`,
        scoped.headers,
        {
          version: 2,
        },
      ),
    ).toMatchObject({ status: 200, body: { currentVersion: 2, purgeAt: null } });
    expect(await ok(w, 'GET', '/bin', owner)).toEqual({ environments: [], secrets: [] });
    expect(actions(w).at(-1)).toMatchObject({ action: 'secret.rollback', detail: 'from the bin' });
  });

  it('is not restored from the bin once it has left it: a value set since stays current', async () => {
    const { w, owner, environmentId, write } = await setup();
    await ok(w, 'DELETE', `/environments/${environmentId}/secrets/API_KEY`, owner);
    await write(environmentId, 'API_KEY', 3);

    // A Bin page loaded before that write still offers version 2.
    expect(
      await call(w, 'POST', `/environments/${environmentId}/secrets/API_KEY/rollback`, owner, {
        version: 2,
        fromBin: true,
      }),
    ).toMatchObject({ status: 404 });
    expect(await ok(w, 'GET', `/environments/${environmentId}/secrets`, owner)).toMatchObject({
      secrets: [{ name: 'API_KEY', currentVersion: 3 }],
    });
  });

  it('leaves the bin when its name is set again, with its versions kept as history', async () => {
    const { w, owner, environmentId, write } = await setup();
    await ok(w, 'DELETE', `/environments/${environmentId}/secrets/API_KEY`, owner);

    expect(await write(environmentId, 'API_KEY', 3)).toMatchObject({
      status: 200,
      body: { currentVersion: 3, purgeAt: null },
    });
    expect(count(w, 'secret_version')).toBe(3);
    expect(await ok(w, 'GET', '/bin', owner)).toEqual({ environments: [], secrets: [] });
  });

  it('is removed for good, every version, 30 days after it was deleted and not before', async () => {
    const { w, owner, environmentId, write } = await setup();
    await write(environmentId, 'OTHER', 1);
    await ok(w, 'DELETE', `/environments/${environmentId}/secrets/API_KEY`, owner);

    age(w, 29);
    expect(await sweep(w)).toEqual({ environments: 0, secrets: 0 });
    expect(count(w, 'secret_version')).toBe(3);

    age(w, 1);
    expect(await sweep(w)).toEqual({ environments: 0, secrets: 1 });
    expect(w.sqlite.prepare('SELECT name, version FROM secret_version').all()).toEqual([
      { name: 'OTHER', version: 1 },
    ]);
    expect(await ok(w, 'GET', '/bin', owner)).toEqual({ environments: [], secrets: [] });
    // The log still says what happened to it, and who removed it.
    const log = actions(w);
    expect(log.filter(({ action }) => action === 'secret.write')).toHaveLength(3);
    expect(log.at(-1)).toEqual({
      action: 'secret.purge',
      actor: JSON.stringify({ kind: 'system', id: 'bin', name: 'baymutt' }),
      detail: 'after 30 days in the bin',
    });
    // The name is free: a new secret starts at version 1.
    expect(await write(environmentId, 'API_KEY', 1)).toMatchObject({ status: 200 });
  });
});

describe('a deleted environment', () => {
  it('goes to the bin, keeps its name, and the owner restores it whole', async () => {
    const { w, owner, login, scoped, environmentId } = await setup();
    expect(await call(w, 'DELETE', `/environments/${environmentId}`, login.headers)).toMatchObject({
      status: 403,
      body: { code: 'OwnerRequiredError' },
    });
    const { deletedAt, purgeAt } = await ok<{ deletedAt: number; purgeAt: number }>(
      w,
      'DELETE',
      `/environments/${environmentId}`,
      owner,
    );
    expect(purgeAt - deletedAt).toBe(BIN_MS);
    expect(await ok(w, 'GET', '/bin', login.headers)).toEqual({
      environments: [{ id: environmentId, name: 'app/production', deletedAt, purgeAt }],
      secrets: [],
    });
    expect(
      await call(w, 'GET', `/environments/${environmentId}/bundle`, scoped.headers),
    ).toMatchObject({
      status: 404,
    });

    // Its name stays taken while it is in the bin, and the refusal says where it is.
    const taken = await call(w, 'POST', '/environments', owner, {
      id: crypto.randomUUID(),
      name: 'app/production',
      publicKey: 'p'.repeat(42) + 'A',
      ownerWrap: sealedLike('owner-wrap'),
      ownerProof: sealedLike('owner-proof'),
      creatorWrap: null,
      creatorProof: null,
    });
    expect(taken).toMatchObject({ status: 409, body: { code: 'AlreadyExistsError' } });
    expect(JSON.stringify(taken.body)).toContain('in the bin');

    for (const headers of [login.headers, scoped.headers]) {
      expect(
        await call(w, 'POST', `/environments/${environmentId}/restore`, headers),
      ).toMatchObject({
        status: 403,
        body: { code: 'OwnerRequiredError' },
      });
    }
    expect(await call(w, 'POST', `/environments/${environmentId}/restore`, owner)).toMatchObject({
      status: 200,
      body: { id: environmentId, name: 'app/production', secretCount: 1 },
    });
    expect(
      await call(w, 'GET', `/environments/${environmentId}/bundle`, scoped.headers),
    ).toMatchObject({
      status: 200,
      body: { secrets: [{ name: 'API_KEY', version: 2 }] },
    });
    expect(await ok(w, 'GET', '/bin', owner)).toEqual({ environments: [], secrets: [] });
    expect(actions(w).map(({ action }) => action)).toContain('environment.restore');
  });

  it('is removed for good after 30 days, with its secrets, versions and grants', async () => {
    const { w, owner, environmentId } = await setup();
    await ok(w, 'DELETE', `/environments/${environmentId}`, owner);

    age(w, 29);
    expect(await sweep(w)).toEqual({ environments: 0, secrets: 0 });
    age(w, 1);
    expect(await sweep(w)).toEqual({ environments: 1, secrets: 0 });

    for (const table of ['environment', 'secret', 'secret_version', 'environment_grant']) {
      expect(count(w, table)).toBe(0);
    }
    const log = actions(w);
    expect(log.some(({ action }) => action === 'environment.create')).toBe(true);
    expect(log.at(-1)).toMatchObject({
      action: 'environment.purge',
      detail: 'after 30 days in the bin',
    });
  });
});

describe('removing for good straight away', () => {
  it('is the owner’s alone, with the vault open: never a login, a service account or a locked session', async () => {
    const { w, owner, locked, login, scoped, environmentId } = await setup();
    await ok(w, 'DELETE', `/environments/${environmentId}/secrets/API_KEY`, owner);
    const purgeSecret = (headers: Record<string, string>) =>
      purge(w, `/environments/${environmentId}/secrets/API_KEY/purge`, headers);

    for (const headers of [login.headers, scoped.headers]) {
      expect(await purgeSecret(headers)).toMatchObject({
        status: 403,
        body: { code: 'OwnerRequiredError' },
      });
    }
    expect(await purgeSecret(locked)).toMatchObject({
      status: 403,
      body: { code: 'VaultLockedError' },
    });
    expect(count(w, 'secret_version')).toBe(2);

    expect(await purgeSecret(owner)).toMatchObject({ status: 204 });
    expect(count(w, 'secret_version')).toBe(0);
    expect(await purgeSecret(owner)).toMatchObject({ status: 404 });
    expect(actions(w).at(-1)).toMatchObject({
      action: 'secret.purge',
      actor: expect.stringContaining('"kind":"owner"'),
      detail: null,
    });
  });

  it('takes only what is in the bin, and a whole environment for the owner', async () => {
    const { w, owner, login, environmentId } = await setup();
    // A live environment or secret is deleted first.
    expect(await purge(w, `/environments/${environmentId}/purge`, owner)).toMatchObject({
      status: 404,
    });
    expect(
      await purge(w, `/environments/${environmentId}/secrets/API_KEY/purge`, owner),
    ).toMatchObject({
      status: 404,
    });

    await ok(w, 'DELETE', `/environments/${environmentId}`, owner);
    expect(await purge(w, `/environments/${environmentId}/purge`, login.headers)).toMatchObject({
      status: 403,
      body: { code: 'OwnerRequiredError' },
    });
    expect(await purge(w, `/environments/${environmentId}/purge`, owner)).toMatchObject({
      status: 204,
    });
    for (const table of ['environment', 'secret', 'secret_version', 'environment_grant']) {
      expect(count(w, table)).toBe(0);
    }
    expect(await ok(w, 'GET', '/bin', owner)).toEqual({ environments: [], secrets: [] });
  });
});

describe('what a scoped service account sees in the bin', () => {
  it('is what is in the environments it holds a grant on', async () => {
    const { w, owner, scoped, environment, write } = await setup();
    const other = await environment('app/staging');
    await write(other, 'TOKEN', 1);
    await ok(w, 'DELETE', `/environments/${other}/secrets/TOKEN`, owner);

    expect(await ok(w, 'GET', '/bin', scoped.headers)).toEqual({ environments: [], secrets: [] });
    expect((await ok<{ secrets: Array<unknown> }>(w, 'GET', '/bin', owner)).secrets).toHaveLength(
      1,
    );
  });
});

describe('clients on either side of the bin', () => {
  const v041Secret = SecretSchema.mapFields(Struct.omit(['purgeAt']));

  it('a store from before it still reads to a newer client: purgeAt is null', () => {
    const secret = Schema.decodeUnknownSync(SecretSchema)({
      name: 'API_KEY',
      currentVersion: null,
      latestVersion: 2,
      size: null,
      updatedAt: 1,
      updatedBy: { kind: 'owner', id: 'a', name: 'Owner' },
    });
    expect(secret.purgeAt).toBeNull();
  });

  it('a 0.4.1 client reads this store’s secrets', async () => {
    const { w, owner, environmentId } = await setup();
    await ok(w, 'DELETE', `/environments/${environmentId}/secrets/API_KEY`, owner);
    const { secrets } = await ok<{ secrets: Array<unknown> }>(
      w,
      'GET',
      `/environments/${environmentId}/secrets`,
      owner,
    );
    expect(Schema.decodeUnknownSync(Schema.Array(v041Secret))(secrets)).toEqual([
      expect.objectContaining({ name: 'API_KEY', currentVersion: null, latestVersion: 2 }),
    ]);
  });
});
