// The rows `Access` reads, and the lookups its sub-domains share.
import {
  type ActorIdentity,
  AlreadyExistsError,
  type Environment,
  LIMITS,
  LimitReachedError,
  NamesNotSealedError,
  NoAccessError,
  NotFoundError,
  OwnerRequiredError,
  PLAN_WAIT_MS,
} from '@baymutt/api';
import type * as D1Client from '@effect/sql-d1/D1Client';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import type * as Statement from 'effect/sql/Statement';
import { ActorJsonSchema } from '../actors.ts';

export const ServiceAccountRowSchema = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  name: Schema.String,
  publicKey: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  endorsement: Schema.NullOr(Schema.String),
  welcome: Schema.NullOr(Schema.String),
  keyVoucherOwner: Schema.NullOr(Schema.String),
  keyVoucherMaker: Schema.NullOr(Schema.String),
  accountVoucher: Schema.NullOr(Schema.String),
  createdAt: Schema.Finite,
  lastUsedAt: Schema.NullOr(Schema.Finite),
  expiresAt: Schema.NullOr(Schema.Finite),
  intent: Schema.NullOr(Schema.Literals(['service-account', 'agent'])),
  /** The org a key belongs to; null for a CLI login. */
  orgId: Schema.NullOr(Schema.String),
  orgSlug: Schema.NullOr(Schema.String),
});
export type ServiceAccountRow = typeof ServiceAccountRowSchema.Type;

export const EnvironmentRowSchema = Schema.Struct({
  id: Schema.String,
  orgId: Schema.String,
  orgSlug: Schema.String,
  /** The caller's person's role in the org. */
  role: Schema.String,
  name: Schema.String,
  sealedName: Schema.NullOr(Schema.String),
  areNamesSealed: Schema.Finite,
  publicKey: Schema.String,
  keyVersion: Schema.Finite,
  createdBy: ActorJsonSchema,
  createdAt: Schema.Finite,
  secretCount: Schema.Finite,
  /** The caller's person's own copy of the key, and the creator's proof to it. */
  memberWrap: Schema.NullOr(Schema.String),
  memberProof: Schema.NullOr(Schema.String),
  /** The caller's grant, when the caller is a key that has one. */
  readWrap: Schema.NullOr(Schema.String),
  keyProof: Schema.NullOr(Schema.String),
});
export type EnvironmentRow = typeof EnvironmentRowSchema.Type;

/** What a caller may do with an environment, and the wrap it reads with. */
export type EnvironmentAccess = {
  readonly environment: Environment & { readonly sealedName: string | null };
  /** Whether its org's names are sealed: a new name can be made in it only then. */
  readonly areNamesSealed: boolean;
  /** The caller is the signed-in owner of the environment's org. */
  readonly isOrgOwner: boolean;
  /** The member copy of the key and its proof, for the owner; null for a credential. */
  readonly memberWrap: string | null;
  readonly memberProof: string | null;
  /** The environment key wrapped to the caller, and the reader id the wrap is bound to. */
  readonly wrap: string | null;
  readonly readerId: string;
  /** The caller is a CLI login, which lists every environment and holds none. */
  readonly readerIsLogin: boolean;
};

/** What `ServiceAccountRowSchema` reads, from `credential c LEFT JOIN organization o` on its org. */
export const serviceAccountColumns = (sql: D1Client.D1Client) =>
  sql`c.id, c.account_id, c.name, c.public_key, c.parent_id, c.description, c.endorsement,
    c.welcome, c.key_voucher_owner, c.key_voucher_maker, c.account_voucher, c.created_at,
    c.last_used_at, c.expires_at, c.intent, c.org_id, o.slug AS org_slug`;

/**
 * Who may hold an org's names key besides the owner's account: a CLI login, which lists names in
 * every org of its person, or a key of that org. A key of another org may not.
 */
export const mayListNamesIn = (
  reader: { readonly parentId: string | null; readonly orgId: string | null },
  orgId: string,
) => reader.parentId === null || reader.orgId === orgId;

/** What a key is told when it reaches past the one org it belongs to. */
export const outsideKeyOrg = (keyOrgSlug: string, what: string) =>
  `A key belongs to one org, and this one belongs to ${keyOrgSlug}: ${what}. Ask once per org: a key for another org is asked for in a plan of its own.`;

/** A CLI login: made by `baymutt auth login` and approved by the owner, so it has no parent. It holds no environment. */
export const isLogin = (actor: ActorIdentity): boolean =>
  actor._tag === 'Credential' && actor.parentId === null;

/**
 * How a message a person or an agent reads names an environment. In an org whose names are
 * sealed the store holds only an index, so the address is left for the reader to fill in.
 */
export const addressOf = (environment: {
  readonly orgSlug: string;
  readonly name: string;
  readonly sealedName?: string | null | undefined;
}) =>
  (environment.sealedName ?? null) === null
    ? `${environment.orgSlug}/${environment.name}`
    : `${environment.orgSlug}/<environment>`;

/** What a CLI login is told when it reaches for a read only a key holds. */
export const loginHoldsNothing = (environment: Parameters<typeof addressOf>[0]) =>
  `A CLI login holds no environment. Ask for a key that reads ${addressOf(environment)} in a plan's \`access\` step (\`baymutt ask --help\`); the owner approves, and the key reads it. If this task already holds a key, ask to add it to that one in a \`change\` step instead.`;

/**
 * The orgs a person belongs to, by their account: a subquery for `IN (…)`. A credential reaches only
 * environments of these, whatever grant rows say.
 */
export const orgsOf = (sql: D1Client.D1Client, accountId: string) =>
  sql`SELECT m.organizationId FROM member m JOIN store_account a ON a.user_id = m.userId
      WHERE a.id = ${accountId}`;

/** Whether an org's names are sealed: it has a names key, held by at least its owner. */
export const areNamesSealedIn = (sql: D1Client.D1Client, orgId: string) =>
  sql`EXISTS (SELECT 1 FROM names_key_wrap WHERE org_id = ${orgId})`;

export const lookups = (sql: D1Client.D1Client) => {
  /**
   * Live environments of the caller's orgs with its grant and its person's member copy joined on.
   * `credentialId` null with `seesAll` is the owner or a CLI login, which see every environment of
   * the person's orgs; a service account sees only those it holds a grant on.
   */
  const environmentRows = SqlSchema.findAll({
    Request: Schema.Struct({
      accountId: Schema.String,
      credentialId: Schema.NullOr(Schema.String),
      seesAll: Schema.Boolean,
      environmentId: Schema.NullOr(Schema.String),
    }),
    Result: EnvironmentRowSchema,
    execute: ({ accountId, credentialId, seesAll, environmentId }) =>
      sql`SELECT e.id, e.org_id, o.slug AS org_slug, m.role, e.name, e.sealed_name,
            EXISTS (SELECT 1 FROM names_key_wrap n WHERE n.org_id = e.org_id) AS are_names_sealed,
            e.public_key, e.key_version, e.created_by, e.created_at, w.wrap AS member_wrap,
            w.proof AS member_proof, g.read_wrap, g.key_proof,
            (SELECT COUNT(*) FROM secret s
              WHERE s.environment_id = e.id AND s.current_version IS NOT NULL) AS secret_count
          FROM environment e
          JOIN organization o ON o.id = e.org_id
          JOIN store_account a ON a.id = ${accountId}
          JOIN member m ON m.organizationId = e.org_id AND m.userId = a.user_id
          LEFT JOIN member_wrap w ON w.environment_id = e.id AND w.account_id = a.id
          LEFT JOIN environment_grant g ON g.environment_id = e.id AND g.credential_id = ${credentialId}
          WHERE e.deleted_at IS NULL
            AND (${environmentId} IS NULL OR e.id = ${environmentId})
            AND (${seesAll ? 1 : 0} = 1 OR g.credential_id IS NOT NULL)
          ORDER BY o.slug, e.name`,
  });

  const toAccess = (actor: ActorIdentity, row: EnvironmentRow): EnvironmentAccess => {
    const isOwner = actor._tag === 'Owner';
    const isOrgOwner = isOwner && row.role === 'owner';
    return {
      environment: {
        id: row.id,
        orgId: row.orgId,
        orgSlug: row.orgSlug,
        name: row.name,
        sealedName: row.sealedName,
        publicKey: row.publicKey,
        keyVersion: row.keyVersion,
        createdAt: row.createdAt,
        createdBy: row.createdBy,
        secretCount: row.secretCount,
        keyProof: isOwner ? null : row.keyProof,
        canRead: isOwner ? row.memberWrap !== null : row.readWrap !== null,
        // A key only reads: the owner writes, and an agent asks for a write in a plan.
        canWrite: isOrgOwner,
      },
      areNamesSealed: row.areNamesSealed !== 0,
      isOrgOwner,
      memberWrap: isOwner ? row.memberWrap : null,
      memberProof: isOwner ? row.memberProof : null,
      wrap: isOwner ? row.memberWrap : row.readWrap,
      readerId: isOwner ? actor.accountId : actor.credentialId,
      readerIsLogin: isLogin(actor),
    };
  };

  const environmentsOf = (actor: ActorIdentity, environmentId: string | null = null) =>
    environmentRows({
      accountId: actor.accountId,
      // A CLI login's grants are never read: it holds no environment, whatever a row says.
      credentialId: actor._tag === 'Credential' && !isLogin(actor) ? actor.credentialId : null,
      seesAll: actor._tag === 'Owner' || isLogin(actor),
      environmentId,
    }).pipe(
      Effect.orDie,
      Effect.map(rows => rows.map(row => toAccess(actor, row))),
    );

  /**
   * An environment the caller lists: any of the person's orgs for the owner and a CLI login, one it
   * holds a grant on for a service account. One a service account holds no grant on reads as not
   * found: its name is not the caller's to learn. Listed is not granted: `reading` checks that.
   */
  const environmentFor = Effect.fnUntraced(function* (actor: ActorIdentity, environmentId: string) {
    const [access] = yield* environmentsOf(actor, environmentId);
    if (access === undefined) {
      return yield* new NotFoundError({
        message:
          actor._tag === 'Owner' || isLogin(actor)
            ? 'No environment of your orgs has this id. List them with `baymutt env list`.'
            : 'No environment with this id is granted to this key. List what it holds with `baymutt env list`; the CLI login that asked for it asks to add more in a plan’s `change` step.',
      });
    }
    return access;
  });

  /**
   * An environment for an owner-only action: the caller is the signed-in owner of its org, which
   * holds every one of its environments.
   */
  const ownersEnvironment = Effect.fnUntraced(function* (
    actor: ActorIdentity,
    environmentId: string,
    what: string,
  ) {
    if (actor._tag !== 'Owner') {
      return yield* new OwnerRequiredError({
        message: `Only an owner of the environment's org ${what}, from the dashboard.`,
      });
    }
    const access = yield* environmentFor(actor, environmentId);
    if (!access.isOrgOwner) {
      return yield* new OwnerRequiredError({
        message: `Only an owner of ${access.environment.orgSlug} ${what}.`,
      });
    }
    return access;
  });

  /** The caller reads the environment: the owner's member copy, or a key's grant. */
  const reading = (access: EnvironmentAccess) => {
    if (access.environment.canRead) return Effect.succeed(access);
    return Effect.fail(
      new NoAccessError({
        need: 'read',
        message: access.readerIsLogin
          ? loginHoldsNothing(access.environment)
          : `This key does not read ${addressOf(access.environment)}. The CLI login that asked for it asks to add it, on the same key, in a plan's \`change\` step for key ${access.readerId}.`,
      }),
    );
  };

  const serviceAccountRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      accountId: Schema.String,
      id: Schema.String,
      isAnsweredOnly: Schema.Boolean,
    }),
    Result: ServiceAccountRowSchema,
    execute: ({ accountId, id, isAnsweredOnly }) =>
      sql`SELECT ${serviceAccountColumns(sql)}
          FROM credential c LEFT JOIN organization o ON o.id = c.org_id
          WHERE c.id = ${id} AND c.account_id = ${accountId} AND c.revoked_at IS NULL
            AND (${isAnsweredOnly ? 1 : 0} = 0 OR NOT EXISTS (
              SELECT 1 FROM plan_step WHERE key_id = c.id AND type = 'access'
                AND status <> 'approved'))`,
  });

  const notFound = () => new NotFoundError({ message: 'No CLI login or key has this id.' });

  /** A working CLI login or key of the account, or a plan's key still waiting. */
  const serviceAccountIn = Effect.fnUntraced(function* (accountId: string, id: string) {
    const found = yield* serviceAccountRow({ accountId, id, isAnsweredOnly: false }).pipe(
      Effect.orDie,
    );
    if (Option.isNone(found)) return yield* notFound();
    return found.value;
  });

  /**
   * A CLI login or key whose access the owner may change: a plan's key is not a key until its
   * `access` step is approved.
   */
  const approvedServiceAccountIn = Effect.fnUntraced(function* (accountId: string, id: string) {
    const found = yield* serviceAccountRow({ accountId, id, isAnsweredOnly: true }).pipe(
      Effect.orDie,
    );
    if (Option.isNone(found)) return yield* notFound();
    return found.value;
  });

  const LIMIT_WORDS = {
    orgs: ['orgs', 'Delete an empty one in the dashboard'],
    environments: ['environments across their orgs', 'Delete one in the dashboard'],
    serviceAccounts: ['CLI logins and keys', 'Revoke one with `baymutt key revoke <id>`'],
  } as const;

  /**
   * Refuses once the account would hold more than the beta allows, `adding` more. Counted before
   * the write, so two requests at once can pass together and overshoot: a cap on growth, not an
   * invariant. A credential counts while it works: not revoked, not expired, and not a plan's key
   * past its hour that the daily run has yet to tidy.
   */
  const underLimit = Effect.fnUntraced(function* (
    accountId: string,
    what: 'orgs' | 'environments' | 'serviceAccounts',
    adding = 1,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const held = {
      orgs: sql`SELECT COUNT(*) AS held FROM (${orgsOf(sql, accountId)})`,
      environments: sql`SELECT COUNT(*) AS held FROM environment
        WHERE org_id IN (${orgsOf(sql, accountId)}) AND deleted_at IS NULL`,
      serviceAccounts: sql`SELECT COUNT(*) AS held FROM credential
        WHERE account_id = ${accountId} AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ${now})
          AND NOT EXISTS (SELECT 1 FROM plan_step s JOIN plan p ON p.id = s.plan_id
            WHERE s.key_id = credential.id AND s.type = 'access' AND s.status = 'pending'
              AND p.created_at <= ${now - PLAN_WAIT_MS})`,
    }[what];
    const [row] = yield* held.pipe(Effect.orDie);
    if (Number(row?.held ?? 0) + adding > LIMITS[what]) {
      const [noun, remedy] = LIMIT_WORDS[what];
      return yield* new LimitReachedError({
        limit: LIMITS[what],
        message: `An account holds up to ${LIMITS[what]} ${noun} while baymutt is in beta. ${remedy} to make room.`,
      });
    }
  });

  const orgRow = SqlSchema.findAll({
    Request: Schema.Struct({ accountId: Schema.String, orgId: Schema.String }),
    Result: Schema.Struct({
      slug: Schema.String,
      role: Schema.String,
      areNamesSealed: Schema.Finite,
    }),
    execute: ({ accountId, orgId }) =>
      sql`SELECT o.slug, m.role, ${areNamesSealedIn(sql, orgId)} AS are_names_sealed
          FROM organization o
          JOIN member m ON m.organizationId = o.id
          JOIN store_account a ON a.user_id = m.userId
          WHERE o.id = ${orgId} AND a.id = ${accountId}`,
  });

  /** An org of the caller's person, whatever their role in it. */
  const memberOrg = Effect.fnUntraced(function* (actor: ActorIdentity, orgId: string) {
    const [org] = yield* orgRow({ accountId: actor.accountId, orgId }).pipe(Effect.orDie);
    if (org === undefined) {
      return yield* new NotFoundError({ message: 'No org of yours has this id.' });
    }
    return { slug: org.slug, role: org.role, areNamesSealed: org.areNamesSealed !== 0 };
  });

  /** An org of the caller's person that the person owns, for an owner-only action. */
  const ownedOrg = Effect.fnUntraced(function* (actor: ActorIdentity, orgId: string, what: string) {
    const org = yield* memberOrg(actor, orgId);
    if (actor._tag !== 'Owner' || org.role !== 'owner') {
      return yield* new OwnerRequiredError({
        message: `Only an owner of ${org.slug} ${what}, from the dashboard.`,
      });
    }
    return { slug: org.slug, areNamesSealed: org.areNamesSealed };
  });

  /** Why a new environment could not take its name: a live one has it, or one in the bin keeps it. */
  const nameTaken = Effect.fnUntraced(function* ({
    id,
    orgId,
    orgSlug,
    name,
  }: {
    readonly id: string;
    readonly orgId: string;
    readonly orgSlug: string;
    readonly name: string;
  }) {
    const [taken] = yield* sql<{
      readonly isBinned: number;
      readonly isSameId: number;
    }>`SELECT deleted_at IS NOT NULL AS is_binned, id = ${id} AS is_same_id FROM environment
        WHERE id = ${id} OR (org_id = ${orgId} AND name = ${name})
        ORDER BY id = ${id} DESC LIMIT 1`.pipe(Effect.orDie);
    if (taken?.isSameId === 1) {
      return new AlreadyExistsError({
        message: 'An environment with this id exists. Make a new id and try again.',
      });
    }
    // A name in the bin stays taken: reusing it would leave two environments to tell apart.
    return new AlreadyExistsError({
      message:
        taken?.isBinned === 1
          ? `An environment with this name is in the bin of ${orgSlug}, and keeps its name until it is removed for good. The owner can restore it, or remove it for good, from the Bin in the dashboard.`
          : `An environment with this name exists in ${orgSlug}.`,
    });
  });

  const waitingChanges = SqlSchema.findAll({
    Request: Schema.Struct({ keyId: Schema.String, now: Schema.Finite }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ keyId, now }) =>
      sql`SELECT p.id FROM plan_step s JOIN plan p ON p.id = s.plan_id
          WHERE s.key_id = ${keyId} AND s.type = 'change' AND s.status = 'pending'
            AND p.cancelled_at IS NULL AND p.created_at > ${now - PLAN_WAIT_MS}`,
  });

  /** Refuses a change to a key while another plan's step waits to change it: one at a time. */
  const noChangeWaiting = Effect.fnUntraced(function* (key: {
    readonly id: string;
    readonly name: string;
  }) {
    const now = yield* Clock.currentTimeMillis;
    const [waiting] = yield* waitingChanges({ keyId: key.id, now }).pipe(Effect.orDie);
    if (waiting === undefined) return;
    return yield* new AlreadyExistsError({
      message: `Plan ${waiting.id} still waits for the owner to change ${key.name}. Wait for it (\`baymutt ask wait ${waiting.id}\`) or withdraw it (\`baymutt ask cancel ${waiting.id}\`) first.`,
    });
  });

  return {
    noChangeWaiting,
    environmentsOf,
    environmentFor,
    ownersEnvironment,
    reading,
    serviceAccountIn,
    approvedServiceAccountIn,
    underLimit,
    memberOrg,
    ownedOrg,
    nameTaken,
  };
};

/** What a write of a new name is told in an org whose names are still stored as written. */
export const namesNotSealed = (orgSlug: string) =>
  new NamesNotSealedError({
    message: `The names in ${orgSlug} are not sealed yet, so nothing with a new name can be made in it. The owner seals them by opening the baymutt dashboard once; then try again.`,
  });

/** A read granted by the owner, upserted. `onlyIf` conditions it inside a batch. */
export const grantStatement = (
  sql: D1Client.D1Client,
  {
    environmentId,
    credentialId,
    readWrap,
    keyProof,
    keyVersion,
    now,
  }: {
    readonly environmentId: string;
    readonly credentialId: string;
    readonly readWrap: string;
    readonly keyProof: string;
    readonly keyVersion: number;
    readonly now: number;
  },
  onlyIf: Statement.Fragment = sql`1 = 1`,
) =>
  sql`INSERT INTO environment_grant
        (environment_id, credential_id, read_wrap, key_proof, key_version, created_at)
      SELECT ${environmentId}, ${credentialId}, ${readWrap}, ${keyProof}, ${keyVersion}, ${now}
      WHERE ${onlyIf}
      ON CONFLICT (environment_id, credential_id) DO UPDATE
        SET read_wrap = excluded.read_wrap, key_proof = excluded.key_proof,
            key_version = excluded.key_version`;

/** An org's names key wrapped to a reader, upserted. `onlyIf` conditions it inside a batch. */
export const namesKeyWrapStatement = (
  sql: D1Client.D1Client,
  {
    orgId,
    readerId,
    wrap,
    now,
  }: {
    readonly orgId: string;
    readonly readerId: string;
    readonly wrap: string;
    readonly now: number;
  },
  onlyIf: Statement.Fragment,
) =>
  sql`INSERT INTO names_key_wrap (org_id, reader_id, wrap, created_at)
      SELECT ${orgId}, ${readerId}, ${wrap}, ${now} WHERE ${onlyIf}
      ON CONFLICT (org_id, reader_id) DO UPDATE SET wrap = excluded.wrap`;

/** A new environment and its owner's member copy, both only while `onlyIf` holds. */
export const newEnvironmentStatements = (
  sql: D1Client.D1Client,
  environment: {
    readonly id: string;
    readonly orgId: string;
    readonly name: string;
    readonly sealedName: string;
    readonly publicKey: string;
    readonly memberWrap: string;
    readonly memberProof: string;
  },
  {
    accountId,
    createdBy,
    now,
    onlyIf,
  }: {
    readonly accountId: string;
    readonly createdBy: string;
    readonly now: number;
    readonly onlyIf: Statement.Fragment;
  },
) => {
  // The row is this request's own: an id that was taken leaves another's there.
  const made = sql`EXISTS (SELECT 1 FROM environment
    WHERE id = ${environment.id} AND created_at = ${now} AND public_key = ${environment.publicKey})`;
  return {
    made,
    statements: [
      // `OR IGNORE` leaves a taken name or id without a row, and the rest of the batch sees `made` false.
      sql`INSERT OR IGNORE INTO environment
            (id, org_id, name, sealed_name, public_key, key_version, created_by, created_at)
          SELECT ${environment.id}, ${environment.orgId}, ${environment.name},
            ${environment.sealedName}, ${environment.publicKey}, 1, ${createdBy}, ${now}
          WHERE ${onlyIf}
          RETURNING id`,
      sql`INSERT INTO member_wrap (environment_id, account_id, wrap, proof, key_version, created_at)
          SELECT ${environment.id}, ${accountId}, ${environment.memberWrap},
            ${environment.memberProof}, 1, ${now}
          WHERE ${made}`,
    ],
  };
};

export type Lookups = ReturnType<typeof lookups>;
