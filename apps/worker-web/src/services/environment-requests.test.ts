/** Environment requests: a CLI login asks for a new environment; the owner approves by creating it, or rejects it. */
import { describe, expect, it } from 'vitest';
import { type Credential, call, indexOf, ok, sealedOf, storeWorld } from '../test-store.ts';
import { keyLike, sealedLike } from '../test-support.ts';

const HOUR = 3600 * 1000;

type Asked = { id: string; status: string; resolvedAt: number | null; createdAt: number };

const setup = async () => {
  const world = await storeWorld();
  const login = await world.pair('laptop');
  const { w, orgId, owner } = world;

  /** What `baymutt ask create-environment` sends, for `name` in `inOrg`. */
  const asking = (
    name: string,
    { inOrg = orgId, id = crypto.randomUUID(), reason = 'to deploy a preview' } = {},
  ) => ({ id, orgId: inOrg, name: indexOf(inOrg, name), sealedName: sealedOf(name), reason });

  const ask = (by: Credential, name: string, options: Parameters<typeof asking>[1] = {}) =>
    call(w, 'POST', '/environment-requests', by.headers, asking(name, options));

  /** A request the login made, waiting. */
  const asked = async (name: string, by: Credential = login) =>
    ok<Asked>(w, 'POST', '/environment-requests', by.headers, asking(name), 201);

  /** The owner's dashboard creating the environment `request` asks for, `answers` it, `changed` as given. */
  const create = async (answers: string | undefined, changed: Record<string, unknown> = {}) => {
    const request =
      answers === undefined
        ? null
        : await ok<{ id: string; orgId: string; name: string; sealedName: string }>(
            w,
            'GET',
            `/environment-requests/${answers}`,
            owner,
          );
    return call(w, 'POST', '/environments', owner, {
      id: request?.id ?? crypto.randomUUID(),
      orgId: request?.orgId ?? orgId,
      name: request?.name ?? indexOf(orgId, 'app/unrelated'),
      sealedName: request?.sealedName ?? sealedOf('app/unrelated'),
      publicKey: keyLike('p'),
      memberWrap: sealedLike('member-wrap'),
      memberProof: sealedLike('member-proof'),
      ...(answers === undefined ? {} : { answers }),
      ...changed,
    });
  };

  const statusOf = async (id: string) =>
    (await ok<Asked>(w, 'GET', `/environment-requests/${id}`, owner)).status;

  const count = (from: string, ...params: string[]) =>
    (w.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${from}`).get(...params) as { n: number }).n;

  const listed = async (headers: Record<string, string>) =>
    (await ok<{ requests: Asked[] }>(w, 'GET', '/environment-requests', headers)).requests.map(
      ({ id }) => id,
    );

  /** Moves a request's making back past its hour. */
  const age = (id: string) =>
    w.sqlite
      .prepare('UPDATE environment_request SET created_at = created_at - ? WHERE id = ?')
      .run(HOUR, id);

  return { ...world, login, asking, ask, asked, create, statusOf, count, listed, age };
};

describe('asking for an environment', () => {
  it('is a CLI login’s, logged with the name asked for, and creates nothing', async () => {
    const world = await setup();
    const { w, owner, orgId, login, ask, count, listed } = world;
    const id = crypto.randomUUID();

    const answer = await ask(login, 'app/preview', { id, reason: 'to try a branch' });
    expect(answer).toMatchObject({
      status: 201,
      body: {
        id,
        orgId,
        orgSlug: 'org-user-1',
        name: indexOf(orgId, 'app/preview'),
        sealedName: sealedOf('app/preview'),
        reason: 'to try a branch',
        status: 'pending',
        createdBy: { kind: 'credential', id: login.id, name: 'laptop' },
        createdAt: expect.any(Number),
        resolvedAt: null,
      },
    });
    expect(count('environment WHERE id = ?', id)).toBe(0);
    expect(
      await ok<{ events: unknown[] }>(w, 'GET', `/activity?environmentId=${id}`, owner),
    ).toMatchObject({
      events: [
        {
          action: 'environment-request.create',
          actor: { kind: 'credential', id: login.id },
          environmentName: indexOf(orgId, 'app/preview'),
          environmentSealedName: sealedOf('app/preview'),
          detail: 'to try a branch',
        },
      ],
    });
    expect(await listed(owner)).toEqual([id]);
    expect(await listed(login.headers)).toEqual([id]);
  });

  it('is refused to the owner and to a service account, who also do not see one', async () => {
    const world = await setup();
    const { w, owner, asking, asked, listed, serviceAccount } = world;
    const production = await world.environment('app/production');
    const made = await serviceAccount([{ environmentId: production, read: true }]);
    const request = await asked('app/preview');

    for (const headers of [owner, made.headers]) {
      expect(
        await call(w, 'POST', '/environment-requests', headers, asking('app/other')),
      ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
    }
    expect(await call(w, 'GET', `/environment-requests/${request.id}`, made.headers)).toMatchObject(
      { status: 404, body: { code: 'NotFoundError' } },
    );
    expect(
      await call(w, 'POST', `/environment-requests/${request.id}/reject`, made.headers),
    ).toMatchObject({ status: 404 });
    expect(await listed(made.headers)).toEqual([]);
  });

  it('is seen by the owner and the CLI login that made it, and nobody else', async () => {
    const world = await setup();
    const { w, owner, pair, asked, listed } = world;
    const other = await pair('desktop');
    const stranger = await storeWorld('user-2');
    const request = await asked('app/preview');

    expect(
      await call(w, 'GET', `/environment-requests/${request.id}`, other.headers),
    ).toMatchObject({ status: 404, body: { code: 'NotFoundError' } });
    expect(await listed(other.headers)).toEqual([]);
    expect(
      await call(stranger.w, 'GET', `/environment-requests/${request.id}`, stranger.owner),
    ).toMatchObject({ status: 404 });
    expect(await listed(owner)).toEqual([request.id]);
  });

  it('is refused in an unsealed org, an org not the person’s, and for a name or id taken, the bin included', async () => {
    const world = await setup();
    const { w, owner, login, ask, asked, count } = world;
    const unsealed = await world.org('legacy', { isSealed: false });
    const stranger = await storeWorld('user-2');
    const production = await world.environment('app/production');
    const binned = await world.environment('app/binned');
    await ok(w, 'DELETE', `/environments/${binned}`, owner);
    const waiting = await asked('app/waiting');

    expect(await ask(login, 'app/new', { inOrg: unsealed })).toMatchObject({
      status: 409,
      body: { code: 'NamesNotSealedError' },
    });
    expect(await ask(login, 'app/new', { inOrg: stranger.orgId })).toMatchObject({
      status: 404,
      body: { code: 'NotFoundError' },
    });
    for (const [name, id] of [
      ['app/production', undefined],
      ['app/binned', undefined],
      ['app/new', production],
      ['app/new', binned],
      ['app/new', waiting.id],
    ] as const) {
      expect(await ask(login, name, id === undefined ? {} : { id })).toMatchObject({
        status: 409,
        body: { code: 'AlreadyExistsError' },
      });
    }
    expect(count('environment_request')).toBe(1);
  });

  it('replaces the one waiting for the same name: the owner sees one', async () => {
    const world = await setup();
    const { owner, pair, asked, statusOf, listed } = world;
    const first = await asked('app/preview');
    const second = await asked('app/preview', await pair('desktop'));
    const elsewhere = await asked('app/other');

    expect(await statusOf(first.id)).toBe('rejected');
    expect(await statusOf(second.id)).toBe('pending');
    expect(await listed(owner)).toEqual([second.id, elsewhere.id]);
  });

  it('expires an hour after it was made, with nothing stored to say so', async () => {
    const world = await setup();
    const { w, owner, login, asked, age, listed, count } = world;
    const request = await asked('app/preview');
    age(request.id);

    const after = await ok<Asked>(w, 'GET', `/environment-requests/${request.id}`, login.headers);
    expect(after).toMatchObject({ status: 'expired', resolvedAt: after.createdAt + HOUR });
    expect(await listed(owner)).toEqual([]);
    expect(await listed(login.headers)).toEqual([]);
    expect(count("environment_request WHERE status = 'pending'")).toBe(1);
  });

  it('waits at most 20 at once per account, besides one it replaces', async () => {
    const world = await setup();
    const { login, ask, asked, age } = world;
    const requests = [];
    for (const n of Array.from({ length: 20 }, (_, i) => i)) {
      requests.push(await asked(`app/n${n}`));
    }

    expect(await ask(login, 'app/one-more')).toMatchObject({
      status: 403,
      body: { code: 'LimitReachedError', limit: 20 },
    });
    // One for a name already waiting replaces it, so the count does not grow.
    expect(await ask(login, 'app/n0')).toMatchObject({ status: 201 });
    // An expired one no longer counts.
    age(requests[1]?.id ?? '');
    expect(await ask(login, 'app/one-more')).toMatchObject({ status: 201 });
  });
});

describe('rejecting an environment request', () => {
  it('is the owner’s or its CLI login’s, logged, and once', async () => {
    const world = await setup();
    const { w, owner, orgId, login, pair, asked, statusOf } = world;
    const other = await pair('desktop');
    const byOwner = await asked('app/preview');
    const byMaker = await asked('app/other');

    expect(
      await call(w, 'POST', `/environment-requests/${byOwner.id}/reject`, other.headers),
    ).toMatchObject({ status: 404 });
    expect(
      await call(w, 'POST', `/environment-requests/${byOwner.id}/reject`, owner),
    ).toMatchObject({ status: 200, body: { status: 'rejected', resolvedAt: expect.any(Number) } });
    expect(
      await call(w, 'POST', `/environment-requests/${byMaker.id}/reject`, login.headers),
    ).toMatchObject({ status: 200, body: { status: 'rejected' } });
    expect(await statusOf(byMaker.id)).toBe('rejected');

    expect(
      await call(w, 'POST', `/environment-requests/${byOwner.id}/reject`, owner),
    ).toMatchObject({ status: 410, body: { code: 'LinkSpentError' } });
    expect(
      await ok<{ events: unknown[] }>(w, 'GET', `/activity?environmentId=${byOwner.id}`, owner),
    ).toMatchObject({
      events: [
        {
          action: 'environment-request.reject',
          actor: { kind: 'owner' },
          environmentName: indexOf(orgId, 'app/preview'),
          environmentSealedName: sealedOf('app/preview'),
        },
        { action: 'environment-request.create' },
      ],
    });
  });

  it('is refused once it has expired', async () => {
    const world = await setup();
    const { w, owner, asked, age } = world;
    const request = await asked('app/preview');
    age(request.id);

    expect(
      await call(w, 'POST', `/environment-requests/${request.id}/reject`, owner),
    ).toMatchObject({ status: 410, body: { code: 'LinkSpentError' } });
  });
});

describe('approving by creating the environment', () => {
  it('creates it and approves the request in one write, once', async () => {
    const world = await setup();
    const { w, owner, orgId, asked, create, statusOf, listed } = world;
    const request = await asked('app/preview');

    expect(await create(request.id)).toMatchObject({
      status: 201,
      body: {
        id: request.id,
        orgId,
        name: indexOf(orgId, 'app/preview'),
        sealedName: sealedOf('app/preview'),
        createdBy: { kind: 'owner' },
        canRead: true,
      },
    });
    expect(
      await ok<Asked>(w, 'GET', `/environment-requests/${request.id}`, world.login.headers),
    ).toMatchObject({ status: 'approved', resolvedAt: expect.any(Number) });
    expect(await listed(owner)).toEqual([]);
    expect(
      await ok<{ events: unknown[] }>(w, 'GET', `/activity?environmentId=${request.id}`, owner),
    ).toMatchObject({
      events: [
        { action: 'environment.create', environmentSealedName: sealedOf('app/preview') },
        { action: 'environment-request.create' },
      ],
    });

    // A second approval, under another id so only the answer is spent.
    expect(await create(request.id, { id: crypto.randomUUID() })).toMatchObject({
      status: 410,
      body: { code: 'LinkSpentError' },
    });
    expect(
      await call(w, 'POST', `/environment-requests/${request.id}/reject`, owner),
    ).toMatchObject({ status: 410 });
    expect(await statusOf(request.id)).toBe('approved');
  });

  it('is refused unless the id, org, name and sealed name are the request’s', async () => {
    const world = await setup();
    const { orgId, asked, create, statusOf, count } = world;
    const other = await world.org('other');
    const request = await asked('app/preview');

    for (const changed of [
      { id: crypto.randomUUID() },
      { orgId: other },
      { name: indexOf(orgId, 'app/other') },
      { sealedName: sealedOf('app/other') },
    ]) {
      expect(await create(request.id, changed)).toMatchObject({
        status: 400,
        body: { code: 'InvalidRequestError' },
      });
    }
    // One that is no request of the owner's.
    expect(await create(undefined, { answers: crypto.randomUUID() })).toMatchObject({
      status: 404,
      body: { code: 'NotFoundError' },
    });
    expect(count('environment WHERE org_id IN (?, ?)', orgId, other)).toBe(0);
    expect(await statusOf(request.id)).toBe('pending');
    expect(await create(request.id)).toMatchObject({ status: 201 });
  });

  it('is refused after the hour, and once rejected, and creates nothing', async () => {
    const world = await setup();
    const { w, owner, asked, age, create, count } = world;
    const expired = await asked('app/preview');
    const rejected = await asked('app/other');
    age(expired.id);
    await ok(w, 'POST', `/environment-requests/${rejected.id}/reject`, owner);

    for (const request of [expired, rejected]) {
      expect(await create(request.id)).toMatchObject({
        status: 410,
        body: { code: 'LinkSpentError' },
      });
      expect(count('environment WHERE id = ?', request.id)).toBe(0);
    }
  });

  it('loses to a reject that lands first, and creates nothing', async () => {
    const world = await setup();
    const { w, asked, create, statusOf, count } = world;
    const request = await asked('app/preview');
    // The CLI login withdraws it between the owner's checks and the creating batch.
    w.beforeStatement(/INSERT OR IGNORE INTO environment\b/, () => {
      w.sqlite.exec(`UPDATE environment_request SET status = 'rejected'`);
    });

    expect(await create(request.id)).toMatchObject({
      status: 410,
      body: { code: 'LinkSpentError' },
    });
    expect(count('environment WHERE id = ?', request.id)).toBe(0);
    expect(count('member_wrap WHERE environment_id = ?', request.id)).toBe(0);
    expect(await statusOf(request.id)).toBe('rejected');
  });

  it('leaves the request waiting when its name was taken since', async () => {
    const world = await setup();
    const { asked, create, statusOf } = world;
    const request = await asked('app/preview');
    await world.environment('app/preview');

    expect(await create(request.id)).toMatchObject({
      status: 409,
      body: { code: 'AlreadyExistsError' },
    });
    expect(await statusOf(request.id)).toBe('pending');
  });

  it('is not needed for an environment nobody asked for, which leaves requests alone', async () => {
    const world = await setup();
    const { asked, create, statusOf } = world;
    const request = await asked('app/preview');

    expect(await create(undefined)).toMatchObject({
      status: 201,
      body: { createdBy: { kind: 'owner' } },
    });
    expect(await statusOf(request.id)).toBe('pending');
  });
});
