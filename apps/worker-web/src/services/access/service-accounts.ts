// Credentials: recognising one by its bearer, approving a CLI login, changing a service account's
// access, revoking.
import {
  type ActorIdentity,
  AlreadyExistsError,
  type CredentialActor,
  InvalidRequestError,
  type Me,
  NotFoundError,
  type OrgNamesKeyWrap,
  OwnerRequiredError,
  REQUEST_WAIT_MS,
  type ServiceAccount,
  type ServiceAccountVouchers,
  type SetAccessPayload,
  UnauthorizedError,
} from '@baymutt/api';
import { parseBearer } from '@baymutt/keys/wire';
import type * as D1Client from '@effect/sql-d1/D1Client';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import type * as Statement from 'effect/sql/Statement';
import { actorOf } from '../actors.ts';
import type { Audit } from '../audit.ts';
import {
  addressOf,
  grantStatement,
  type Lookups,
  orgsOf,
  type ServiceAccountRow,
  ServiceAccountRowSchema,
} from './rows.ts';

const LAST_USED_RESOLUTION_MS = 60_000;

export type NewServiceAccount = {
  readonly id: string;
  readonly name: string;
  readonly publicKey: string;
  readonly bearerHash: string;
  readonly description?: string | undefined;
  readonly expiresAt?: number | undefined;
};

/** The day a time falls on, in UTC, for a message or the log: `2026-12-01`. */
// biome-ignore lint/plugin/no-date: this Worker has no Temporal (the runtime gains one at compatibility date 2026-12-01), and one day string is not worth bundling the polyfill.
export const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/** Not a secret comparison (both are hashes of 256 random bits), but equal time costs nothing. */
const isSameHash = (one: string, other: string): boolean =>
  one.length === other.length &&
  Array.from(one).reduce(
    (difference, character, index) =>
      difference | (character.charCodeAt(0) ^ other.charCodeAt(index)),
    0,
  ) === 0;

/** A new credential's row; `RETURNING id` says whether this request's insert took. */
export const insertCredential = (
  sql: D1Client.D1Client,
  {
    accountId,
    credential,
    now,
    parentId = null,
    endorsement = null,
    welcome = null,
    vouchers,
    intent = null,
  }: {
    readonly accountId: string;
    readonly credential: NewServiceAccount;
    readonly now: number;
    readonly parentId?: string | null;
    readonly endorsement?: string | null;
    readonly welcome?: string | null;
    readonly vouchers?: ServiceAccountVouchers;
    /** What a key from a request is for; a CLI login has none. */
    readonly intent?: 'service-account' | 'agent' | null;
  },
) =>
  sql`INSERT OR IGNORE INTO credential
      (id, account_id, name, public_key, bearer_hash, parent_id, description, endorsement,
       welcome, key_voucher_owner, key_voucher_maker, account_voucher, created_at, expires_at,
       intent)
    VALUES (${credential.id}, ${accountId}, ${credential.name}, ${credential.publicKey},
      ${credential.bearerHash}, ${parentId}, ${credential.description ?? null},
      ${endorsement}, ${welcome}, ${vouchers?.keyToOwner ?? null},
      ${vouchers?.keyToMaker ?? null}, ${vouchers?.accountKey ?? null}, ${now},
      ${credential.expiresAt ?? null}, ${intent})
    RETURNING id`;

/** Whether this request's insert is the row: an id that was taken leaves another's bearer there. */
export const madeBy = (sql: D1Client.D1Client, credential: NewServiceAccount, now: number) =>
  sql`EXISTS (SELECT 1 FROM credential
              WHERE id = ${credential.id} AND created_at = ${now}
                AND bearer_hash = ${credential.bearerHash})`;

export const credentialTaken = () =>
  new AlreadyExistsError({
    message: 'A CLI login or key with this id exists. Make a new key and try again.',
  });

/**
 * Revoking the credentials `ids` selects: their bearers stop working, their grants and names key
 * copies go, a request still waiting for one of them is closed as `request`, and a key change
 * still waiting for one is rejected. The first
 * statement answers the ids it revoked. `onlyIf` conditions all of it inside a batch.
 */
export const revokeStatements = (
  sql: D1Client.D1Client,
  {
    ids,
    now,
    request = 'rejected',
    onlyIf = sql`1 = 1`,
  }: {
    readonly ids: Statement.Fragment;
    readonly now: number;
    readonly request?: 'rejected' | 'expired';
    readonly onlyIf?: Statement.Fragment;
  },
) =>
  [
    sql`UPDATE credential SET revoked_at = ${now}, bearer_hash = ''
      WHERE id IN (${ids}) AND revoked_at IS NULL AND ${onlyIf} RETURNING id`,
    sql`DELETE FROM environment_grant WHERE credential_id IN (${ids}) AND ${onlyIf}`,
    sql`DELETE FROM names_key_wrap WHERE reader_id IN (${ids}) AND ${onlyIf}`,
    // A request past its hour had already expired, whatever closes it now.
    sql`UPDATE access_request
      SET status = CASE WHEN created_at > ${now - REQUEST_WAIT_MS} THEN ${request} ELSE 'expired' END,
        resolved_at = ${now}
      WHERE credential_id IN (${ids}) AND status = 'pending' AND ${onlyIf}`,
    // A change still waiting for a revoked key has nothing left to change.
    sql`UPDATE key_change
      SET status = CASE WHEN created_at > ${now - REQUEST_WAIT_MS} THEN 'rejected' ELSE 'expired' END,
        resolved_at = ${now}
      WHERE credential_id IN (${ids}) AND status = 'pending' AND ${onlyIf}`,
  ] as const;

export const serviceAccounts = ({
  sql,
  audit,
  lookups: {
    approvedServiceAccountIn,
    environmentsOf,
    ownersEnvironment,
    serviceAccountIn,
    underLimit,
  },
}: {
  readonly sql: D1Client.D1Client;
  readonly audit: Audit['Service'];
  readonly lookups: Lookups;
}) => {
  const byBearer = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      ...ServiceAccountRowSchema.fields,
      bearerHash: Schema.String,
      parentExpiresAt: Schema.NullOr(Schema.Finite),
    }),
    // A revoked parent revokes its children with it; an expired one stops them too.
    execute: id =>
      sql`SELECT c.id, c.account_id, c.name, c.public_key, c.bearer_hash, c.parent_id,
            c.description, c.endorsement, c.welcome, c.key_voucher_owner, c.key_voucher_maker,
            c.account_voucher, c.created_at, c.last_used_at, c.expires_at, c.intent,
            p.expires_at AS parent_expires_at
          FROM credential c LEFT JOIN credential p ON p.id = c.parent_id
          WHERE c.id = ${id} AND c.revoked_at IS NULL`,
  });

  const visible = SqlSchema.findAll({
    Request: Schema.Struct({ accountId: Schema.String, self: Schema.NullOr(Schema.String) }),
    Result: ServiceAccountRowSchema,
    execute: ({ accountId, self }) =>
      sql`SELECT id, account_id, name, public_key, parent_id, description, endorsement, welcome,
            key_voucher_owner, key_voucher_maker, account_voucher, created_at, last_used_at,
            expires_at, intent
          FROM credential
          WHERE account_id = ${accountId} AND revoked_at IS NULL
            AND (${self} IS NULL OR id = ${self} OR parent_id = ${self})
            AND NOT EXISTS (SELECT 1 FROM access_request r
                            WHERE r.credential_id = credential.id AND r.status = 'pending')
          ORDER BY created_at`,
  });

  const grantsOf = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      credentialId: Schema.String,
      environmentId: Schema.String,
      orgId: Schema.String,
      orgSlug: Schema.String,
      environmentName: Schema.String,
      environmentSealedName: Schema.NullOr(Schema.String),
      canWrite: Schema.Finite,
      canRead: Schema.Finite,
    }),
    execute: accountId =>
      sql`SELECT g.credential_id, g.environment_id, e.org_id, o.slug AS org_slug,
            e.name AS environment_name, e.sealed_name AS environment_sealed_name, g.can_write,
            g.read_wrap IS NOT NULL AS can_read
          FROM environment_grant g
          JOIN credential c ON c.id = g.credential_id
          JOIN environment e ON e.id = g.environment_id
          JOIN organization o ON o.id = e.org_id
          WHERE c.account_id = ${accountId} AND e.deleted_at IS NULL
            AND e.org_id IN (${orgsOf(sql, accountId)})
          ORDER BY o.slug, e.name`,
  });

  const sealedOrgsOf = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ orgId: Schema.String }),
    execute: accountId =>
      sql`SELECT DISTINCT n.org_id FROM names_key_wrap n
          WHERE n.org_id IN (${orgsOf(sql, accountId)})`,
  });

  const accountOf = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ name: Schema.String, publicKey: Schema.String }),
    execute: accountId => sql`SELECT name, public_key FROM store_account WHERE id = ${accountId}`,
  });

  /** Each copy is sealed to one reader: the owner's to the account key, the maker's to itself. */
  const keyVoucherFor = (actor: ActorIdentity, row: ServiceAccountRow): string | null => {
    if (actor._tag === 'Owner') return row.keyVoucherOwner;
    return row.parentId === actor.credentialId ? row.keyVoucherMaker : null;
  };

  const list = Effect.fn('Access.listServiceAccounts')(function* (actor: ActorIdentity) {
    const [rows, grants] = yield* Effect.all(
      [
        visible({
          accountId: actor.accountId,
          self: actor._tag === 'Credential' ? actor.credentialId : null,
        }),
        grantsOf(actor.accountId),
      ],
      { concurrency: 2 },
    ).pipe(Effect.orDie);
    return rows.map(
      (row): ServiceAccount => ({
        id: row.id,
        name: row.name,
        publicKey: row.publicKey,
        parentId: row.parentId,
        description: row.description,
        expiresAt: row.expiresAt,
        intent: row.intent,
        // Only the owner's vault can read an endorsement, and only the owner acts on one.
        endorsement: actor._tag === 'Owner' ? row.endorsement : null,
        keyVoucher: keyVoucherFor(actor, row),
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        grants: grants
          .filter(grant => grant.credentialId === row.id)
          .map(({ credentialId: _, canRead, canWrite, ...grant }) => ({
            ...grant,
            canRead: canRead !== 0,
            canWrite: canWrite !== 0,
          })),
      }),
    );
  });

  const one = Effect.fnUntraced(function* (actor: ActorIdentity, id: string) {
    const found = (yield* list(actor)).find(serviceAccount => serviceAccount.id === id);
    if (found === undefined) {
      return yield* Effect.die(`service account ${id} vanished after its write`);
    }
    return found;
  });

  /**
   * A service account whose access the owner may change. A CLI login holds no environment, so its
   * access never changes; a request's key gets what the owner approved, and later only the owner
   * changes it.
   */
  const changeable = Effect.fnUntraced(function* (actor: ActorIdentity, id: string) {
    if (actor._tag !== 'Owner') {
      return yield* new OwnerRequiredError({
        message:
          'Only the owner changes a key’s access, from the dashboard. The CLI login that asked for it asks to change it: `baymutt ask change`.',
      });
    }
    const target = yield* approvedServiceAccountIn(actor.accountId, id);
    if (target.parentId === null) {
      return yield* new InvalidRequestError({
        message:
          'A CLI login holds no environment, so its access does not change. Revoke it to end it.',
      });
    }
    return target;
  });

  return {
    authenticate: Effect.fn('Access.authenticate')(function* (bearer: Redacted.Redacted<string>) {
      const refused = new UnauthorizedError({
        message:
          'This key is not approved, or was revoked. Log in with `baymutt auth login`, after `baymutt auth logout` if this computer was logged in before, or check BAYMUTT_KEY.',
      });
      const parsed = yield* Effect.promise(() => parseBearer(Redacted.value(bearer)));
      if (parsed === null) return yield* refused;
      const found = yield* byBearer(parsed.credentialId).pipe(Effect.orDie);
      if (Option.isNone(found) || !isSameHash(found.value.bearerHash, parsed.bearerHash)) {
        return yield* refused;
      }
      const { id, accountId, name, parentId, expiresAt, parentExpiresAt } = found.value;
      const now = yield* Clock.currentTimeMillis;
      if (expiresAt !== null && expiresAt <= now) {
        return yield* new UnauthorizedError({
          message: `This key expired on ${dayOf(expiresAt)}. The owner can extend it under Keys in the dashboard; otherwise make a new one.`,
        });
      }
      if (parentExpiresAt !== null && parentExpiresAt <= now) {
        return yield* new UnauthorizedError({
          message: `The CLI login that asked for this key expired on ${dayOf(parentExpiresAt)}, so this one stopped with it. The owner can extend that login in the dashboard.`,
        });
      }
      // Coarse on purpose: one write a minute per service account, not one a request.
      yield* sql`UPDATE credential SET last_used_at = ${now}
          WHERE id = ${id}
            AND (last_used_at IS NULL OR last_used_at < ${now - LAST_USED_RESOLUTION_MS})`.pipe(
        Effect.ignoreCause({ log: true, message: 'could not stamp a credential’s last use' }),
      );
      return {
        _tag: 'Credential',
        accountId,
        credentialId: id,
        name,
        parentId,
      } satisfies CredentialActor;
    }),

    me: Effect.fn('Access.me')(function* (actor: ActorIdentity) {
      const account = yield* accountOf(actor.accountId);
      const base = {
        accountId: actor.accountId,
        accountName: account.name,
        accountPublicKey: account.publicKey,
      };
      if (actor._tag === 'Owner') return { ...base, credential: null } satisfies Me;
      const { id, name, parentId, welcome, accountVoucher } = yield* serviceAccountIn(
        actor.accountId,
        actor.credentialId,
      );
      return {
        ...base,
        credential: { id, name, parentId, welcome, accountVoucher },
      } satisfies Me;
    }, Effect.orDie),

    listServiceAccounts: list,

    pair: Effect.fn('Access.pair')(function* ({
      actor,
      serviceAccount,
      endorsement,
      welcome,
      namesKeyWraps,
    }: {
      readonly actor: ActorIdentity;
      readonly serviceAccount: NewServiceAccount;
      readonly endorsement: string;
      readonly welcome: string;
      /** The names key of every org of the person whose names are sealed, and of no other. */
      readonly namesKeyWraps: ReadonlyArray<OrgNamesKeyWrap>;
    }) {
      if (actor._tag !== 'Owner') {
        return yield* new OwnerRequiredError({
          message:
            'Only the owner approves a CLI login, from the link `baymutt auth login` prints. A CLI login asks for access with `baymutt ask access`.',
        });
      }
      const sealed = new Set(
        (yield* sealedOrgsOf(actor.accountId).pipe(Effect.orDie)).map(({ orgId }) => orgId),
      );
      const named = new Set(namesKeyWraps.map(({ orgId }) => orgId));
      if (named.size !== namesKeyWraps.length || !named.isSubsetOf(sealed)) {
        return yield* new InvalidRequestError({
          message:
            'A CLI login is approved for each org of yours whose names are sealed, once, and for no other org.',
        });
      }
      if (!sealed.isSubsetOf(named)) {
        return yield* new InvalidRequestError({
          message: `A CLI login is approved for every org of yours whose names are sealed; ${sealed.difference(named).size} missing. Open the dashboard again and approve once more.`,
        });
      }
      yield* underLimit(actor.accountId, 'serviceAccounts');
      const now = yield* Clock.currentTimeMillis;
      const made = madeBy(sql, serviceAccount, now);
      // One batch: approved with its names keys, or neither. It holds no environment.
      const [inserted] = yield* sql
        .batch([
          insertCredential(sql, {
            accountId: actor.accountId,
            credential: serviceAccount,
            now,
            endorsement,
            welcome,
          }),
          ...namesKeyWraps.map(
            ({ orgId, wrap }) =>
              sql`INSERT INTO names_key_wrap (org_id, reader_id, wrap, created_at)
                  SELECT ${orgId}, ${serviceAccount.id}, ${wrap}, ${now}
                  WHERE ${made}`,
          ),
          yield* audit.entry(
            {
              accountId: actor.accountId,
              actor: actorOf(actor),
              action: 'credential.pair',
              detail: serviceAccount.name,
            },
            made,
          ),
        ])
        .pipe(Effect.orDie);
      if ((inserted ?? []).length === 0) return yield* credentialTaken();
      return yield* one(actor, serviceAccount.id);
    }),

    setAccess: Effect.fn('Access.setAccess')(function* ({
      actor,
      id,
      environmentId,
      access,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly environmentId: string;
      readonly access: SetAccessPayload;
    }) {
      const target = yield* changeable(actor, id);
      const { canRead, canWrite, readWrap, keyProof } = access;
      if (!canRead && !canWrite) {
        return yield* new InvalidRequestError({
          message:
            'Access is read, write or both. To take the environment away, remove its access.',
        });
      }
      if (!canRead && readWrap !== undefined) {
        return yield* new InvalidRequestError({
          message: 'A read wrap was sent for access that does not read.',
        });
      }
      const { environment } = yield* ownersEnvironment(actor, environmentId, 'grants access');
      // Only what was made for the environment's current key is kept.
      const [held] = yield* sql<{
        readonly readWrap: string | null;
        readonly keyProof: string;
      }>`SELECT read_wrap, key_proof FROM environment_grant
          WHERE environment_id = ${environmentId} AND credential_id = ${id}
            AND key_version = ${environment.keyVersion}`.pipe(Effect.orDie);
      // A read it gains is a wrap only a holder of the environment key can make, and an environment it
      // gains comes with a proof of its key: the store keeps either, and makes neither.
      const wrap = canRead ? (readWrap ?? held?.readWrap ?? null) : null;
      if (canRead && wrap === null) {
        return yield* new InvalidRequestError({
          message: `${target.name} does not read ${addressOf(environment)} yet: send the environment key wrapped to it (\`readWrap\`).`,
        });
      }
      const proof = keyProof ?? held?.keyProof;
      if (proof === undefined) {
        return yield* new InvalidRequestError({
          message: `${target.name} holds nothing on ${addressOf(environment)} yet: send the proof of the environment’s key (\`keyProof\`).`,
        });
      }
      const now = yield* Clock.currentTimeMillis;
      yield* sql
        .batch([
          grantStatement(sql, {
            environmentId,
            credentialId: id,
            canWrite,
            readWrap: wrap,
            keyProof: proof,
            keyVersion: environment.keyVersion,
            now,
          }),
          yield* audit.entry({
            orgId: environment.orgId,
            actor: actorOf(actor),
            action: 'grant.set',
            environmentId,
            detail: `${target.name}: ${[canRead && 'read', canWrite && 'write'].filter(Boolean).join(' + ')}`,
          }),
        ])
        .pipe(Effect.orDie);
      return yield* one(actor, id);
    }),

    removeAccess: Effect.fn('Access.removeAccess')(function* ({
      actor,
      id,
      environmentId,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly environmentId: string;
    }) {
      const target = yield* changeable(actor, id);
      const [listed] = yield* environmentsOf(actor, environmentId);
      if (listed === undefined) {
        return yield* new NotFoundError({ message: 'No environment of your orgs has this id.' });
      }
      const held = sql`EXISTS (SELECT 1 FROM environment_grant
        WHERE environment_id = ${environmentId} AND credential_id = ${id})`;
      yield* sql
        .batch([
          // Logged only when there was access to remove, so before the delete.
          yield* audit.entry(
            {
              orgId: listed.environment.orgId,
              actor: actorOf(actor),
              action: 'grant.remove',
              environmentId,
              detail: target.name,
            },
            held,
          ),
          sql`DELETE FROM environment_grant WHERE environment_id = ${environmentId} AND credential_id = ${id}`,
        ])
        .pipe(Effect.orDie);
      return yield* one(actor, id);
    }),

    setExpiry: Effect.fn('Access.setExpiry')(function* ({
      actor,
      id,
      expiresAt,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly expiresAt: number | null;
    }) {
      // Not even its own: an agent that could extend itself would outlive what the owner chose.
      if (actor._tag !== 'Owner') {
        return yield* new OwnerRequiredError({
          message:
            'Only the owner changes when a CLI login or key expires, from the dashboard. The CLI login that asked for a key may ask for a new end: `baymutt ask change <id> --expires …`.',
        });
      }
      const target = yield* approvedServiceAccountIn(actor.accountId, id);
      yield* sql
        .batch([
          sql`UPDATE credential SET expires_at = ${expiresAt}
              WHERE id = ${id} AND account_id = ${actor.accountId} AND revoked_at IS NULL`,
          yield* audit.entry({
            accountId: actor.accountId,
            actor: actorOf(actor),
            action: 'credential.expiry',
            detail: `${target.name}: ${expiresAt === null ? 'never' : dayOf(expiresAt)}`,
          }),
        ])
        .pipe(Effect.orDie);
      return yield* one(actor, id);
    }),

    revoke: Effect.fn('Access.revoke')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      const target = yield* serviceAccountIn(actor.accountId, id);
      const isOwn =
        actor._tag === 'Owner' ||
        target.id === actor.credentialId ||
        target.parentId === actor.credentialId;
      if (!isOwn) {
        return yield* new OwnerRequiredError({
          message:
            'A CLI login revokes itself and the keys it asked for. The owner revokes any, from the dashboard.',
        });
      }
      const now = yield* Clock.currentTimeMillis;
      // One batch: the bearers stop working, the wraps go, and the log says so. A service account
      // a CLI login asked for goes with it.
      const [revoked] = yield* sql
        .batch([
          ...revokeStatements(sql, {
            ids: sql`SELECT id FROM credential
              WHERE (id = ${id} OR parent_id = ${id}) AND account_id = ${actor.accountId}`,
            now,
          }),
          yield* audit.entry({
            accountId: actor.accountId,
            actor: actorOf(actor),
            action: 'credential.revoke',
            detail: target.name,
          }),
        ])
        .pipe(Effect.orDie);
      return { revoked: (revoked ?? []).map(row => String(row.id)) };
    }),
  };
};
