/** Key changes: a CLI login asks to add to, give back from, or re-end a key it asked for, on the same key. */
import * as Effect from 'effect/Effect';
import { describe, expect, it } from 'vitest';
import {
  type Ask,
  type Credential,
  call,
  NAMES_KEY_WRAP,
  ok,
  type StoreWorld,
  storeWorld,
} from '../test-store.ts';
import { sealedLike, send } from '../test-support.ts';
import { Access } from './access.ts';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

type Held = { environmentId: string; canRead: boolean; canWrite: boolean };
type Change = {
  id: string;
  status: string;
  key: { id: string; expiresAt: number | null; keyVoucher: string | null };
  holds: Held[];
  add: (Held & { orgId: string })[];
  giveBack: Held[];
};

const setup = async () => {
  const world = await storeWorld();
  const production = await world.environment('app/production');
  const staging = await world.environment('app/staging');
  const login = await world.pair('laptop');
  const key = await world.serviceAccount([{ environmentId: staging, read: true }], {
    maker: login,
    name: 'agent',
  });
  return { ...world, production, staging, login, key };
};

/** What `baymutt ask change` sends. */
const asking = (
  { w }: StoreWorld,
  login: Credential,
  keyId: string,
  {
    add = [],
    giveBack = [],
    lifetime = null,
  }: {
    readonly add?: ReadonlyArray<Ask>;
    readonly giveBack?: ReadonlyArray<string>;
    readonly lifetime?: number | null;
  },
) => {
  const id = crypto.randomUUID();
  return call(w, 'POST', '/key-changes', login.headers, {
    id,
    keyId,
    reason: 'one more environment',
    lifetime,
    add: add.map(({ environmentId, read = false, write = false }) => ({
      environmentId,
      canRead: read,
      canWrite: write,
    })),
    giveBack,
  }).then(answer => ({ id, answer }));
};

/** What the owner's dashboard sends to approve a change as it was asked. */
const approving = async (
  { w, owner }: StoreWorld,
  id: string,
  end: { readonly expiresAt?: number | null } = {},
) => {
  const change = await ok<Change>(w, 'GET', `/key-changes/${id}`, owner);
  return call(w, 'POST', `/key-changes/${id}/approve`, owner, {
    ...end,
    grants: change.add.map(item => ({
      environmentId: item.environmentId,
      readWrap: item.canRead ? sealedLike('read-wrap') : null,
      keyProof: sealedLike('key-proof'),
      keyVersion: 1,
    })),
    namesKeyWraps: [...new Set(change.add.map(item => item.orgId))].map(orgId => ({
      orgId,
      wrap: NAMES_KEY_WRAP,
    })),
  });
};

/** What the key itself lists now, as the CLI checks it. */
const holding = async ({ w }: StoreWorld, key: Credential) =>
  (
    await ok<{ environments: { id: string; canRead: boolean; canWrite: boolean }[] }>(
      w,
      'GET',
      '/environments',
      key.headers,
    )
  ).environments
    .map(({ id, canRead, canWrite }) => ({ id, canRead, canWrite }))
    .toSorted((a, b) => a.id.localeCompare(b.id));

const actions = ({ w }: StoreWorld) =>
  w.sqlite
    .prepare('SELECT action, actor, detail, environment_id FROM activity_event ORDER BY id')
    .all() as Array<{ action: string; actor: string; detail: string | null }>;

describe('a change that adds', () => {
  it('waits for the owner, then the same key holds what it held and what was added', async () => {
    const world = await setup();
    const { w, owner, production, staging, login, key, pair } = world;
    const other = await pair('desktop');

    const { id, answer } = await asking(world, login, key.id, {
      add: [{ environmentId: production, read: true }],
    });
    expect(answer).toMatchObject({
      status: 201,
      body: {
        id,
        status: 'pending',
        reason: 'one more environment',
        lifetime: null,
        key: { id: key.id, name: 'agent', intent: 'agent', keyVoucher: null },
        holds: [{ environmentId: staging, canRead: true, canWrite: false }],
        add: [{ environmentId: production, canRead: true, canWrite: false }],
        giveBack: [],
        maker: { id: login.id, endorsement: null },
        resolvedAt: null,
      },
    });
    // Nothing changes until the owner answers.
    expect(await holding(world, key)).toEqual([{ id: staging, canRead: true, canWrite: false }]);

    // The owner and the login that asked see it; another login and the key itself do not.
    expect(await call(w, 'GET', `/key-changes/${id}`, owner)).toMatchObject({
      status: 200,
      body: { key: { keyVoucher: expect.any(String) }, maker: { endorsement: expect.any(String) } },
    });
    for (const headers of [other.headers, key.headers]) {
      expect(await call(w, 'GET', `/key-changes/${id}`, headers)).toMatchObject({ status: 404 });
    }
    const listed = async (headers: Record<string, string>) =>
      (await ok<{ changes: { id: string }[] }>(w, 'GET', '/key-changes', headers)).changes.map(
        change => change.id,
      );
    expect(await listed(owner)).toEqual([id]);
    expect(await listed(login.headers)).toEqual([id]);
    expect(await listed(other.headers)).toEqual([]);
    expect(await listed(key.headers)).toEqual([]);

    expect(await approving(world, id)).toMatchObject({
      status: 200,
      body: { status: 'approved', key: { expiresAt: null } },
    });
    expect(await holding(world, key)).toEqual(
      [
        { id: production, canRead: true, canWrite: false },
        { id: staging, canRead: true, canWrite: false },
      ].toSorted((a, b) => a.id.localeCompare(b.id)),
    );
    expect(await listed(owner)).toEqual([]);
    expect(actions(world).slice(-2)).toMatchObject([
      { action: 'grant.set', detail: 'agent: read' },
      { action: 'key-change.approve', detail: 'agent: same end' },
    ]);
  });

  it('adds access on an environment the key already holds', async () => {
    const world = await setup();
    const { staging, login, key } = world;
    const { id } = await asking(world, login, key.id, {
      add: [{ environmentId: staging, write: true }],
    });
    expect(await approving(world, id)).toMatchObject({ status: 200 });
    expect(await holding(world, key)).toEqual([{ id: staging, canRead: true, canWrite: true }]);
  });

  it('is refused an approval that does not match it', async () => {
    const world = await setup();
    const { w, owner, production, staging, login, key } = world;
    const { id } = await asking(world, login, key.id, {
      add: [{ environmentId: staging, write: true }],
    });
    const answer = (grants: unknown[], namesKeyWraps: unknown[] = []) =>
      call(w, 'POST', `/key-changes/${id}/approve`, owner, { grants, namesKeyWraps });
    const grant = (environmentId: string, read: boolean) => ({
      environmentId,
      readWrap: read ? sealedLike('read-wrap') : null,
      keyProof: sealedLike('key-proof'),
      keyVersion: 1,
    });
    const wraps = [{ orgId: world.orgId, wrap: NAMES_KEY_WRAP }];
    // It adds write only: a read wrap is refused, even where the key reads already, which it
    // keeps under the wrap it has.
    expect(await answer([grant(staging, true)], wraps)).toMatchObject({ status: 400 });
    expect(await answer([grant(production, false)], wraps)).toMatchObject({ status: 400 });
    expect(await answer([grant(staging, false)])).toMatchObject({ status: 400 });
    expect(await holding(world, key)).toEqual([{ id: staging, canRead: true, canWrite: false }]);
    const before = w.sqlite
      .prepare('SELECT read_wrap FROM environment_grant WHERE credential_id = ?')
      .get(key.id);
    expect(await answer([grant(staging, false)], wraps)).toMatchObject({ status: 200 });
    expect(await holding(world, key)).toEqual([{ id: staging, canRead: true, canWrite: true }]);
    expect(
      w.sqlite
        .prepare('SELECT read_wrap FROM environment_grant WHERE credential_id = ?')
        .get(key.id),
    ).toEqual(before);
  });
});

describe('giving back', () => {
  it('alone takes effect at once, needs no approval, and is in the activity', async () => {
    const world = await setup();
    const { w, owner, production, staging, login, serviceAccount } = world;
    const key = await serviceAccount(
      [
        { environmentId: staging, read: true },
        { environmentId: production, read: true, write: true },
      ],
      { maker: login, name: 'agent' },
    );
    const { id, answer } = await asking(world, login, key.id, { giveBack: [production] });
    expect(answer).toMatchObject({
      status: 201,
      body: {
        status: 'applied',
        holds: [{ environmentId: staging }],
        giveBack: [{ environmentId: production, canRead: true, canWrite: true }],
      },
    });
    expect(await holding(world, key)).toEqual([{ id: staging, canRead: true, canWrite: false }]);
    expect(
      (await ok<{ changes: unknown[] }>(w, 'GET', '/key-changes', owner)).changes,
    ).toHaveLength(0);
    expect(actions(world).at(-1)).toMatchObject({
      action: 'grant.remove',
      detail: 'agent',
      actor: expect.stringContaining(login.id),
    });
    // Already applied: nothing is left to approve.
    expect(
      await call(w, 'POST', `/key-changes/${id}/approve`, owner, {
        grants: [],
        namesKeyWraps: [],
      }),
    ).toMatchObject({ status: 410, body: { code: 'LinkSpentError' } });
  });

  it('with an addition is approved as one', async () => {
    const world = await setup();
    const { w, owner, production, staging, login, key } = world;
    const { id, answer } = await asking(world, login, key.id, {
      add: [{ environmentId: production, read: true, write: true }],
      giveBack: [staging],
    });
    expect(answer).toMatchObject({ status: 201, body: { status: 'pending' } });
    // Nothing is given back before the owner answers.
    expect(await holding(world, key)).toEqual([{ id: staging, canRead: true, canWrite: false }]);

    expect(await approving(world, id)).toMatchObject({ status: 200 });
    expect(await holding(world, key)).toEqual([{ id: production, canRead: true, canWrite: true }]);
    expect(
      (await ok<{ holds: Held[] }>(w, 'GET', `/key-changes/${id}`, owner)).holds,
    ).toMatchObject([{ environmentId: production }]);
  });
});

describe('a change that is not approved', () => {
  it('leaves the key as it was when the owner rejects it, or its login withdraws it', async () => {
    const world = await setup();
    const { w, owner, production, staging, login, key } = world;
    for (const headers of [owner, login.headers]) {
      const { id } = await asking(world, login, key.id, {
        add: [{ environmentId: production, read: true }],
        giveBack: [staging],
        lifetime: DAY,
      });
      expect(await call(w, 'POST', `/key-changes/${id}/reject`, headers)).toMatchObject({
        status: 200,
        body: { status: 'rejected' },
      });
      expect(await approving(world, id)).toMatchObject({
        status: 410,
        body: { code: 'LinkSpentError' },
      });
    }
    expect(await holding(world, key)).toEqual([{ id: staging, canRead: true, canWrite: false }]);
    expect(await call(w, 'GET', '/environments', key.headers)).toMatchObject({ status: 200 });
    expect(actions(world).at(-1)).toMatchObject({ action: 'key-change.reject', detail: 'agent' });
  });

  it('expires after an hour, and the daily run says so; the key keeps working as it was', async () => {
    const world = await setup();
    const { w, owner, production, staging, login, key } = world;
    const { id } = await asking(world, login, key.id, {
      add: [{ environmentId: production, read: true }],
    });
    w.sqlite
      .prepare('UPDATE key_change SET created_at = created_at - ? WHERE id = ?')
      .run(HOUR, id);
    expect(await call(w, 'GET', `/key-changes/${id}`, login.headers)).toMatchObject({
      body: { status: 'expired' },
    });
    expect(await approving(world, id)).toMatchObject({ status: 410 });
    // An expired one does not stand in the way of the next.
    expect(
      (await asking(world, login, key.id, { add: [{ environmentId: production, read: true }] }))
        .answer,
    ).toMatchObject({ status: 201 });

    await Effect.runPromise(
      Effect.flatMap(Access, access => access.sweepKeyChanges).pipe(Effect.provide(w.services)),
    );
    expect(
      w.sqlite.prepare('SELECT status FROM key_change WHERE id = ?').get(id) as { status: string },
    ).toEqual({ status: 'expired' });
    expect(actions(world).at(-1)).toMatchObject({ action: 'key-change.expire', detail: 'agent' });
    expect(await holding(world, key)).toEqual([{ id: staging, canRead: true, canWrite: false }]);
    expect(await call(w, 'GET', `/key-changes/${id}`, owner)).toMatchObject({
      body: { status: 'expired' },
    });
  });

  it('is closed when its key is revoked', async () => {
    const world = await setup();
    const { w, owner, production, login, key } = world;
    const { id } = await asking(world, login, key.id, {
      add: [{ environmentId: production, read: true }],
    });
    await ok(w, 'DELETE', `/credentials/${key.id}`, login.headers);
    expect(await call(w, 'GET', `/key-changes/${id}`, owner)).toMatchObject({
      body: { status: 'rejected' },
    });
    expect(await approving(world, id)).toMatchObject({ status: 410 });
  });
});

describe('a new end', () => {
  it('counts from the approval, as asked or as the owner picks, and alone still needs approval', async () => {
    const world = await setup();
    const { w, login, key } = world;
    const { id, answer } = await asking(world, login, key.id, { lifetime: DAY });
    expect(answer).toMatchObject({ status: 201, body: { status: 'pending', lifetime: DAY } });
    const until = Date.now() + DAY;
    expect(await approving(world, id, { expiresAt: until })).toMatchObject({
      status: 200,
      body: { key: { expiresAt: until } },
    });
    expect(actions(world).at(-1)).toMatchObject({ action: 'key-change.approve' });

    const never = await asking(world, login, key.id, { lifetime: HOUR });
    expect(await approving(world, never.id, { expiresAt: null })).toMatchObject({
      body: { key: { expiresAt: null } },
    });
    expect(actions(world).at(-1)).toMatchObject({ detail: 'agent: no end' });
    expect(await call(w, 'GET', '/environments', key.headers)).toMatchObject({ status: 200 });
  });
});

describe('asking to change a key', () => {
  it('is refused to the owner, to a key, and for a key another login asked for', async () => {
    const world = await setup();
    const { owner, production, key, pair } = world;
    const add = [{ environmentId: production, read: true }];
    for (const asker of [{ id: 'owner', headers: owner }, key]) {
      expect((await asking(world, asker, key.id, { add })).answer).toMatchObject({
        status: 403,
        body: { code: 'OwnerRequiredError' },
      });
    }
    const other = await pair('desktop');
    expect((await asking(world, other, key.id, { add })).answer).toMatchObject({
      status: 404,
    });
    expect((await asking(world, other, crypto.randomUUID(), { add })).answer).toMatchObject({
      status: 404,
    });
  });

  it('is asked for a service account as for an agent key, and refused for an ended key and a key whose request still waits', async () => {
    const world = await setup();
    const { w, production, staging, login, ask, approve } = world;
    const add = [{ environmentId: production, read: true }];

    const ci = await ask(login, [{ environmentId: staging, read: true }], {
      command: 'gh secret set BAYMUTT_KEY',
    });
    expect((await asking(world, login, ci.id, { add })).answer).toMatchObject({ status: 404 });
    await approve(ci.id);
    const toCi = await asking(world, login, ci.id, { add });
    expect(toCi.answer).toMatchObject({
      status: 201,
      body: { status: 'pending', key: { id: ci.id, intent: 'service-account' } },
    });
    expect(await approving(world, toCi.id)).toMatchObject({ status: 200 });
    expect(await holding(world, { id: ci.id, headers: ci.headers })).toHaveLength(2);

    const ended = await ask(login, [{ environmentId: staging, read: true }]);
    await approve(ended.id, Date.now() + HOUR);
    w.sqlite.prepare('UPDATE credential SET expires_at = 1 WHERE id = ?').run(ended.id);
    expect((await asking(world, login, ended.id, { add })).answer).toMatchObject({
      status: 400,
      body: { message: expect.stringContaining('has ended') },
    });
  });

  it('asks for something the key lacks, names each environment once, and waits one at a time', async () => {
    const world = await setup();
    const { w, owner, production, staging, login, key } = world;
    const refused = async (change: Parameters<typeof asking>[3], status = 400) =>
      expect((await asking(world, login, key.id, change)).answer).toMatchObject({ status });

    await refused({});
    await refused({ add: [{ environmentId: staging, read: true }] });
    await refused({ add: [{ environmentId: production }] });
    await refused({ giveBack: [production] });
    await refused({ add: [{ environmentId: staging, write: true }], giveBack: [staging] });
    await refused({ add: [{ environmentId: crypto.randomUUID(), read: true }] }, 404);
    await ok(w, 'DELETE', `/environments/${production}`, owner);
    await refused({ add: [{ environmentId: production, read: true }] }, 404);
    await ok(w, 'POST', `/environments/${production}/restore`, owner);

    const first = await asking(world, login, key.id, {
      add: [{ environmentId: production, read: true }],
    });
    expect(first.answer).toMatchObject({ status: 201 });
    expect(
      (await asking(world, login, key.id, { add: [{ environmentId: staging, write: true }] }))
        .answer,
    ).toMatchObject({
      status: 409,
      body: { message: expect.stringContaining(first.id) },
    });
  });
});

describe('approving a change while the key changes under it', () => {
  it('merges with the grant as it is when it writes: access removed meanwhile is not put back', async () => {
    const world = await setup();
    const { w, owner, staging, login, key } = world;
    const { id } = await asking(world, login, key.id, {
      add: [{ environmentId: staging, write: true }],
    });
    // The owner removes the key's access to staging between the approval's checks and its batch.
    let isRemoved = false;
    w.beforeStatement(/INSERT INTO environment_grant\b/, () => {
      if (isRemoved) return;
      isRemoved = true;
      w.sqlite.prepare('DELETE FROM environment_grant WHERE credential_id = ?').run(key.id);
    });
    expect(await approving(world, id)).toMatchObject({ status: 200 });
    // Write, as approved, and no read: the read it had was taken away and is not put back.
    expect(await holding(world, key)).toEqual([{ id: staging, canRead: false, canWrite: true }]);
    expect(
      w.sqlite
        .prepare('SELECT read_wrap FROM environment_grant WHERE credential_id = ?')
        .get(key.id),
    ).toEqual({ read_wrap: null });
    void owner;
  });

  it('does not change, or extend, a key that ends between the checks and the write', async () => {
    const world = await setup();
    const { w, production, login, key } = world;
    const { id } = await asking(world, login, key.id, {
      add: [{ environmentId: production, read: true }],
      lifetime: DAY,
    });
    let isEnded = false;
    w.beforeStatement(/INSERT INTO environment_grant\b/, () => {
      if (isEnded) return;
      isEnded = true;
      w.sqlite.prepare('UPDATE credential SET expires_at = 1 WHERE id = ?').run(key.id);
    });
    expect(await approving(world, id, { expiresAt: Date.now() + DAY })).toMatchObject({
      status: 410,
    });
    expect(w.sqlite.prepare('SELECT expires_at FROM credential WHERE id = ?').get(key.id)).toEqual({
      expires_at: 1,
    });
    expect(
      w.sqlite
        .prepare(
          'SELECT COUNT(*) AS n FROM environment_grant WHERE credential_id = ? AND environment_id = ?',
        )
        .get(key.id, production),
    ).toEqual({ n: 0 });
  });

  it('is refused a new end that is already past', async () => {
    const world = await setup();
    const { login, key } = world;
    const { id } = await asking(world, login, key.id, { lifetime: DAY });
    expect(await approving(world, id, { expiresAt: 1 })).toMatchObject({ status: 400 });
  });

  it('cannot be approved once an environment it names is removed for good, only rejected', async () => {
    const world = await setup();
    const { w, owner, production, staging, login, key } = world;
    for (const giveBack of [[staging], []]) {
      const target = await world.environment(`app/target-${giveBack.length}`);
      const { id } = await asking(world, login, key.id, {
        add: [{ environmentId: target, read: true }],
        giveBack,
      });
      await ok(w, 'DELETE', `/environments/${target}`, owner);
      expect(
        (await w.api(`/api/v1/environments/${target}/purge`, send('POST', undefined, owner)))
          .status,
      ).toBe(204);
      expect(await call(w, 'GET', `/key-changes/${id}`, owner)).toMatchObject({
        status: 200,
        body: { isMissingEnvironment: true, add: [] },
      });
      expect(
        await call(w, 'POST', `/key-changes/${id}/approve`, owner, {
          grants: [],
          namesKeyWraps: [],
        }),
      ).toMatchObject({ status: 404 });
      expect(await holding(world, key)).toEqual([{ id: staging, canRead: true, canWrite: false }]);
      expect(await call(w, 'POST', `/key-changes/${id}/reject`, owner)).toMatchObject({
        status: 200,
        body: { status: 'rejected' },
      });
    }
    void production;
  });
});
