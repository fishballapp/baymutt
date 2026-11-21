/** Asks: a CLI login asks the owner for anything at once, in ordered steps the owner decides one by one. */
import { LIMITS } from '@baymutt/api';
import { tokenHash } from '@baymutt/keys/wire';
import * as Effect from 'effect/Effect';
import { describe, expect, it } from 'vitest';
import {
  type Credential,
  call,
  indexOf,
  NAMES_KEY_WRAP,
  newAccount,
  ok,
  type StoreWorld,
  sealedOf,
  storeWorld,
  VAULT_PROOF,
  VOUCHERS,
} from '../test-store.ts';
import { keyLike, sealedLike } from '../test-support.ts';
import { Access } from './access.ts';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

type Item = {
  op: string;
  environmentId: string;
  environmentName: string | null;
  name?: string;
  nextVersion?: number | null;
  keyVersion?: number | null;
  value?: string | null;
};
type Step = {
  type: string;
  index: number;
  status: string;
  note: string | null;
  resolvedAt: number | null;
  waitsFor: number[];
  canOnlyReject: boolean;
  items?: Item[];
  key?: { id: string; expiresAt: number | null; keyVoucher: string | null };
  holds?: { environmentId: string }[];
};
type Ask = { id: string; createdAt: number; cancelledAt: number | null; steps: Step[] };

let keyCount = 0;

/** A key an `access` step asks for, and the header it sends once its step is approved. */
const newKey = async (name: string) => {
  const id = crypto.randomUUID();
  const secret = keyLike(String(++keyCount % 10));
  return {
    payload: {
      id,
      name,
      publicKey: keyLike('k'),
      bearerHash: await tokenHash(secret),
      vouchers: VOUCHERS,
    },
    headers: { authorization: `Bearer baymutt_${id}_${secret}` },
  };
};

const setup = async () => {
  const world = await storeWorld();
  const production = await world.environment('app/production');
  const staging = await world.environment('app/staging');
  const login = await world.pair('laptop');
  const { w, owner, orgId } = world;

  /** What `baymutt ask` sends: an ask of `steps` in the world's org. */
  const send = (
    steps: unknown[],
    {
      by = login,
      id = crypto.randomUUID(),
      inOrg = orgId,
    }: { by?: Credential; id?: string; inOrg?: string } = {},
  ) =>
    call(w, 'POST', '/asks', by.headers, {
      id,
      orgId: inOrg,
      reason: 'set up the preview',
      steps,
    });

  const asked = async (steps: unknown[], options: Parameters<typeof send>[1] = {}) => {
    const answer = await send(steps, options);
    expect(answer).toMatchObject({ status: 201 });
    return answer.body as Ask;
  };

  const read = (id: string, headers: Record<string, string> = owner) =>
    ok<Ask>(w, 'GET', `/asks/${id}`, headers);

  const approve = (id: string, index: number, payload: unknown, headers = owner) =>
    call(w, 'POST', `/asks/${id}/steps/${index}/approve`, headers, payload);

  const reject = (id: string, index: number, payload: unknown = {}, headers = owner) =>
    call(w, 'POST', `/asks/${id}/steps/${index}/reject`, headers, payload);

  /** An `environments` step that creates `name`, with the id it is to have. */
  const creating = (name: string, environmentId = crypto.randomUUID()) => ({
    environmentId,
    step: {
      type: 'environments',
      items: [
        { op: 'create', environmentId, name: indexOf(orgId, name), sealedName: sealedOf(name) },
      ],
    },
  });

  /** The owner's browser making the key pair of each environment a step creates. */
  const keyPairs = (...environmentIds: string[]) => ({
    type: 'environments',
    creates: environmentIds.map(environmentId => ({
      environmentId,
      publicKey: keyLike('p'),
      memberWrap: sealedLike('member-wrap'),
      memberProof: sealedLike('member-proof'),
    })),
  });

  const reading = (type: 'access' | 'change', environmentIds: string[], extra = {}) => ({
    type,
    ...(type === 'access' ? { expiresAt: null } : {}),
    grants: environmentIds.map(environmentId => ({
      environmentId,
      readWrap: sealedLike('read-wrap'),
      keyProof: sealedLike('key-proof'),
      keyVersion: 1,
    })),
    namesKeyWraps: environmentIds.length === 0 ? [] : [{ orgId, wrap: NAMES_KEY_WRAP }],
    ...extra,
  });

  /** The owner's browser sealing each value of a secrets step for the slot the page shows. */
  const sealing = (step: Step) => ({
    type: 'secrets',
    values: (step.items ?? []).flatMap((item, index) =>
      item.nextVersion === undefined || item.nextVersion === null
        ? []
        : [
            {
              item: index,
              version: item.nextVersion,
              keyVersion: item.keyVersion,
              ciphertext: sealedLike(`value-${index}`, 96),
            },
          ],
    ),
  });

  const secrets = async (environmentId: string) =>
    (
      await ok<{
        secrets: { name: string; currentVersion: number | null; latestVersion: number }[];
      }>(w, 'GET', `/environments/${environmentId}/secrets`, owner)
    ).secrets;

  return {
    ...world,
    production,
    staging,
    login,
    send,
    asked,
    read,
    approve,
    reject,
    creating,
    keyPairs,
    reading,
    sealing,
    secrets,
  };
};

const sweep = ({ w }: Pick<StoreWorld, 'w'>) =>
  Effect.runPromise(
    Effect.flatMap(Access, access => access.sweepAsks).pipe(Effect.provide(w.services)),
  );

const actions = ({ w }: Pick<StoreWorld, 'w'>) =>
  (
    w.sqlite
      .prepare('SELECT action, actor, detail FROM activity_event ORDER BY id')
      .all() as Array<{
      action: string;
      actor: string;
      detail: string | null;
    }>
  ).map(({ action, actor, detail }) => ({
    action,
    actor: (JSON.parse(actor) as { kind: string }).kind,
    detail,
  }));

const age = ({ w }: Pick<StoreWorld, 'w'>, askId: string, by: number) =>
  w.sqlite.prepare('UPDATE ask SET created_at = created_at - ? WHERE id = ?').run(by, askId);

describe('asking', () => {
  it('is a CLI login’s, and nothing happens until a step is approved', async () => {
    const world = await setup();
    const { w, owner, production, login, send, asked, read, serviceAccount, pair } = world;
    const key = await newKey('deploy');
    const ask = await asked([
      { type: 'access', key: key.payload, command: null, end: DAY, read: [production] },
    ]);
    expect(ask).toMatchObject({
      reason: 'set up the preview',
      maker: { id: login.id, endorsement: null },
      cancelledAt: null,
      steps: [
        {
          type: 'access',
          index: 0,
          status: 'pending',
          waitsFor: [],
          canOnlyReject: false,
          end: DAY,
          key: { id: key.payload.id, expiresAt: null, keyVoucher: null },
        },
      ],
    });
    expect(ask.createdAt + HOUR).toBe((ask as unknown as { expiresAt: number }).expiresAt);
    // The key is real and holds nothing; it is not listed as a key until approved.
    expect(await call(w, 'GET', '/environments', key.headers)).toEqual({
      status: 200,
      body: { environments: [], namesKeys: [] },
    });
    const listed = await ok<{ credentials: { id: string }[] }>(w, 'GET', '/credentials', owner);
    expect(listed.credentials.map(({ id }) => id)).not.toContain(key.payload.id);
    // The owner sees the maker's voucher; listed for the owner and the maker, not another login.
    expect(await read(ask.id)).toMatchObject({
      steps: [{ key: { keyVoucher: VOUCHERS.keyToOwner } }],
      maker: { endorsement: sealedLike('endorsement') },
    });
    expect(actions(world).at(-1)).toEqual({
      action: 'ask.create',
      actor: 'credential',
      detail: 'set up the preview',
    });
    const other = await pair('desktop');
    const ids = async (headers: Record<string, string>) =>
      (await ok<{ asks: Ask[] }>(w, 'GET', '/asks', headers)).asks.map(({ id }) => id);
    expect(await ids(owner)).toEqual([ask.id]);
    expect(await ids(login.headers)).toEqual([ask.id]);
    expect(await ids(other.headers)).toEqual([]);
    expect(await ids(key.headers)).toEqual([]);
    expect(await call(w, 'GET', `/asks/${ask.id}`, other.headers)).toMatchObject({ status: 404 });
    expect(await call(w, 'GET', `/asks/${ask.id}`, key.headers)).toMatchObject({ status: 404 });

    // The owner and a key never ask.
    const made = await serviceAccount([production]);
    const steps = [
      {
        type: 'access',
        key: (await newKey('x')).payload,
        command: null,
        end: 'never',
        read: [production],
      },
    ];
    for (const headers of [owner, made.headers]) {
      expect(await send(steps, { by: { id: 'x', headers } })).toMatchObject({
        status: 403,
        body: { code: 'OwnerRequiredError' },
      });
    }
  });

  it('is refused what it cannot name', async () => {
    const world = await setup();
    const { production, staging, send, org, environment, creating, w, orgId } = world;
    const elsewhere = await environment('other/production', await org('other'));
    const key = await newKey('k');
    const access = (read: string[]) => ({
      type: 'access',
      key: key.payload,
      command: null,
      end: 'never',
      read,
    });

    // An environment of another org, or none at all.
    expect(await send([access([elsewhere])])).toMatchObject({
      status: 404,
      body: { message: expect.stringContaining('steps[0].read[0]') },
    });
    expect(await send([access([crypto.randomUUID()])])).toMatchObject({ status: 404 });
    // Each environment once per step, and each secret once.
    expect(await send([access([production, production])])).toMatchObject({ status: 400 });
    const set = {
      op: 'set',
      environmentId: staging,
      name: indexOf(staging, 'A'),
      sealedName: sealedOf('A'),
      value: sealedLike('v'),
    };
    expect(
      await send([{ type: 'secrets', items: [set, { ...set, op: 'generate', value: undefined }] }]),
    ).toMatchObject({ status: 400 });
    // A name the org already has, live or in the bin.
    expect(await send([creating('app/production').step])).toMatchObject({
      status: 409,
      body: { code: 'AlreadyExistsError' },
    });
    // Two of one name in a step: one would be made, and the step approved as both.
    const twice = [creating('app/twin').step.items[0], creating('app/twin').step.items[0]];
    expect(await send([{ type: 'environments', items: twice }])).toMatchObject({
      status: 409,
      body: { message: expect.stringContaining('this step already creates') },
    });
    // A step that needs an environment only a later step creates.
    const later = creating('app/preview');
    expect(
      await send([
        { type: 'secrets', items: [{ ...set, environmentId: later.environmentId }] },
        later.step,
      ]),
    ).toMatchObject({ status: 404 });
    // A secret that is not there to delete, and a version that never was.
    expect(
      await send([
        {
          type: 'secrets',
          items: [{ op: 'delete', environmentId: staging, name: indexOf(staging, 'NONE') }],
        },
      ]),
    ).toMatchObject({ status: 404 });
    // More than an ask holds, across its steps.
    const many = (step: number) => ({
      type: 'secrets',
      items: Array.from({ length: 50 }, (_, index) => ({
        op: 'generate',
        environmentId: staging,
        name: indexOf(staging, `S${step}_${index}`),
        sealedName: sealedOf(`S${step}_${index}`),
      })),
    });
    expect(await send([many(0), many(1), many(2), many(3), access([production])])).toMatchObject({
      status: 400,
      body: { message: expect.stringContaining('up to 200') },
    });
    // An org whose names are not sealed.
    const unsealed = await org('old', { isSealed: false });
    expect(await send([access([production])], { inOrg: unsealed })).toMatchObject({
      status: 409,
      body: { code: 'NamesNotSealedError' },
    });
    expect(w.sqlite.prepare('SELECT COUNT(*) AS n FROM ask').get()).toEqual({ n: 0 });
    expect(orgId).toBeDefined();
  });
});

describe('the beta limits', () => {
  it('count each key an access step makes, as a request’s', async () => {
    const world = await setup();
    const { w, production, send, accountId } = world;
    const held = (w.sqlite.prepare('SELECT COUNT(*) AS n FROM credential').get() as { n: number })
      .n;
    const fill = w.sqlite.prepare(
      'INSERT INTO credential (id, account_id, name, public_key, bearer_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const index of Array.from({ length: LIMITS.serviceAccounts - held - 1 }, (_, i) => i)) {
      fill.run(
        crypto.randomUUID(),
        accountId,
        `filler-${index}`,
        keyLike('f'),
        keyLike('h'),
        Date.now(),
      );
    }
    const access = async () => ({
      type: 'access',
      key: (await newKey('k')).payload,
      command: null,
      end: 'never',
      read: [production],
    });
    expect(await send([await access(), await access()])).toMatchObject({
      status: 403,
      body: { code: 'LimitReachedError', limit: LIMITS.serviceAccounts },
    });
    expect(await send([await access()])).toMatchObject({ status: 201 });
  });

  it('hold up to 20 asks waiting in one org', async () => {
    const world = await setup();
    const { staging, send, asked } = world;
    const generate = (name: string) => [
      {
        type: 'secrets',
        items: [
          {
            op: 'generate',
            environmentId: staging,
            name: indexOf(staging, name),
            sealedName: sealedOf(name),
          },
        ],
      },
    ];
    const asks = [];
    for (const index of Array.from({ length: LIMITS.waitingAsksPerOrg }, (_, i) => i)) {
      asks.push(await asked(generate(`S${index}`)));
    }
    expect(await send(generate('ONE_MORE'))).toMatchObject({
      status: 403,
      body: { code: 'LimitReachedError', limit: LIMITS.waitingAsksPerOrg },
    });
    // One that stops waiting makes room.
    const [first] = asks;
    if (first === undefined) throw new Error('no ask was made');
    age(world, first.id, HOUR);
    expect(await send(generate('ONE_MORE'))).toMatchObject({ status: 201 });
  });
});

describe('each step, approved', () => {
  it('creates, deletes and restores environments in one write', async () => {
    const world = await setup();
    const { w, owner, staging, asked, approve, read, creating, keyPairs, orgId } = world;
    await ok(w, 'DELETE', `/environments/${staging}`, owner);
    const preview = creating('app/preview');
    const ask = await asked([
      {
        type: 'environments',
        items: [...preview.step.items, { op: 'restore', environmentId: staging }],
      },
    ]);
    expect(await approve(ask.id, 0, keyPairs(preview.environmentId))).toMatchObject({
      status: 200,
    });
    const listed = await ok<{ environments: { id: string; name: string }[] }>(
      w,
      'GET',
      '/environments',
      owner,
    );
    expect(listed.environments.map(({ id }) => id)).toEqual(
      expect.arrayContaining([preview.environmentId, staging]),
    );
    expect((await read(ask.id)).steps[0]).toMatchObject({ status: 'approved' });
    expect(actions(world).slice(-3)).toEqual([
      { action: 'environment.create', actor: 'owner', detail: null },
      { action: 'environment.restore', actor: 'owner', detail: null },
      { action: 'step.approve', actor: 'owner', detail: 'step 1: environments' },
    ]);
    const removing = await asked([
      { type: 'environments', items: [{ op: 'delete', environmentId: preview.environmentId }] },
    ]);
    expect((await approve(removing.id, 0, keyPairs())).status).toBe(200);
    const bin = await ok<{ environments: { id: string }[] }>(w, 'GET', '/bin', owner);
    expect(bin.environments.map(({ id }) => id)).toContain(preview.environmentId);
    expect(orgId).toBeDefined();
  });

  it('refuses to create an environment whose name the org took meanwhile', async () => {
    const world = await setup();
    const { w, asked, approve, read, creating, keyPairs, environment } = world;
    const preview = creating('app/preview');
    const ask = await asked([preview.step]);
    await environment('app/preview');
    expect(await approve(ask.id, 0, keyPairs(preview.environmentId))).toMatchObject({
      status: 409,
      body: { code: 'AlreadyExistsError' },
    });
    expect((await read(ask.id)).steps[0]).toMatchObject({ status: 'pending' });
    expect(
      w.sqlite
        .prepare('SELECT COUNT(*) AS n FROM environment WHERE id = ?')
        .get(preview.environmentId),
    ).toEqual({ n: 0 });
  });

  it('makes a key that only reads, with the end the owner picks', async () => {
    const world = await setup();
    const { w, owner, production, asked, approve, reading } = world;
    const key = await newKey('deploy');
    const ask = await asked([
      {
        type: 'access',
        key: key.payload,
        command: 'gh secret set X',
        end: DAY,
        read: [production],
      },
    ]);
    const end = Date.now() + 2 * DAY;
    expect(
      await approve(ask.id, 0, reading('access', [production], { expiresAt: end })),
    ).toMatchObject({
      status: 200,
      body: { steps: [{ status: 'approved', key: { expiresAt: end } }] },
    });
    expect(actions(world).slice(-2)).toEqual([
      { action: 'grant.set', actor: 'owner', detail: 'deploy: read' },
      {
        action: 'step.approve',
        actor: 'owner',
        detail: expect.stringMatching(/^step 1: access \(deploy\), until /),
      },
    ]);
    expect(await call(w, 'GET', `/environments/${production}/bundle`, key.headers)).toMatchObject({
      status: 200,
    });
    const listed = await ok<{
      credentials: {
        id: string;
        intent: string;
        description: string;
        grants: { environmentId: string }[];
      }[];
    }>(w, 'GET', '/credentials', owner);
    expect(listed.credentials.find(({ id }) => id === key.payload.id)).toMatchObject({
      intent: 'service-account',
      description: 'set up the preview',
      grants: [{ environmentId: production }],
    });
  });

  it('adds read to a key its login asked for, and gives back at once', async () => {
    const world = await setup();
    const { w, owner, production, staging, login, asked, approve, reading, serviceAccount } = world;
    const agent = await serviceAccount([staging], {
      maker: login,
      name: 'agent',
    });
    const ask = await asked([
      { type: 'change', keyId: agent.id, end: 'keep', read: [production], giveBack: [] },
    ]);
    expect(ask.steps[0]).toMatchObject({
      status: 'pending',
      holds: [{ environmentId: staging }],
    });
    expect((await approve(ask.id, 0, reading('change', [production]))).status).toBe(200);
    expect(await call(w, 'GET', `/environments/${production}/bundle`, agent.headers)).toMatchObject(
      { status: 200 },
    );

    // Giving back alone needs nobody: it is `applied` in the write that makes the ask.
    const back = await asked([
      { type: 'change', keyId: agent.id, end: 'keep', read: [], giveBack: [staging] },
    ]);
    expect(back.steps[0]).toMatchObject({ status: 'applied' });
    expect(await call(w, 'GET', `/environments/${staging}/bundle`, agent.headers)).toMatchObject({
      status: 404,
    });
    expect(actions(world).slice(-2)).toEqual([
      { action: 'grant.remove', actor: 'credential', detail: 'agent' },
      { action: 'ask.create', actor: 'credential', detail: 'set up the preview' },
    ]);
    expect(await ok<{ asks: Ask[] }>(w, 'GET', '/asks', owner)).toEqual({ asks: [] });
  });

  it('writes, deletes, rolls back and restores secrets in one write', async () => {
    const world = await setup();
    const { w, owner, staging, asked, approve, read, sealing, secrets, write, secretName } = world;
    await write(staging, 'OLD', 1);
    await write(staging, 'OLD', 2);
    await write(staging, 'GONE', 1);
    await write(staging, 'BINNED', 1);
    await ok(
      w,
      'DELETE',
      `/environments/${staging}/secrets/${secretName(staging, 'BINNED')}`,
      owner,
    );
    const slot = (name: string) => ({ environmentId: staging, name: secretName(staging, name) });
    const fresh = (name: string) => ({ ...slot(name), sealedName: sealedOf(name) });
    const ask = await asked([
      {
        type: 'secrets',
        items: [
          { op: 'set', ...fresh('API_KEY'), value: sealedLike('proposed') },
          { op: 'paste', ...fresh('STRIPE'), sealedHint: sealedLike('hint') },
          { op: 'generate', ...fresh('OLD') },
          { op: 'delete', ...slot('GONE') },
          { op: 'restore', ...slot('BINNED') },
        ],
      },
      { type: 'secrets', items: [{ op: 'rollback', ...slot('OLD'), version: 1 }] },
    ]);
    const shown = (await read(ask.id)).steps[0] as Step;
    expect(shown.items).toMatchObject([
      { op: 'set', nextVersion: 1, keyVersion: 1, value: sealedLike('proposed') },
      { op: 'paste', nextVersion: 1, sealedHint: sealedLike('hint') },
      { op: 'generate', nextVersion: 3 },
      { op: 'delete' },
      { op: 'restore' },
    ]);
    expect((await approve(ask.id, 0, sealing(shown))).status).toBe(200);
    const after = Object.fromEntries((await secrets(staging)).map(s => [s.name, s.currentVersion]));
    expect(after).toEqual({
      [secretName(staging, 'API_KEY')]: 1,
      [secretName(staging, 'STRIPE')]: 1,
      [secretName(staging, 'OLD')]: 3,
      [secretName(staging, 'GONE')]: null,
      [secretName(staging, 'BINNED')]: 1,
    });
    expect((await approve(ask.id, 1, { type: 'secrets', values: [] })).status).toBe(200);
    expect(
      Object.fromEntries((await secrets(staging)).map(s => [s.name, s.currentVersion])),
    ).toMatchObject({
      [secretName(staging, 'OLD')]: 1,
    });
    expect(
      actions(world)
        .filter(({ action }) => action.startsWith('secret.'))
        .slice(-6),
    ).toEqual([
      { action: 'secret.write', actor: 'owner', detail: null },
      { action: 'secret.write', actor: 'owner', detail: null },
      { action: 'secret.write', actor: 'owner', detail: null },
      { action: 'secret.delete', actor: 'owner', detail: null },
      { action: 'secret.rollback', actor: 'owner', detail: 'from the bin' },
      { action: 'secret.rollback', actor: 'owner', detail: null },
    ]);
  });
});

describe('deciding', () => {
  it('a rejected step does nothing, and its key is revoked', async () => {
    const world = await setup();
    const { w, production, staging, asked, reject, read, secrets, login } = world;
    const key = await newKey('deploy');
    const ask = await asked([
      { type: 'access', key: key.payload, command: null, end: 'never', read: [production] },
      {
        type: 'secrets',
        items: [
          {
            op: 'set',
            environmentId: staging,
            name: indexOf(staging, 'A'),
            sealedName: sealedOf('A'),
            value: sealedLike('v'),
          },
        ],
      },
    ]);
    const note = sealedLike('note', 80);
    expect(await reject(ask.id, 0, { note })).toMatchObject({
      status: 200,
      body: { steps: [{ status: 'rejected', note }, {}] },
    });
    expect(await reject(ask.id, 1)).toMatchObject({ status: 200 });
    expect(await call(w, 'GET', '/me', key.headers)).toMatchObject({ status: 401 });
    expect(await secrets(staging)).toEqual([]);
    expect(
      w.sqlite.prepare('SELECT COUNT(*) AS n FROM ask_item WHERE proposed_value IS NOT NULL').get(),
    ).toEqual({ n: 0 });
    expect((await read(ask.id, login.headers)).steps[0]).toMatchObject({ note });
    // Answered once.
    expect(await reject(ask.id, 0)).toMatchObject({
      status: 410,
      body: { code: 'LinkSpentError' },
    });
    expect(actions(world).at(-1)).toEqual({
      action: 'step.reject',
      actor: 'owner',
      detail: 'step 2: secrets',
    });
  });

  it('a step waits for the earlier step that creates what it names, and can only be rejected once that is', async () => {
    const world = await setup();
    const { asked, approve, reject, read, creating, keyPairs, reading } = world;
    const preview = creating('app/preview');
    const other = creating('app/other');
    const key = await newKey('preview');
    const key2 = await newKey('other');
    const ask = await asked([
      preview.step,
      other.step,
      {
        type: 'access',
        key: key.payload,
        command: null,
        end: 'never',
        read: [preview.environmentId],
      },
      {
        type: 'access',
        key: key2.payload,
        command: null,
        end: 'never',
        read: [other.environmentId],
      },
    ]);
    expect(ask.steps.map(({ waitsFor, canOnlyReject }) => ({ waitsFor, canOnlyReject }))).toEqual([
      { waitsFor: [], canOnlyReject: false },
      { waitsFor: [], canOnlyReject: false },
      { waitsFor: [0], canOnlyReject: false },
      { waitsFor: [1], canOnlyReject: false },
    ]);
    expect(await approve(ask.id, 2, reading('access', [preview.environmentId]))).toMatchObject({
      status: 409,
      body: {
        code: 'StepNotApprovableError',
        message: expect.stringContaining('waits for step 0'),
      },
    });
    expect((await approve(ask.id, 0, keyPairs(preview.environmentId))).status).toBe(200);
    expect((await read(ask.id)).steps[2]).toMatchObject({ waitsFor: [], canOnlyReject: false });
    expect((await approve(ask.id, 2, reading('access', [preview.environmentId]))).status).toBe(200);

    expect((await reject(ask.id, 1)).status).toBe(200);
    expect((await read(ask.id)).steps[3]).toMatchObject({ waitsFor: [], canOnlyReject: true });
    expect(await approve(ask.id, 3, reading('access', [other.environmentId]))).toMatchObject({
      status: 409,
      body: {
        code: 'StepNotApprovableError',
        message: expect.stringContaining('only be rejected'),
      },
    });
    expect((await reject(ask.id, 3)).status).toBe(200);
  });

  it('a step does not wait on a secret’s restore for an environment that has gone', async () => {
    const world = await setup();
    const { w, owner, staging, asked, read, write, secretName } = world;
    await write(staging, 'BINNED', 1);
    await ok(
      w,
      'DELETE',
      `/environments/${staging}/secrets/${secretName(staging, 'BINNED')}`,
      owner,
    );
    const ask = await asked([
      {
        type: 'secrets',
        items: [{ op: 'restore', environmentId: staging, name: secretName(staging, 'BINNED') }],
      },
      {
        type: 'access',
        key: (await newKey('k')).payload,
        command: null,
        end: 'never',
        read: [staging],
      },
    ]);
    await ok(w, 'DELETE', `/environments/${staging}`, owner);
    expect(
      (await read(ask.id)).steps.map(({ waitsFor, canOnlyReject }) => ({
        waitsFor,
        canOnlyReject,
      })),
    ).toEqual([
      { waitsFor: [], canOnlyReject: true },
      { waitsFor: [], canOnlyReject: true },
    ]);
  });

  it('a rejected access step does not hold up a secrets step', async () => {
    const world = await setup();
    const { production, asked, approve, reject, read, sealing, secrets } = world;
    const key = await newKey('k');
    const ask = await asked([
      { type: 'access', key: key.payload, command: null, end: 'never', read: [production] },
      {
        type: 'secrets',
        items: [
          {
            op: 'generate',
            environmentId: production,
            name: indexOf(production, 'T'),
            sealedName: sealedOf('T'),
          },
        ],
      },
    ]);
    expect((await reject(ask.id, 0)).status).toBe(200);
    const step = (await read(ask.id)).steps[1] as Step;
    expect(step).toMatchObject({ waitsFor: [], canOnlyReject: false });
    expect((await approve(ask.id, 1, sealing(step))).status).toBe(200);
    expect(await secrets(production)).toHaveLength(1);
  });

  it('revoking a key rejects a change waiting on it, and one change waits per key', async () => {
    const world = await setup();
    const { w, owner, production, staging, login, asked, send, read, serviceAccount } = world;
    const agent = await serviceAccount([staging], {
      maker: login,
      name: 'agent',
    });
    const change = {
      type: 'change',
      keyId: agent.id,
      end: 'keep',
      read: [production],
      giveBack: [],
    };
    const ask = await asked([change]);
    expect(await send([change])).toMatchObject({
      status: 409,
      body: { code: 'AlreadyExistsError', message: expect.stringContaining(ask.id) },
    });
    await ok(w, 'DELETE', `/credentials/${agent.id}`, owner);
    expect((await read(ask.id)).steps[0]).toMatchObject({ status: 'rejected' });
  });
});

describe('a CLI login that is gone', () => {
  const twoSteps = async ({ staging, production }: { staging: string; production: string }) => [
    {
      type: 'access',
      key: (await newKey('k')).payload,
      command: null,
      end: 'never',
      read: [production],
    },
    {
      type: 'secrets',
      items: [
        {
          op: 'set',
          environmentId: staging,
          name: indexOf(staging, 'A'),
          sealedName: sealedOf('A'),
          value: sealedLike('v'),
        },
      ],
    },
  ];
  const pendingValues = ({ w }: Pick<StoreWorld, 'w'>) =>
    w.sqlite.prepare('SELECT COUNT(*) AS n FROM ask_item WHERE proposed_value IS NOT NULL').get();

  it('revoked, rejects every step still waiting in its asks, in the same write', async () => {
    const world = await setup();
    const { w, owner, login, asked, read, approve, sealing } = world;
    const ask = await asked(await twoSteps(world));
    await ok(w, 'DELETE', `/credentials/${login.id}`, owner);
    expect((await read(ask.id)).steps.map(({ status }) => status)).toEqual([
      'rejected',
      'rejected',
    ]);
    expect(pendingValues(world)).toEqual({ n: 0 });
    const step = (await read(ask.id)).steps[1] as Step;
    expect(await approve(ask.id, 1, sealing(step))).toMatchObject({ status: 410 });
  });

  it('ended, has its asks’ steps rejected by the daily run', async () => {
    const world = await setup();
    const { w, login, asked, read } = world;
    const ask = await asked(await twoSteps(world));
    w.sqlite
      .prepare('UPDATE credential SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, login.id);
    expect(await sweep(world)).toEqual({ expired: 0, rejected: 1, removed: 0 });
    expect((await read(ask.id)).steps.map(({ status }) => status)).toEqual([
      'rejected',
      'rejected',
    ]);
    expect(pendingValues(world)).toEqual({ n: 0 });
    expect(actions(world).slice(-2)).toEqual([
      { action: 'step.reject', actor: 'system', detail: 'step 1: access (k)' },
      { action: 'step.reject', actor: 'system', detail: 'step 2: secrets' },
    ]);
  });
});

describe('the owner’s answer', () => {
  it('is the owner’s alone, with the vault open', async () => {
    const world = await setup();
    const { w, production, login, locked, asked, approve, reject, reading, serviceAccount, pair } =
      world;
    const key = await newKey('k');
    const ask = await asked([
      { type: 'access', key: key.payload, command: null, end: 'never', read: [production] },
    ]);
    const made = await serviceAccount([production]);
    const other = await pair('desktop');
    for (const headers of [login.headers, made.headers]) {
      expect(await approve(ask.id, 0, reading('access', [production]), headers)).toMatchObject({
        status: 403,
        body: { code: 'OwnerRequiredError' },
      });
      expect(await reject(ask.id, 0, {}, headers)).toMatchObject({ status: 403 });
    }
    expect(await reject(ask.id, 0, {}, other.headers)).toMatchObject({ status: 403 });
    expect(await approve(ask.id, 0, reading('access', [production]), locked)).toMatchObject({
      status: 403,
      body: { code: 'VaultLockedError' },
    });
    expect(await approve(ask.id, 5, reading('access', [production]))).toMatchObject({
      status: 404,
    });
    // Another account's owner does not reach it.
    const stranger = w.user('user-2');
    const strangerLocked = w.signIn(stranger.id);
    await ok(
      w,
      'POST',
      '/account',
      strangerLocked,
      await newAccount(crypto.randomUUID(), stranger.first.credentialId),
      201,
    );
    const strangerOwner = { ...strangerLocked, 'x-baymutt-vault-proof': VAULT_PROOF };
    expect(await reject(ask.id, 0, {}, strangerOwner)).toMatchObject({ status: 404 });
    expect(await call(w, 'GET', `/asks/${ask.id}`, strangerOwner)).toMatchObject({ status: 404 });
    expect(w.sqlite.prepare('SELECT status FROM ask_step WHERE ask_id = ?').all(ask.id)).toEqual([
      { status: 'pending' },
    ]);
  });

  it('must match the step', async () => {
    const world = await setup();
    const { production, staging, asked, approve, reading } = world;
    const key = await newKey('k');
    const ask = await asked([
      { type: 'access', key: key.payload, command: null, end: 'never', read: [production] },
    ]);
    expect(await approve(ask.id, 0, reading('access', [staging]))).toMatchObject({ status: 400 });
    expect(await approve(ask.id, 0, reading('change', [production]))).toMatchObject({
      status: 400,
    });
    expect(
      await approve(ask.id, 0, reading('access', [production], { expiresAt: 1 })),
    ).toMatchObject({ status: 400 });
  });

  it('happens whole: a value written since leaves none of the step’s written', async () => {
    const world = await setup();
    const { w, staging, asked, approve, read, sealing, secrets, write } = world;
    await write(staging, 'B', 1);
    const fresh = (name: string) => ({
      op: 'generate',
      environmentId: staging,
      name: indexOf(staging, name),
      sealedName: sealedOf(name),
    });
    const ask = await asked([{ type: 'secrets', items: [fresh('A'), fresh('B'), fresh('C')] }]);
    const shown = (await read(ask.id)).steps[0] as Step;
    // Written after the page read it: its slot moved on.
    await write(staging, 'B', 2);
    expect(await approve(ask.id, 0, sealing(shown))).toMatchObject({
      status: 409,
      body: { code: 'VersionConflictError', latestVersion: 2 },
    });
    expect((await secrets(staging)).map(({ name }) => name)).toEqual([indexOf(staging, 'B')]);

    // And a write that lands between the read and the batch: the batch's own check refuses it.
    const again = (await read(ask.id)).steps[0] as Step;
    w.beforeStatement(/UPDATE ask_step\s+SET status = 'approved'/, () => {
      w.sqlite
        .prepare('UPDATE secret SET latest_version = latest_version + 1 WHERE name = ?')
        .run(indexOf(staging, 'B'));
    });
    expect(await approve(ask.id, 0, sealing(again))).toMatchObject({ status: 409 });
    expect((await secrets(staging)).map(({ name }) => name)).toEqual([indexOf(staging, 'B')]);
    expect((await read(ask.id)).steps[0]).toMatchObject({ status: 'pending' });
  });

  it('answers a step once, whatever reaches it first', async () => {
    const world = await setup();
    const { w, staging, asked, approve, read, sealing, secrets } = world;
    const ask = await asked([
      {
        type: 'secrets',
        items: [
          {
            op: 'generate',
            environmentId: staging,
            name: indexOf(staging, 'A'),
            sealedName: sealedOf('A'),
          },
        ],
      },
    ]);
    const shown = (await read(ask.id)).steps[0] as Step;
    // A rejection lands between this approval's read and its write.
    w.beforeStatement(/UPDATE ask_step\s+SET status = 'approved'/, () => {
      w.sqlite.prepare("UPDATE ask_step SET status = 'rejected', resolved_at = 1").run();
    });
    expect(await approve(ask.id, 0, sealing(shown))).toMatchObject({ status: 410 });
    expect(await secrets(staging)).toEqual([]);
  });
});

describe('what it shows', () => {
  it('a proposed value to the owner while pending, and a note to the owner and its maker', async () => {
    const world = await setup();
    const { w, staging, asked, approve, read, sealing, login } = world;
    const ask = await asked([
      {
        type: 'secrets',
        items: [
          {
            op: 'set',
            environmentId: staging,
            name: indexOf(staging, 'A'),
            sealedName: sealedOf('A'),
            value: sealedLike('proposed'),
          },
        ],
      },
    ]);
    expect(((await read(ask.id)).steps[0] as Step).items?.[0]).toMatchObject({
      value: sealedLike('proposed'),
    });
    expect(((await read(ask.id, login.headers)).steps[0] as Step).items?.[0]).toMatchObject({
      value: null,
    });
    const note = sealedLike('use the test key', 80);
    const shown = (await read(ask.id)).steps[0] as Step;
    expect((await approve(ask.id, 0, { ...sealing(shown), note })).status).toBe(200);
    expect((await read(ask.id)).steps[0] as Step).toMatchObject({
      note,
      items: [{ value: null }],
    });
    expect((await read(ask.id, login.headers)).steps[0]).toMatchObject({ note });
    expect(w.sqlite.prepare('SELECT proposed_value FROM ask_item').all()).toEqual([
      { proposed_value: null },
    ]);
    const logged = JSON.stringify(w.sqlite.prepare('SELECT * FROM activity_event').all());
    expect(logged).not.toContain(note);
    expect(logged).not.toContain(sealedLike('proposed'));
  });

  it('a sealed hint, as it was given, to the owner while pending, and never plain text', async () => {
    const world = await setup();
    const { w, staging, asked, send, reject, read, login } = world;
    const paste = {
      op: 'paste',
      environmentId: staging,
      name: indexOf(staging, 'STRIPE'),
      sealedName: sealedOf('STRIPE'),
    };
    // A hint is a sealed box: words, or one past its bound, are refused.
    for (const item of [
      { ...paste, sealedHint: 'Stripe dashboard, Developers, API keys' },
      { ...paste, sealedHint: sealedLike('h', 2081) },
    ]) {
      expect(await send([{ type: 'secrets', items: [item] }])).toMatchObject({ status: 400 });
    }
    // A plain `hint` is no field of the API: it is dropped, never stored.
    const words = await asked([
      { type: 'secrets', items: [{ ...paste, hint: 'sk_live_planted' }] },
    ]);
    expect(JSON.stringify(await read(words.id))).not.toContain('sk_live_planted');
    expect(JSON.stringify(w.sqlite.prepare('SELECT * FROM ask_item').all())).not.toContain(
      'sk_live_planted',
    );
    const hintsOf = (id: string) =>
      w.sqlite
        .prepare('SELECT sealed_hint FROM ask_item WHERE ask_id = ? ORDER BY position')
        .all(id);
    const hint = sealedLike('hint', 2080);
    const ask = await asked([
      {
        type: 'secrets',
        items: [
          { ...paste, sealedHint: hint },
          { ...paste, name: indexOf(staging, 'BARE'), sealedName: sealedOf('BARE') },
        ],
      },
    ]);
    expect(hintsOf(ask.id)).toEqual([{ sealed_hint: hint }, { sealed_hint: null }]);
    expect(((await read(ask.id)).steps[0] as Step).items).toMatchObject([
      { sealedHint: hint },
      { sealedHint: null },
    ]);
    expect(((await read(ask.id, login.headers)).steps[0] as Step).items?.[0]).toMatchObject({
      sealedHint: null,
    });
    expect((await reject(ask.id, 0)).status).toBe(200);
    expect(((await read(ask.id)).steps[0] as Step).items?.[0]).toMatchObject({ sealedHint: null });
    expect(hintsOf(ask.id)).toEqual([{ sealed_hint: null }, { sealed_hint: null }]);
  });
});

describe('withdrawing', () => {
  it('is its maker’s: every step still pending is cancelled and its key revoked', async () => {
    const world = await setup();
    const { w, owner, production, staging, login, asked, reject, read, pair } = world;
    const key = await newKey('k');
    const ask = await asked([
      { type: 'access', key: key.payload, command: null, end: 'never', read: [production] },
      {
        type: 'secrets',
        items: [
          {
            op: 'set',
            environmentId: staging,
            name: indexOf(staging, 'A'),
            sealedName: sealedOf('A'),
            value: sealedLike('v'),
          },
        ],
      },
    ]);
    expect((await reject(ask.id, 1)).status).toBe(200);
    const other = await pair('desktop');
    expect(await call(w, 'DELETE', `/asks/${ask.id}`, other.headers)).toMatchObject({
      status: 404,
    });
    expect(await call(w, 'DELETE', `/asks/${ask.id}`, owner)).toMatchObject({ status: 403 });
    const cancelled = await call(w, 'DELETE', `/asks/${ask.id}`, login.headers);
    expect(cancelled).toMatchObject({
      status: 200,
      body: {
        cancelledAt: expect.any(Number),
        steps: [{ status: 'cancelled' }, { status: 'rejected' }],
      },
    });
    expect(await call(w, 'GET', '/me', key.headers)).toMatchObject({ status: 401 });
    expect(await call(w, 'DELETE', `/asks/${ask.id}`, login.headers)).toMatchObject({
      status: 410,
    });
    expect((await read(ask.id)).steps[0]).toMatchObject({ status: 'cancelled' });
    expect(actions(world).at(-1)).toMatchObject({ action: 'ask.cancel', actor: 'credential' });
  });
});

describe('an hour on', () => {
  it('a step nobody answered has expired, and the daily run writes it down and tidies up', async () => {
    const world = await setup();
    const { w, owner, production, staging, asked, approve, reading, read, login } = world;
    const key = await newKey('k');
    const ask = await asked([
      { type: 'access', key: key.payload, command: null, end: 'never', read: [production] },
      {
        type: 'secrets',
        items: [
          {
            op: 'set',
            environmentId: staging,
            name: indexOf(staging, 'A'),
            sealedName: sealedOf('A'),
            value: sealedLike('v'),
          },
        ],
      },
    ]);
    age(world, ask.id, HOUR);
    const { createdAt } = await read(ask.id);
    expect((await read(ask.id, login.headers)).steps[0]).toMatchObject({
      status: 'expired',
      resolvedAt: createdAt + HOUR,
    });
    expect(((await read(ask.id)).steps[1] as Step).items?.[0]).toMatchObject({ value: null });
    expect(await ok(w, 'GET', '/asks', owner)).toEqual({ asks: [] });
    expect(await approve(ask.id, 0, reading('access', [production]))).toMatchObject({
      status: 410,
    });
    expect(await call(w, 'DELETE', `/asks/${ask.id}`, login.headers)).toMatchObject({
      status: 410,
    });

    expect(await sweep(world)).toEqual({ expired: 1, rejected: 0, removed: 0 });
    expect(w.sqlite.prepare('SELECT status FROM ask_step ORDER BY position').all()).toEqual([
      { status: 'expired' },
      { status: 'expired' },
    ]);
    expect(
      w.sqlite.prepare('SELECT COUNT(*) AS n FROM ask_item WHERE proposed_value IS NOT NULL').get(),
    ).toEqual({ n: 0 });
    expect(await call(w, 'GET', '/me', key.headers)).toMatchObject({ status: 401 });
    expect(actions(world).slice(-2)).toEqual([
      { action: 'step.expire', actor: 'system', detail: 'step 1: access (k)' },
      { action: 'step.expire', actor: 'system', detail: 'step 2: secrets' },
    ]);

    // A week after its last step closed, the ask goes.
    w.sqlite.prepare('UPDATE ask_step SET resolved_at = resolved_at - ?').run(8 * DAY);
    expect(await sweep(world)).toEqual({ expired: 0, rejected: 0, removed: 1 });
    expect(await call(w, 'GET', `/asks/${ask.id}`, owner)).toMatchObject({ status: 404 });
  });

  it('an approved key is revoked by the daily run once it has ended, ask or not', async () => {
    const world = await setup();
    const { w, production, asked, approve, reading } = world;
    const key = await newKey('k');
    const ask = await asked([
      { type: 'access', key: key.payload, command: null, end: HOUR, read: [production] },
    ]);
    expect(
      (await approve(ask.id, 0, reading('access', [production], { expiresAt: Date.now() + HOUR })))
        .status,
    ).toBe(200);
    w.sqlite.prepare('DELETE FROM ask').run();
    w.sqlite
      .prepare('UPDATE credential SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, key.payload.id);
    await Effect.runPromise(
      Effect.flatMap(Access, access => access.sweepEndedKeys).pipe(Effect.provide(w.services)),
    );
    expect(
      w.sqlite
        .prepare('SELECT revoked_at IS NOT NULL AS revoked FROM credential WHERE id = ?')
        .get(key.payload.id),
    ).toEqual({ revoked: 1 });
  });
});
