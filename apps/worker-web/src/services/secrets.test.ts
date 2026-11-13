/** Values as ciphertext: versioned writes, soft deletes, loads, and the paste link. */
import { tokenHash } from '@baymutt/keys/wire';
import { describe, expect, it } from 'vitest';
import { call, newAccount, ok, type StoreWorld, storeWorld } from '../test-store.ts';
import { keyLike, ORIGIN, sealedLike } from '../test-support.ts';

const setup = async () => {
  const world = await storeWorld();
  const environmentId = await world.environment('app/production');
  const reader = await world.pair('reader');
  const writer = await world.pair('writer');
  await world.grant(environmentId, reader.id, { read: true });
  await world.grant(environmentId, writer.id, { write: true });
  return { ...world, environmentId, reader, writer };
};

describe('writing', () => {
  it('needs a write grant and no key, and a writer can never load', async () => {
    const { w, environmentId, reader, writer, write } = await setup();

    expect(await write(environmentId, 'API_KEY', 1, reader.headers)).toMatchObject({
      status: 403,
      body: { code: 'NoAccessError', need: 'write' },
    });
    expect(await write(environmentId, 'API_KEY', 1, writer.headers)).toMatchObject({
      status: 200,
      body: {
        name: 'API_KEY',
        currentVersion: 1,
        latestVersion: 1,
        size: 72,
        updatedBy: { kind: 'machine', name: 'writer' },
      },
    });
    expect(
      await call(w, 'GET', `/environments/${environmentId}/bundle`, writer.headers),
    ).toMatchObject({
      status: 403,
      body: { code: 'NoAccessError', need: 'read' },
    });
    // Either grant lists names and versions, which carry no value.
    expect(
      await call(w, 'GET', `/environments/${environmentId}/secrets`, writer.headers),
    ).toMatchObject({
      status: 200,
      body: { secrets: [{ name: 'API_KEY', currentVersion: 1 }] },
    });
  });

  it('adds a version each time and keeps every one', async () => {
    const { w, owner, environmentId, writer, write } = await setup();
    await write(environmentId, 'API_KEY', 1, writer.headers);

    expect(await write(environmentId, 'API_KEY', 2)).toMatchObject({
      status: 200,
      body: { currentVersion: 2, latestVersion: 2, updatedBy: { kind: 'owner' } },
    });
    expect(
      await call(w, 'GET', `/environments/${environmentId}/secrets/API_KEY/versions`, owner),
    ).toMatchObject({
      status: 200,
      body: {
        versions: [
          { version: 2, isCurrent: true, createdBy: { kind: 'owner' } },
          { version: 1, isCurrent: false, createdBy: { kind: 'machine', name: 'writer' } },
        ],
      },
    });
    expect(
      w.sqlite.prepare('SELECT version, ciphertext FROM secret_version ORDER BY version').all(),
    ).toEqual([
      { version: 1, ciphertext: sealedLike('API_KEY-v1', 96) },
      { version: 2, ciphertext: sealedLike('API_KEY-v2', 96) },
    ]);
  });

  it('refuses a version that is not one above the latest, saying which slot to seal for', async () => {
    const { w, environmentId, write } = await setup();

    expect(await write(environmentId, 'API_KEY', 2)).toMatchObject({
      status: 409,
      body: { code: 'VersionConflictError', latestVersion: 0, keyVersion: 1 },
    });
    await write(environmentId, 'API_KEY', 1);
    for (const version of [1, 3]) {
      expect(await write(environmentId, 'API_KEY', version)).toMatchObject({
        status: 409,
        body: { code: 'VersionConflictError', latestVersion: 1 },
      });
    }
    expect(w.sqlite.prepare('SELECT COUNT(*) AS versions FROM secret_version').get()).toEqual({
      versions: 1,
    });
  });

  it('refuses a value sealed under a key version the environment no longer has', async () => {
    const { w, owner, environmentId } = await setup();

    expect(
      await call(w, 'PUT', `/environments/${environmentId}/secrets/API_KEY`, owner, {
        version: 1,
        keyVersion: 2,
        ciphertext: sealedLike('x', 96),
      }),
    ).toMatchObject({ status: 409, body: { code: 'VersionConflictError', keyVersion: 1 } });
  });

  it('gives one of two writers of the same version the slot and the other a conflict', async () => {
    const { w, environmentId, writer, write } = await setup();
    await write(environmentId, 'API_KEY', 1);
    // The other writer lands between this request's checks and its batch.
    w.beforeStatement(/INSERT INTO secret\b/, () => {
      w.sqlite.exec(
        `UPDATE secret SET latest_version = 2, current_version = 2, write_id = 'other'`,
      );
      w.sqlite.exec(
        `INSERT INTO secret_version SELECT project_id, name, 2, account_id, key_version, 'b3RoZXI=', created_by, created_at FROM secret_version`,
      );
    });

    expect(await write(environmentId, 'API_KEY', 2, writer.headers)).toMatchObject({
      status: 409,
      body: { code: 'VersionConflictError', latestVersion: 2 },
    });
    expect(
      w.sqlite.prepare('SELECT ciphertext FROM secret_version WHERE version = 2').all(),
    ).toEqual([{ ciphertext: 'b3RoZXI=' }]);
    expect(
      w.sqlite
        .prepare("SELECT COUNT(*) AS logged FROM audit_event WHERE action = 'secret.write'")
        .get(),
    ).toEqual({ logged: 1 });
  });

  it('refuses a name of the wrong shape, and a value over the limit', async () => {
    const { w, owner, environmentId } = await setup();

    expect(
      await call(w, 'PUT', `/environments/${environmentId}/secrets/not-a-name`, owner, {
        version: 1,
        keyVersion: 1,
        ciphertext: sealedLike('x'),
      }),
    ).toMatchObject({ status: 400, body: { code: 'InvalidRequestError' } });
    expect(
      await call(w, 'PUT', `/environments/${environmentId}/secrets/API_KEY`, owner, {
        version: 1,
        keyVersion: 1,
        ciphertext: 'A'.repeat(87_468),
      }),
    ).toMatchObject({ status: 400, body: { code: 'InvalidRequestError' } });
  });
});

describe('loading', () => {
  it('answers every current value as ciphertext with the caller’s own wrap', async () => {
    const { w, owner, accountId, environmentId, reader, write } = await setup();
    await write(environmentId, 'B_KEY', 1);
    await write(environmentId, 'A_KEY', 1);
    await write(environmentId, 'A_KEY', 2);
    const environment = {
      id: environmentId,
      accountId,
      name: 'app/production',
      publicKey: keyLike('p'),
      keyVersion: 1,
    };
    const secrets = [
      { name: 'A_KEY', version: 2, keyVersion: 1, ciphertext: sealedLike('A_KEY-v2', 96) },
      { name: 'B_KEY', version: 1, keyVersion: 1, ciphertext: sealedLike('B_KEY-v1', 96) },
    ];

    expect(await call(w, 'GET', `/environments/${environmentId}/bundle`, reader.headers)).toEqual({
      status: 200,
      body: { environment, wrap: sealedLike('read-wrap'), readerId: reader.id, secrets },
    });
    // Values load through a paired service account: the dashboard reveals one at a time instead.
    expect(await call(w, 'GET', `/environments/${environmentId}/bundle`, owner)).toMatchObject({
      status: 403,
      body: { code: 'NoAccessError' },
    });
  });

  it('stops for an environment in the bin, which only the owner deletes', async () => {
    const { w, owner, environmentId, reader, writer, write } = await setup();

    expect(await call(w, 'DELETE', `/environments/${environmentId}`, reader.headers)).toMatchObject(
      {
        status: 403,
        body: { code: 'OwnerRequiredError' },
      },
    );
    await ok(w, 'DELETE', `/environments/${environmentId}`, owner);

    expect(
      await call(w, 'GET', `/environments/${environmentId}/bundle`, reader.headers),
    ).toMatchObject({
      status: 404,
    });
    expect(await write(environmentId, 'API_KEY', 1, writer.headers)).toMatchObject({ status: 404 });
    expect(await call(w, 'GET', '/environments', owner)).toEqual({
      status: 200,
      body: { environments: [] },
    });
  });
});

describe('revealing in the dashboard', () => {
  it('answers the owner one version’s ciphertext with the vault open, and logs it', async () => {
    const { w, owner, locked, environmentId, reader, write } = await setup();
    await write(environmentId, 'API_KEY', 1);
    await write(environmentId, 'API_KEY', 2);
    const reveal = (version: number, headers = owner) =>
      call(w, 'POST', `/environments/${environmentId}/secrets/API_KEY/reveal`, headers, {
        version,
      });

    expect(await reveal(1)).toEqual({
      status: 200,
      body: { version: 1, keyVersion: 1, ciphertext: sealedLike('API_KEY-v1', 96) },
    });
    expect(await reveal(3)).toMatchObject({ status: 404, body: { code: 'NotFoundError' } });
    // A session the vault did not open, and a service account even with a read grant, get nothing.
    expect(await reveal(2, locked)).toMatchObject({
      status: 403,
      body: { code: 'VaultLockedError' },
    });
    expect(await reveal(2, reader.headers)).toMatchObject({
      status: 403,
      body: { code: 'OwnerRequiredError' },
    });
    expect(
      w.sqlite
        .prepare(
          "SELECT secret_name, version FROM audit_event WHERE action = 'secret.reveal' ORDER BY id",
        )
        .all(),
    ).toEqual([{ secret_name: 'API_KEY', version: 1 }]);
  });
});

describe('deleting and rolling back', () => {
  it('a delete hides the value from a load and keeps its versions; a rollback brings one back', async () => {
    const { w, owner, environmentId, reader, writer, write } = await setup();
    await write(environmentId, 'API_KEY', 1);
    await write(environmentId, 'API_KEY', 2);
    const loaded = async () =>
      (
        await ok<{ secrets: { version: number }[] }>(
          w,
          'GET',
          `/environments/${environmentId}/bundle`,
          reader.headers,
        )
      ).secrets.map(({ version }) => version);

    expect(
      await call(w, 'DELETE', `/environments/${environmentId}/secrets/API_KEY`, reader.headers),
    ).toMatchObject({ status: 403, body: { code: 'NoAccessError' } });
    expect(
      await call(w, 'DELETE', `/environments/${environmentId}/secrets/API_KEY`, writer.headers),
    ).toMatchObject({ status: 200, body: { currentVersion: null, latestVersion: 2, size: null } });
    expect(await loaded()).toEqual([]);
    expect(w.sqlite.prepare('SELECT COUNT(*) AS versions FROM secret_version').get()).toEqual({
      versions: 2,
    });

    expect(
      await call(
        w,
        'POST',
        `/environments/${environmentId}/secrets/API_KEY/rollback`,
        writer.headers,
        {
          version: 1,
        },
      ),
    ).toMatchObject({ status: 200, body: { currentVersion: 1, latestVersion: 2 } });
    expect(await loaded()).toEqual([1]);
    // The next write is still one above the highest ever written, never over a kept version.
    expect(await write(environmentId, 'API_KEY', 3)).toMatchObject({
      status: 200,
      body: { currentVersion: 3, latestVersion: 3 },
    });
    expect(
      await call(w, 'POST', `/environments/${environmentId}/secrets/API_KEY/rollback`, owner, {
        version: 9,
      }),
    ).toMatchObject({ status: 404 });
    expect(
      await call(w, 'DELETE', `/environments/${environmentId}/secrets/MISSING`, owner),
    ).toMatchObject({
      status: 404,
    });
  });
});

describe('a paste request', () => {
  const request = async (
    { w }: StoreWorld,
    environmentId: string,
    headers: Record<string, string>,
  ) => {
    const id = crypto.randomUUID();
    const token = keyLike('t');
    const answer = await call(w, 'POST', '/paste-requests', headers, {
      id,
      environmentId,
      name: 'STRIPE_SECRET_KEY',
      reason: 'to take payments',
      hint: 'Stripe dashboard, Developers, API keys',
      tokenHash: await tokenHash(token),
    });
    return { id, answer, link: { 'x-baymutt-paste-token': token, origin: ORIGIN } };
  };
  const pasted = (version: number) => ({
    version,
    keyVersion: 1,
    ciphertext: sealedLike('pasted', 96),
  });

  it('lets whoever holds the link seal one value into its one slot, once', async () => {
    const world = await setup();
    const { w, owner, accountId, environmentId, reader, writer } = world;

    expect((await request(world, environmentId, reader.headers)).answer).toMatchObject({
      status: 403,
      body: { code: 'NoAccessError', need: 'write' },
    });
    const { id, answer, link } = await request(world, environmentId, writer.headers);

    expect(answer).toMatchObject({ status: 201, body: { status: 'pending' } });
    expect(await call(w, 'GET', '/paste-requests', owner)).toMatchObject({
      body: { requests: [{ id, name: 'STRIPE_SECRET_KEY', createdBy: { name: 'writer' } }] },
    });
    expect(await call(w, 'GET', `/paste/${id}`, link)).toMatchObject({
      status: 200,
      body: {
        accountId,
        environmentPublicKey: keyLike('p'),
        keyVersion: 1,
        nextVersion: 1,
        request: { environmentName: 'app/production', name: 'STRIPE_SECRET_KEY' },
      },
    });

    // The holder may be signed in to an account of their own: the link still works for them.
    const stranger = w.user('user-2');
    const strangerSession = w.signIn(stranger.id);
    await ok(
      w,
      'POST',
      '/account',
      strangerSession,
      await newAccount(crypto.randomUUID(), stranger.first.credentialId),
      201,
    );
    expect(await call(w, 'GET', `/paste/${id}`, { ...strangerSession, ...link })).toMatchObject({
      status: 200,
    });
    expect(await call(w, 'GET', `/paste/${id}`, strangerSession)).toMatchObject({ status: 401 });

    expect(await call(w, 'POST', `/paste/${id}`, link, pasted(1))).toMatchObject({
      status: 200,
      body: {
        name: 'STRIPE_SECRET_KEY',
        currentVersion: 1,
        updatedBy: { kind: 'link', name: 'Paste link' },
      },
    });
    for (const [method, body] of [
      ['GET', undefined],
      ['POST', pasted(2)],
    ] as const) {
      expect(await call(w, method, `/paste/${id}`, link, body)).toMatchObject({
        status: 410,
        body: { code: 'LinkSpentError' },
      });
    }
    expect(await call(w, 'GET', '/paste-requests', owner)).toEqual({
      status: 200,
      body: { requests: [] },
    });
  });

  it('answers to no other token, and to nobody once the link has expired, except the owner', async () => {
    const world = await setup();
    const { w, owner, environmentId, reader, writer } = world;
    const { id, link } = await request(world, environmentId, writer.headers);

    for (const headers of [
      { ...link, 'x-baymutt-paste-token': keyLike('x') },
      { origin: ORIGIN },
      // A service account's bearer is no substitute: only the link or the owner answers.
      reader.headers,
    ]) {
      expect(await call(w, 'GET', `/paste/${id}`, headers)).toMatchObject({
        status: 401,
        body: { code: 'UnauthorizedError' },
      });
    }

    w.sqlite.exec('UPDATE paste_request SET link_expires_at = 1');

    expect(await call(w, 'POST', `/paste/${id}`, link, pasted(1))).toMatchObject({
      status: 410,
      body: { code: 'LinkSpentError' },
    });
    expect(await call(w, 'POST', `/paste/${id}`, owner, pasted(1))).toMatchObject({
      status: 200,
      body: { currentVersion: 1, updatedBy: { kind: 'owner' } },
    });
  });

  it('stays unspent when the pasted value loses its slot to another write', async () => {
    const world = await setup();
    const { w, environmentId, writer, write } = world;
    const { id, link } = await request(world, environmentId, writer.headers);
    await write(environmentId, 'STRIPE_SECRET_KEY', 1);

    expect(await call(w, 'POST', `/paste/${id}`, link, pasted(1))).toMatchObject({
      status: 409,
      body: { code: 'VersionConflictError', latestVersion: 1 },
    });
    expect(await call(w, 'GET', `/paste/${id}`, link)).toMatchObject({
      status: 200,
      body: { nextVersion: 2 },
    });
    expect(await call(w, 'POST', `/paste/${id}`, link, pasted(2))).toMatchObject({ status: 200 });
  });

  it('is one per name: asking again replaces the earlier one, and a paste closes the rest', async () => {
    const world = await setup();
    const { w, owner, environmentId, writer } = world;
    const first = await request(world, environmentId, writer.headers);
    const second = await request(world, environmentId, writer.headers);
    const pending = async () =>
      (await ok<{ requests: { id: string }[] }>(w, 'GET', '/paste-requests', owner)).requests.map(
        ({ id }) => id,
      );

    expect(await pending()).toEqual([second.id]);
    // The first request sent again (a retry whose answer was lost) is refused and closes nothing.
    expect(
      await call(w, 'POST', '/paste-requests', writer.headers, {
        id: first.id,
        environmentId,
        name: 'STRIPE_SECRET_KEY',
        reason: 'to take payments',
        hint: 'Stripe dashboard, Developers, API keys',
        tokenHash: await tokenHash(keyLike('t')),
      }),
    ).toMatchObject({ status: 409 });
    expect(await pending()).toEqual([second.id]);
    expect(await call(w, 'GET', `/paste/${first.id}`, first.link)).toMatchObject({ status: 410 });

    // Two left open by an older build are both closed by one paste.
    w.sqlite.exec("UPDATE paste_request SET status = 'pending', resolved_at = NULL");
    expect(await call(w, 'POST', `/paste/${second.id}`, second.link, pasted(1))).toMatchObject({
      status: 200,
    });
    expect(await pending()).toEqual([]);
    expect(w.sqlite.prepare('SELECT status FROM paste_request ORDER BY status').all()).toEqual([
      { status: 'cancelled' },
      { status: 'fulfilled' },
    ]);
  });

  it('is cancelled by its maker or the owner, and not by another service account', async () => {
    const world = await setup();
    const { w, environmentId, reader, writer } = world;
    const { id, link } = await request(world, environmentId, writer.headers);

    expect(await call(w, 'DELETE', `/paste-requests/${id}`, reader.headers)).toMatchObject({
      status: 404,
    });
    expect(await call(w, 'DELETE', `/paste-requests/${id}`, writer.headers)).toMatchObject({
      status: 200,
      body: { status: 'cancelled' },
    });
    expect(await call(w, 'POST', `/paste/${id}`, link, pasted(1))).toMatchObject({
      status: 410,
    });
    expect(w.sqlite.prepare('SELECT COUNT(*) AS versions FROM secret_version').get()).toEqual({
      versions: 0,
    });
  });
});
