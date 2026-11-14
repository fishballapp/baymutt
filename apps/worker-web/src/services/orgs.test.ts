/** Orgs: who creates and deletes one, what each caller sees, and that an environment stays in its own. */
import { tokenHash } from '@baymutt/keys/wire';
import { describe, expect, it } from 'vitest';
import { call, newAccount, ok, storeWorld, VAULT_PROOF, VOUCHERS } from '../test-store.ts';
import { keyLike, sealedLike, send } from '../test-support.ts';

describe('an org', () => {
  it('is created by the owner in the dashboard, never by a CLI login or a service account', async () => {
    const world = await storeWorld();
    const { w, owner, locked, pair, environment } = world;
    const login = await pair('laptop', { environments: [] });

    expect(
      await call(w, 'POST', '/orgs', login.headers, { name: 'Fishball Ltd', slug: 'fishball' }),
    ).toMatchObject({ status: 403, body: { code: 'OwnerRequiredError' } });
    expect(
      await call(w, 'POST', '/orgs', owner, { name: 'Fishball Ltd', slug: 'fishball' }),
    ).toMatchObject({
      status: 201,
      body: { name: 'Fishball Ltd', slug: 'fishball', environmentCount: 0 },
    });
    // A locked session changes nothing, an org included.
    expect(
      await call(w, 'POST', '/orgs', locked, { name: 'Locked', slug: 'locked' }),
    ).toMatchObject({ status: 403, body: { code: 'VaultLockedError' } });
    // A slug is unique across baymutt, and has one spelling.
    expect(
      await call(w, 'POST', '/orgs', owner, { name: 'Again', slug: 'fishball' }),
    ).toMatchObject({ status: 409, body: { code: 'AlreadyExistsError' } });
    expect(await call(w, 'POST', '/orgs', owner, { name: 'Bad', slug: 'Fish_Ball' })).toMatchObject(
      { status: 400 },
    );

    const environmentId = await environment('app/production', owner, [login.id]);
    const id = crypto.randomUUID();
    const secret = keyLike('s');
    await ok(
      w,
      'POST',
      '/credentials',
      login.headers,
      {
        id,
        name: 'ci',
        publicKey: keyLike('k'),
        bearerHash: await tokenHash(secret),
        grants: [
          {
            environmentId,
            canWrite: false,
            readWrap: sealedLike('wrap'),
            keyProof: sealedLike('proof'),
          },
        ],
        vouchers: VOUCHERS,
      },
      201,
    );
    const ci = { authorization: `Bearer baymutt_${id}_${secret}` };

    expect(await call(w, 'POST', '/orgs', ci, { name: 'Mine', slug: 'mine' })).toMatchObject({
      status: 403,
      body: { code: 'OwnerRequiredError' },
    });
    // The person's orgs to the owner and a login; to a service account, the orgs it holds an
    // environment in.
    const slugs = async (headers: Record<string, string>) =>
      (await ok<{ orgs: { slug: string }[] }>(w, 'GET', '/orgs', headers)).orgs.map(
        org => org.slug,
      );
    expect(await slugs(owner)).toEqual(['fishball', 'org-user-1']);
    expect(await slugs(login.headers)).toEqual(['fishball', 'org-user-1']);
    expect(await slugs(ci)).toEqual(['org-user-1']);
  });

  it('is deleted only by its owner, and only once it holds no environment, the bin included', async () => {
    const { w, owner, pair, org, environment } = await storeWorld();
    const login = await pair('laptop');
    const orgId = await org('fishball');
    const environmentId = await environment('app/production', owner, [], orgId);

    expect(await call(w, 'DELETE', `/orgs/${orgId}`, login.headers)).toMatchObject({
      status: 403,
      body: { code: 'OwnerRequiredError' },
    });
    expect(await call(w, 'DELETE', `/orgs/${orgId}`, owner)).toMatchObject({
      status: 409,
      body: { code: 'NotEmptyError' },
    });
    await ok(w, 'DELETE', `/environments/${environmentId}`, owner);
    expect(await call(w, 'DELETE', `/orgs/${orgId}`, owner)).toMatchObject({
      status: 409,
      body: { code: 'NotEmptyError' },
    });
    const purged = await w.api(
      `/api/v1/environments/${environmentId}/purge`,
      send('POST', undefined, owner),
    );
    expect(purged.status).toBe(204);
    expect(await call(w, 'DELETE', `/orgs/${orgId}`, owner)).toEqual({
      status: 200,
      body: { deleted: true },
    });

    // Its own entries went with it; the deletion is the person's.
    const { events } = await ok<{ events: { action: string; orgId: string | null }[] }>(
      w,
      'GET',
      '/activity',
      owner,
    );
    expect(events[0]).toMatchObject({ action: 'org.delete', orgId: null });
    expect(events.filter(event => event.orgId === orgId)).toEqual([]);
    expect(w.sqlite.prepare('SELECT COUNT(*) AS n FROM member').get()).toEqual({ n: 1 });
  });
});

describe('another person', () => {
  it('sees none of an org they are not in, and cannot create an environment in it', async () => {
    const one = await storeWorld();
    const environmentId = await one.environment('app/production');
    const other = one.w.user('user-2');
    const otherLocked = one.w.signIn(other.id);
    await ok(
      one.w,
      'POST',
      '/account',
      otherLocked,
      await newAccount(crypto.randomUUID(), other.first.credentialId),
      201,
    );
    const otherOwner = { ...otherLocked, 'x-baymutt-vault-proof': VAULT_PROOF };

    expect(await ok(one.w, 'GET', '/orgs', otherOwner)).toEqual({ orgs: [] });
    expect(await ok(one.w, 'GET', '/environments', otherOwner)).toEqual({ environments: [] });
    expect(await ok(one.w, 'GET', '/bin', otherOwner)).toEqual({ environments: [], secrets: [] });
    expect(
      await call(one.w, 'GET', `/environments/${environmentId}/secrets`, otherOwner),
    ).toMatchObject({ status: 404 });
    expect(
      await call(one.w, 'POST', '/environments', otherOwner, {
        id: crypto.randomUUID(),
        orgId: one.orgId,
        name: 'intruder',
        publicKey: keyLike('p'),
        memberWrap: sealedLike('w'),
        memberProof: sealedLike('p'),
        creatorWrap: null,
        creatorProof: null,
      }),
    ).toMatchObject({ status: 404, body: { code: 'NotFoundError' } });
    expect(await call(one.w, 'DELETE', `/orgs/${one.orgId}`, otherOwner)).toMatchObject({
      status: 404,
    });
    // Activity is the org's members' and the account's own.
    expect(
      (await ok<{ events: unknown[] }>(one.w, 'GET', '/activity', otherOwner)).events,
    ).toMatchObject([{ action: 'account.create' }]);
  });

  it('names environments alike in two orgs without a clash', async () => {
    const { w, owner, org, environment } = await storeWorld();
    const second = await org('second');
    await environment('app/production');
    await environment('app/production', owner, [], second);

    const { environments } = await ok<{ environments: { orgSlug: string; name: string }[] }>(
      w,
      'GET',
      '/environments',
      owner,
    );
    expect(environments.map(({ orgSlug, name }) => `${orgSlug}/${name}`)).toEqual([
      'org-user-1/app/production',
      'second/app/production',
    ]);
  });
});
