/** Values as ciphertext: versioned writes, soft deletes, loads, and the paste link. */
import { tokenHash } from '@baymutt/keys/wire';
import { describe, expect, it } from 'vitest';
import { call, indexOf, ok, type StoreWorld, sealedOf, storeWorld } from '../test-store.ts';
import { keyLike, sealedLike } from '../test-support.ts';

const setup = async () => {
  const world = await storeWorld();
  const environmentId = await world.environment('app/production');
  const login = await world.pair('laptop');
  const reader = await world.serviceAccount([{ environmentId, read: true }], {
    name: 'reader',
    maker: login,
  });
  const writer = await world.serviceAccount([{ environmentId, write: true }], {
    name: 'writer',
    maker: login,
  });
  const apiKey = world.secretName(environmentId, 'API_KEY');
  return { ...world, environmentId, login, reader, writer, apiKey };
};

describe('writing', () => {
  it('needs a write grant and no key, and a writer can never load', async () => {
    const { w, environmentId, reader, writer, write, apiKey } = await setup();

    expect(await write(environmentId, 'API_KEY', 1, reader.headers)).toMatchObject({
      status: 403,
      body: { code: 'NoAccessError', need: 'write' },
    });
    expect(await write(environmentId, 'API_KEY', 1, writer.headers)).toMatchObject({
      status: 200,
      body: {
        name: apiKey,
        sealedName: sealedOf('API_KEY'),
        currentVersion: 1,
        latestVersion: 1,
        size: 72,
        updatedBy: { kind: 'credential', name: 'writer' },
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
      body: { secrets: [{ name: apiKey, sealedName: sealedOf('API_KEY'), currentVersion: 1 }] },
    });
  });

  it('adds a version each time and keeps every one, and its sealed name is the first write’s', async () => {
    const { w, owner, environmentId, writer, write, apiKey } = await setup();
    await write(environmentId, 'API_KEY', 1, writer.headers);

    // A later write's sealed name is ignored: the name is the one the store already filed.
    expect(
      await call(w, 'PUT', `/environments/${environmentId}/secrets/${apiKey}`, owner, {
        version: 2,
        keyVersion: 1,
        ciphertext: sealedLike('API_KEY-v2', 96),
        sealedName: sealedOf('SOMETHING_ELSE'),
      }),
    ).toMatchObject({
      status: 200,
      body: {
        currentVersion: 2,
        latestVersion: 2,
        sealedName: sealedOf('API_KEY'),
        updatedBy: { kind: 'owner' },
      },
    });
    expect(
      await call(w, 'GET', `/environments/${environmentId}/secrets/${apiKey}/versions`, owner),
    ).toMatchObject({
      status: 200,
      body: {
        versions: [
          { version: 2, isCurrent: true, createdBy: { kind: 'owner' } },
          { version: 1, isCurrent: false, createdBy: { kind: 'credential', name: 'writer' } },
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

  it('files a new name under its index with its sealed name, and refuses one without', async () => {
    const { w, owner, environmentId } = await setup();
    const value = { version: 1, keyVersion: 1, ciphertext: sealedLike('x', 96) };

    // A plain name, or an index with no sealed name: the store would hold a name it can read, or
    // one nobody can.
    for (const [name, body] of [
      ['API_KEY', { ...value, sealedName: sealedOf('API_KEY') }],
      [indexOf(environmentId, 'API_KEY'), value],
    ] as const) {
      expect(
        await call(w, 'PUT', `/environments/${environmentId}/secrets/${name}`, owner, body),
      ).toMatchObject({ status: 400, body: { code: 'InvalidRequestError' } });
    }
    expect(w.sqlite.prepare('SELECT COUNT(*) AS n FROM secret').get()).toEqual({ n: 0 });
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
    const { w, owner, environmentId, apiKey } = await setup();

    expect(
      await call(w, 'PUT', `/environments/${environmentId}/secrets/${apiKey}`, owner, {
        version: 1,
        keyVersion: 2,
        ciphertext: sealedLike('x', 96),
        sealedName: sealedOf('API_KEY'),
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
        `INSERT INTO secret_version SELECT environment_id, name, 2, key_version, 'b3RoZXI=', created_by, created_at FROM secret_version`,
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
        .prepare("SELECT COUNT(*) AS logged FROM activity_event WHERE action = 'secret.write'")
        .get(),
    ).toEqual({ logged: 1 });
  });

  it('refuses a stored name of the wrong shape, and a value over the limit', async () => {
    const { w, owner, environmentId, apiKey } = await setup();

    expect(
      await call(w, 'PUT', `/environments/${environmentId}/secrets/not.a.name`, owner, {
        version: 1,
        keyVersion: 1,
        ciphertext: sealedLike('x'),
      }),
    ).toMatchObject({ status: 400, body: { code: 'InvalidRequestError' } });
    expect(
      await call(w, 'PUT', `/environments/${environmentId}/secrets/${apiKey}`, owner, {
        version: 1,
        keyVersion: 1,
        ciphertext: 'A'.repeat(87_468),
        sealedName: sealedOf('API_KEY'),
      }),
    ).toMatchObject({ status: 400, body: { code: 'InvalidRequestError' } });
  });
});

describe('loading', () => {
  it('answers every current value as ciphertext with the caller’s own wrap', async () => {
    const { w, owner, orgId, environmentId, reader, write, secretName } = await setup();
    await write(environmentId, 'B_KEY', 1);
    await write(environmentId, 'A_KEY', 1);
    await write(environmentId, 'A_KEY', 2);
    const environment = {
      id: environmentId,
      name: indexOf(orgId, 'app/production'),
      sealedName: sealedOf('app/production'),
      publicKey: keyLike('p'),
      keyVersion: 1,
    };
    const secrets = [
      {
        name: secretName(environmentId, 'A_KEY'),
        sealedName: sealedOf('A_KEY'),
        version: 2,
        keyVersion: 1,
        ciphertext: sealedLike('A_KEY-v2', 96),
      },
      {
        name: secretName(environmentId, 'B_KEY'),
        sealedName: sealedOf('B_KEY'),
        version: 1,
        keyVersion: 1,
        ciphertext: sealedLike('B_KEY-v1', 96),
      },
    ].sort((one, other) => (one.name < other.name ? -1 : 1)); // as SQLite orders text: by code unit

    expect(await call(w, 'GET', `/environments/${environmentId}/bundle`, reader.headers)).toEqual({
      status: 200,
      body: { environment, wrap: sealedLike('read-wrap'), readerId: reader.id, secrets },
    });
    // Values load through a service account: the dashboard reveals one at a time instead.
    expect(await call(w, 'GET', `/environments/${environmentId}/bundle`, owner)).toMatchObject({
      status: 403,
      body: { code: 'NoAccessError' },
    });
  });

  it('stops for an environment in the bin, which only the owner deletes', async () => {
    const { w, owner, environmentId, reader, writer, login, write } = await setup();

    for (const headers of [reader.headers, login.headers]) {
      expect(await call(w, 'DELETE', `/environments/${environmentId}`, headers)).toMatchObject({
        status: 403,
        body: { code: 'OwnerRequiredError' },
      });
    }
    await ok(w, 'DELETE', `/environments/${environmentId}`, owner);

    expect(
      await call(w, 'GET', `/environments/${environmentId}/bundle`, reader.headers),
    ).toMatchObject({
      status: 404,
    });
    expect(await write(environmentId, 'API_KEY', 1, writer.headers)).toMatchObject({ status: 404 });
    expect(await call(w, 'GET', '/environments', owner)).toMatchObject({
      status: 200,
      body: { environments: [] },
    });
  });
});

describe('an org whose names are not sealed yet', () => {
  /**
   * What 0.7 left behind: an environment and a secret under their plain names, and a CI service
   * account holding read and write on it.
   */
  const legacy = async (world: StoreWorld) => {
    const { w, accountId } = world;
    const orgId = await world.org('legacy', { isSealed: false });
    const login = await world.pair('laptop');
    const owner = JSON.stringify({ kind: 'owner', id: accountId, name: 'Owner' });
    w.sqlite
      .prepare(
        `INSERT INTO environment (id, org_id, name, public_key, key_version, created_by, created_at)
         VALUES ('legacy-env', ?, 'app/production', ?, 1, ?, 0)`,
      )
      .run(orgId, keyLike('p'), owner);
    w.sqlite.exec(`INSERT INTO secret
        (environment_id, name, current_version, latest_version, updated_at, updated_by, write_id)
      VALUES ('legacy-env', 'API_KEY', 1, 1, 0, '${owner}', 'w')`);
    w.sqlite.exec(`INSERT INTO secret_version
        (environment_id, name, version, key_version, ciphertext, created_by, created_at)
      VALUES ('legacy-env', 'API_KEY', 1, 1, '${sealedLike('legacy-v1', 96)}', '${owner}', 0)`);
    const id = crypto.randomUUID();
    const secret = keyLike('d');
    w.sqlite
      .prepare(
        `INSERT INTO credential (id, account_id, name, public_key, bearer_hash, parent_id, created_at)
         VALUES (?, ?, 'deploy', ?, ?, ?, 0)`,
      )
      .run(id, accountId, keyLike('k'), await tokenHash(secret), login.id);
    w.sqlite
      .prepare(
        `INSERT INTO environment_grant
           (environment_id, credential_id, can_write, read_wrap, key_proof, key_version, created_at)
         VALUES ('legacy-env', ?, 1, ?, ?, 1, 0)`,
      )
      .run(id, sealedLike('read-wrap'), sealedLike('key-proof'));
    return {
      orgId,
      login,
      deploy: { id, headers: { authorization: `Bearer baymutt_${id}_${secret}` } },
    };
  };

  it('keeps working by name for what exists: load, write, delete, roll back, list', async () => {
    const world = await storeWorld();
    const { w } = world;
    const { deploy } = await legacy(world);
    const path = '/environments/legacy-env/secrets/API_KEY';

    expect(await call(w, 'GET', '/environments/legacy-env/bundle', deploy.headers)).toMatchObject({
      status: 200,
      body: {
        environment: { name: 'app/production', sealedName: null },
        secrets: [{ name: 'API_KEY', sealedName: null, version: 1 }],
      },
    });
    expect(
      await call(w, 'PUT', path, deploy.headers, {
        version: 2,
        keyVersion: 1,
        ciphertext: sealedLike('legacy-v2', 96),
      }),
    ).toMatchObject({
      status: 200,
      body: { name: 'API_KEY', sealedName: null, currentVersion: 2 },
    });
    expect(await call(w, 'DELETE', path, deploy.headers)).toMatchObject({ status: 200 });
    expect(
      await call(w, 'POST', `${path}/rollback`, deploy.headers, { version: 2, fromBin: true }),
    ).toMatchObject({ status: 200, body: { currentVersion: 2 } });
    expect(await call(w, 'GET', '/environments/legacy-env/secrets', deploy.headers)).toMatchObject({
      status: 200,
      body: { secrets: [{ name: 'API_KEY', sealedName: null }] },
    });
    expect(await call(w, 'GET', '/orgs', world.owner)).toMatchObject({
      body: {
        orgs: expect.arrayContaining([
          expect.objectContaining({ slug: 'legacy', areNamesSealed: false }),
        ]),
      },
    });
  });

  it('makes nothing with a new name: no secret, no paste link', async () => {
    const world = await storeWorld();
    const { w } = world;
    const { deploy, login } = await legacy(world);
    const notSealed = { status: 409, body: { code: 'NamesNotSealedError' } };

    for (const name of ['NEW_KEY', indexOf('legacy-env', 'NEW_KEY')]) {
      expect(
        await call(w, 'PUT', `/environments/legacy-env/secrets/${name}`, deploy.headers, {
          version: 1,
          keyVersion: 1,
          ciphertext: sealedLike('x', 96),
          sealedName: sealedOf('NEW_KEY'),
        }),
      ).toMatchObject(notSealed);
    }
    for (const headers of [deploy.headers, login.headers]) {
      expect(
        await call(w, 'POST', '/paste-links', headers, {
          id: crypto.randomUUID(),
          environmentId: 'legacy-env',
          name: indexOf('legacy-env', 'STRIPE_KEY'),
          sealedName: sealedOf('STRIPE_KEY'),
          reason: 'to take payments',
          hint: 'Stripe',
        }),
      ).toMatchObject(notSealed);
    }
  });
});

describe('revealing in the dashboard', () => {
  it('answers the owner one version’s ciphertext with the vault open, and logs it', async () => {
    const { w, owner, locked, environmentId, reader, write, apiKey } = await setup();
    await write(environmentId, 'API_KEY', 1);
    await write(environmentId, 'API_KEY', 2);
    const reveal = (version: number, headers = owner) =>
      call(w, 'POST', `/environments/${environmentId}/secrets/${apiKey}/reveal`, headers, {
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
          "SELECT secret_name, secret_sealed_name, version FROM activity_event WHERE action = 'secret.reveal' ORDER BY id",
        )
        .all(),
    ).toEqual([{ secret_name: apiKey, secret_sealed_name: sealedOf('API_KEY'), version: 1 }]);
  });
});

describe('deleting and rolling back', () => {
  it('a delete hides the value from a load and keeps its versions; a rollback brings one back', async () => {
    const { w, owner, environmentId, reader, writer, write, apiKey, secretName } = await setup();
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
      await call(w, 'DELETE', `/environments/${environmentId}/secrets/${apiKey}`, reader.headers),
    ).toMatchObject({ status: 403, body: { code: 'NoAccessError' } });
    expect(
      await call(w, 'DELETE', `/environments/${environmentId}/secrets/${apiKey}`, writer.headers),
    ).toMatchObject({ status: 200, body: { currentVersion: null, latestVersion: 2, size: null } });
    expect(await loaded()).toEqual([]);
    expect(w.sqlite.prepare('SELECT COUNT(*) AS versions FROM secret_version').get()).toEqual({
      versions: 2,
    });

    expect(
      await call(
        w,
        'POST',
        `/environments/${environmentId}/secrets/${apiKey}/rollback`,
        writer.headers,
        { version: 1 },
      ),
    ).toMatchObject({ status: 200, body: { currentVersion: 1, latestVersion: 2 } });
    expect(await loaded()).toEqual([1]);
    // The next write is still one above the highest ever written, never over a kept version.
    expect(await write(environmentId, 'API_KEY', 3)).toMatchObject({
      status: 200,
      body: { currentVersion: 3, latestVersion: 3 },
    });
    expect(
      await call(w, 'POST', `/environments/${environmentId}/secrets/${apiKey}/rollback`, owner, {
        version: 9,
      }),
    ).toMatchObject({ status: 404 });
    expect(
      await call(
        w,
        'DELETE',
        `/environments/${environmentId}/secrets/${secretName(environmentId, 'MISSING')}`,
        owner,
      ),
    ).toMatchObject({ status: 404 });
  });
});

describe('a paste link', () => {
  const STRIPE = 'STRIPE_SECRET_KEY';

  const request = async (
    { w }: StoreWorld,
    environmentId: string,
    headers: Record<string, string>,
    id: string = crypto.randomUUID(),
  ) => {
    const answer = await call(w, 'POST', '/paste-links', headers, {
      id,
      environmentId,
      name: indexOf(environmentId, STRIPE),
      sealedName: sealedOf(STRIPE),
      reason: 'to take payments',
      hint: 'Stripe dashboard, Developers, API keys',
    });
    return { id, answer };
  };
  const pasted = (version: number) => ({
    version,
    keyVersion: 1,
    ciphertext: sealedLike('pasted', 96),
  });

  it('is made by a CLI login of the org or a service account that writes, and answered by the owner alone, once', async () => {
    const world = await setup();
    const { w, owner, locked, orgId, environmentId, login, reader, writer } = world;
    const stripe = indexOf(environmentId, STRIPE);

    expect((await request(world, environmentId, reader.headers)).answer).toMatchObject({
      status: 403,
      body: { code: 'NoAccessError', need: 'write' },
    });
    expect((await request(world, environmentId, writer.headers)).answer).toMatchObject({
      status: 201,
      body: { createdBy: { name: 'writer' } },
    });
    const { id, answer } = await request(world, environmentId, login.headers);
    expect(answer).toMatchObject({
      status: 201,
      body: { status: 'pending', name: stripe, sealedName: sealedOf(STRIPE) },
    });
    expect(answer.body).not.toHaveProperty('linkExpiresAt');
    expect(await call(w, 'GET', '/paste-links', owner)).toMatchObject({
      body: { links: [{ id, name: stripe, createdBy: { name: 'laptop' } }] },
    });
    expect(await call(w, 'GET', '/paste-links', login.headers)).toMatchObject({
      body: { links: [{ id }] },
    });

    // Nobody but the signed-in owner: not the CLI login that made it, not a service account.
    for (const headers of [login.headers, writer.headers]) {
      expect(await call(w, 'GET', `/paste/${id}`, headers)).toMatchObject({
        status: 403,
        body: { code: 'OwnerRequiredError' },
      });
      expect(await call(w, 'POST', `/paste/${id}`, headers, pasted(1))).toMatchObject({
        status: 403,
        body: { code: 'OwnerRequiredError' },
      });
    }
    expect(await call(w, 'GET', `/paste/${id}`, {})).toMatchObject({ status: 401 });
    expect(await call(w, 'POST', `/paste/${id}`, locked, pasted(1))).toMatchObject({
      status: 403,
      body: { code: 'VaultLockedError' },
    });
    expect(await call(w, 'GET', `/paste/${id}`, owner)).toMatchObject({
      status: 200,
      body: {
        environmentPublicKey: keyLike('p'),
        keyVersion: 1,
        nextVersion: 1,
        link: {
          orgId,
          environmentName: indexOf(orgId, 'app/production'),
          environmentSealedName: sealedOf('app/production'),
          name: stripe,
          sealedName: sealedOf(STRIPE),
        },
      },
    });

    // The value goes in under the link's own name and sealed name, as the owner's act.
    expect(await call(w, 'POST', `/paste/${id}`, owner, pasted(1))).toMatchObject({
      status: 200,
      body: {
        name: stripe,
        sealedName: sealedOf(STRIPE),
        currentVersion: 1,
        updatedBy: { kind: 'owner' },
      },
    });
    expect(
      w.sqlite
        .prepare(
          "SELECT actor, secret_name, secret_sealed_name FROM activity_event WHERE action = 'paste-link.fulfil'",
        )
        .get(),
    ).toMatchObject({
      actor: expect.stringContaining('"kind":"owner"'),
      secret_name: stripe,
      secret_sealed_name: sealedOf(STRIPE),
    });
    for (const [method, body] of [
      ['GET', undefined],
      ['POST', pasted(2)],
    ] as const) {
      expect(await call(w, method, `/paste/${id}`, owner, body)).toMatchObject({
        status: 410,
        body: { code: 'LinkSpentError' },
      });
    }
    expect(await call(w, 'GET', '/paste-links', owner)).toEqual({
      status: 200,
      body: { links: [] },
    });
  });

  it('is answered only by an owner of its own org', async () => {
    const world = await setup();
    const { w, environmentId, login } = world;
    const { id } = await request(world, environmentId, login.headers);
    const stranger = await storeWorld('user-2');

    expect(await call(stranger.w, 'GET', `/paste/${id}`, stranger.owner)).toMatchObject({
      status: 404,
    });
    expect(await call(w, 'GET', `/paste/${crypto.randomUUID()}`, world.owner)).toMatchObject({
      status: 404,
    });
  });

  it('stays unspent when the pasted value loses its slot to another write', async () => {
    const world = await setup();
    const { w, owner, environmentId, writer, write } = world;
    const { id } = await request(world, environmentId, writer.headers);
    await write(environmentId, STRIPE, 1);

    expect(await call(w, 'POST', `/paste/${id}`, owner, pasted(1))).toMatchObject({
      status: 409,
      body: { code: 'VersionConflictError', latestVersion: 1 },
    });
    expect(await call(w, 'GET', `/paste/${id}`, owner)).toMatchObject({
      status: 200,
      body: { nextVersion: 2 },
    });
    expect(await call(w, 'POST', `/paste/${id}`, owner, pasted(2))).toMatchObject({ status: 200 });
  });

  it('is one per name: asking again replaces the earlier one, and a paste closes the rest', async () => {
    const world = await setup();
    const { w, owner, environmentId, writer } = world;
    const first = await request(world, environmentId, writer.headers);
    const second = await request(world, environmentId, writer.headers);
    const pending = async () =>
      (await ok<{ links: { id: string }[] }>(w, 'GET', '/paste-links', owner)).links.map(
        ({ id }) => id,
      );

    expect(await pending()).toEqual([second.id]);
    // The first request sent again (a retry whose answer was lost) is refused.
    expect((await request(world, environmentId, writer.headers, first.id)).answer).toMatchObject({
      status: 409,
    });
    expect(await call(w, 'GET', `/paste/${first.id}`, owner)).toMatchObject({ status: 410 });

    // Two left open by an older build are both closed by one paste.
    w.sqlite.exec("UPDATE paste_link SET status = 'pending', resolved_at = NULL");
    expect(await call(w, 'POST', `/paste/${second.id}`, owner, pasted(1))).toMatchObject({
      status: 200,
    });
    expect(await pending()).toEqual([]);
    expect(w.sqlite.prepare('SELECT status FROM paste_link ORDER BY status').all()).toEqual([
      { status: 'cancelled' },
      { status: 'fulfilled' },
    ]);
  });

  it('expires an hour after it was made, unanswered: read as expired, and past pasting', async () => {
    const world = await setup();
    const { w, owner, environmentId, reader, login } = world;
    const { id } = await request(world, environmentId, login.headers);
    expect(await call(w, 'GET', `/paste-links/${id}`, login.headers)).toMatchObject({
      body: { status: 'pending' },
    });
    // Its maker and the owner read it, and no other key.
    expect(await call(w, 'GET', `/paste-links/${id}`, reader.headers)).toMatchObject({
      status: 404,
    });

    w.sqlite
      .prepare('UPDATE paste_link SET created_at = created_at - ? WHERE id = ?')
      .run(3600 * 1000, id);

    for (const headers of [login.headers, owner]) {
      expect(await call(w, 'GET', `/paste-links/${id}`, headers)).toMatchObject({
        body: { status: 'expired' },
      });
    }
    expect(await ok(w, 'GET', '/paste-links', owner)).toEqual({ links: [] });
    expect(await call(w, 'GET', `/paste/${id}`, owner)).toMatchObject({
      status: 410,
      body: { code: 'LinkSpentError' },
    });
    expect(await call(w, 'POST', `/paste/${id}`, owner, pasted(1))).toMatchObject({
      status: 410,
    });
    expect(await call(w, 'DELETE', `/paste-links/${id}`, login.headers)).toMatchObject({
      status: 410,
    });
    expect(w.sqlite.prepare('SELECT COUNT(*) AS n FROM secret_version').get()).toEqual({ n: 0 });
  });

  it('is cancelled by its maker or the owner, and not by another key', async () => {
    const world = await setup();
    const { w, owner, environmentId, reader, login } = world;
    const { id } = await request(world, environmentId, login.headers);

    expect(await call(w, 'DELETE', `/paste-links/${id}`, reader.headers)).toMatchObject({
      status: 404,
    });
    expect(await call(w, 'DELETE', `/paste-links/${id}`, login.headers)).toMatchObject({
      status: 200,
      body: { status: 'cancelled' },
    });
    expect(await call(w, 'POST', `/paste/${id}`, owner, pasted(1))).toMatchObject({
      status: 410,
    });
    expect(w.sqlite.prepare('SELECT COUNT(*) AS versions FROM secret_version').get()).toEqual({
      versions: 0,
    });
    expect(
      w.sqlite
        .prepare("SELECT secret_sealed_name FROM activity_event WHERE action = 'paste-link.cancel'")
        .get(),
    ).toEqual({ secret_sealed_name: sealedOf(STRIPE) });
  });

  it('is not cancelled, nor logged so, when it is answered between its read and its write', async () => {
    const world = await setup();
    const { w, environmentId, login } = world;
    const { id } = await request(world, environmentId, login.headers);
    // The owner pastes the value just before the cancel's batch.
    w.beforeStatement(/INSERT INTO activity_event/, () => {
      w.sqlite.exec(`UPDATE paste_link SET status = 'fulfilled'`);
    });

    expect(await call(w, 'DELETE', `/paste-links/${id}`, login.headers)).toMatchObject({
      status: 410,
      body: { code: 'LinkSpentError', message: expect.stringContaining('fulfilled') },
    });
    expect(
      w.sqlite
        .prepare("SELECT COUNT(*) AS n FROM activity_event WHERE action = 'paste-link.cancel'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it('stays expired when its environment goes to the bin and comes back', async () => {
    const world = await setup();
    const { w, owner, environmentId, login } = world;
    const expired = await request(world, environmentId, login.headers);
    w.sqlite
      .prepare('UPDATE paste_link SET created_at = created_at - ? WHERE id = ?')
      .run(3600 * 1000, expired.id);
    // Asked again once the first expired, so it does not replace it.
    const waiting = await request(world, environmentId, login.headers);

    await ok(w, 'DELETE', `/environments/${environmentId}`, owner);
    await ok(w, 'POST', `/environments/${environmentId}/restore`, owner);

    expect(await call(w, 'GET', `/paste-links/${expired.id}`, owner)).toMatchObject({
      body: { status: 'expired' },
    });
    expect(await call(w, 'GET', `/paste-links/${waiting.id}`, owner)).toMatchObject({
      body: { status: 'cancelled' },
    });
  });
});
