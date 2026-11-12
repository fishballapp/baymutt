// Machines: recognising one by its bearer, pairing, making a narrower one, revoking.
import {
  type ActorIdentity,
  AlreadyExistsError,
  type Machine,
  type MachineActor,
  type Me,
  NoAccessError,
  NotFoundError,
  OwnerRequiredError,
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
import { actorOf } from '../actors.ts';
import type { Audit } from '../audit.ts';
import { type Lookups, MachineRowSchema } from './rows.ts';

const LAST_USED_RESOLUTION_MS = 60_000;

type NewMachine = {
  readonly id: string;
  readonly name: string;
  readonly publicKey: string;
  readonly bearerHash: string;
};

/** Not a secret comparison (both are hashes of 256 random bits), but equal time costs nothing. */
const isSameHash = (one: string, other: string): boolean =>
  one.length === other.length &&
  Array.from(one).reduce(
    (difference, character, index) =>
      difference | (character.charCodeAt(0) ^ other.charCodeAt(index)),
    0,
  ) === 0;

export const machines = ({
  sql,
  audit,
  lookups: { projectsOf, machineIn, underLimit },
}: {
  readonly sql: D1Client.D1Client;
  readonly audit: Audit['Service'];
  readonly lookups: Lookups;
}) => {
  const byBearer = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ ...MachineRowSchema.fields, bearerHash: Schema.String }),
    execute: id =>
      sql`SELECT id, account_id, name, public_key, bearer_hash, parent_id, endorsement, welcome,
            created_at, last_used_at
          FROM credential WHERE id = ${id} AND revoked_at IS NULL`,
  });

  const visible = SqlSchema.findAll({
    Request: Schema.Struct({ accountId: Schema.String, self: Schema.NullOr(Schema.String) }),
    Result: MachineRowSchema,
    execute: ({ accountId, self }) =>
      sql`SELECT id, account_id, name, public_key, parent_id, endorsement, welcome, created_at,
            last_used_at
          FROM credential
          WHERE account_id = ${accountId} AND revoked_at IS NULL
            AND (${self} IS NULL OR id = ${self} OR parent_id = ${self})
          ORDER BY created_at`,
  });

  const grantsOf = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      credentialId: Schema.String,
      projectId: Schema.String,
      projectName: Schema.String,
      canWrite: Schema.Finite,
      canRead: Schema.Finite,
    }),
    execute: accountId =>
      sql`SELECT g.credential_id, g.project_id, p.name AS project_name, g.can_write,
            g.read_wrap IS NOT NULL AS can_read
          FROM project_grant g JOIN project p ON p.id = g.project_id
          WHERE g.account_id = ${accountId} AND p.archived_at IS NULL
          ORDER BY p.name`,
  });

  const accountOf = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ name: Schema.String, publicKey: Schema.String }),
    execute: accountId => sql`SELECT name, public_key FROM store_account WHERE id = ${accountId}`,
  });

  const list = Effect.fn('Access.listMachines')(function* (actor: ActorIdentity) {
    const [rows, grants] = yield* Effect.all(
      [
        visible({
          accountId: actor.accountId,
          self: actor._tag === 'Machine' ? actor.credentialId : null,
        }),
        grantsOf(actor.accountId),
      ],
      { concurrency: 2 },
    ).pipe(Effect.orDie);
    return rows.map(
      (row): Machine => ({
        id: row.id,
        name: row.name,
        publicKey: row.publicKey,
        parentId: row.parentId,
        // Only the owner's vault can read an endorsement, and only the owner acts on one.
        endorsement: actor._tag === 'Owner' ? row.endorsement : null,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        grants: grants
          .filter(grant => grant.credentialId === row.id)
          .map(({ projectId, projectName, canRead, canWrite }) => ({
            projectId,
            projectName,
            canRead: canRead !== 0,
            canWrite: canWrite !== 0,
          })),
      }),
    );
  });

  const one = Effect.fnUntraced(function* (actor: ActorIdentity, id: string) {
    const found = (yield* list(actor)).find(machine => machine.id === id);
    if (found === undefined) return yield* Effect.die(`machine ${id} vanished after its write`);
    return found;
  });

  const insert =
    (accountId: string, machine: NewMachine, now: number) =>
    ({
      parentId = null,
      endorsement = null,
      welcome = null,
    }: {
      readonly parentId?: string | null;
      readonly endorsement?: string | null;
      readonly welcome?: string | null;
    }) =>
      sql`INSERT OR IGNORE INTO credential
          (id, account_id, name, public_key, bearer_hash, parent_id, endorsement, welcome, created_at)
        VALUES (${machine.id}, ${accountId}, ${machine.name}, ${machine.publicKey},
          ${machine.bearerHash}, ${parentId}, ${endorsement}, ${welcome}, ${now})
        RETURNING id`;

  /** Whether this request's insert is the row: an id that was taken leaves another's bearer there. */
  const madeBy = (machine: NewMachine, now: number) =>
    sql`EXISTS (SELECT 1 FROM credential
                WHERE id = ${machine.id} AND created_at = ${now}
                  AND bearer_hash = ${machine.bearerHash})`;

  const taken = new AlreadyExistsError({
    message: 'A machine with this id exists. Make a new machine key and pair again.',
  });

  return {
    authenticate: Effect.fn('Access.authenticate')(function* (bearer: Redacted.Redacted<string>) {
      const refused = new UnauthorizedError({
        message:
          'This machine key is not paired, or was revoked. Pair it with `baymutt pair`, or check BAYMUTT_KEY.',
      });
      const parsed = yield* Effect.promise(() => parseBearer(Redacted.value(bearer)));
      if (parsed === null) return yield* refused;
      const found = yield* byBearer(parsed.credentialId).pipe(Effect.orDie);
      if (Option.isNone(found) || !isSameHash(found.value.bearerHash, parsed.bearerHash)) {
        return yield* refused;
      }
      const { id, accountId, name, parentId } = found.value;
      const now = yield* Clock.currentTimeMillis;
      // Coarse on purpose: one write a minute per machine, not one a request.
      yield* sql`UPDATE credential SET last_used_at = ${now}
          WHERE id = ${id}
            AND (last_used_at IS NULL OR last_used_at < ${now - LAST_USED_RESOLUTION_MS})`.pipe(
        Effect.ignoreCause({ log: true, message: 'could not stamp a machine’s last use' }),
      );
      return {
        _tag: 'Machine',
        accountId,
        credentialId: id,
        name,
        parentId,
      } satisfies MachineActor;
    }),

    me: Effect.fn('Access.me')(function* (actor: ActorIdentity) {
      const account = yield* accountOf(actor.accountId);
      const base = {
        accountId: actor.accountId,
        accountName: account.name,
        accountPublicKey: account.publicKey,
      };
      if (actor._tag === 'Owner') return { ...base, credential: null } satisfies Me;
      const { id, name, parentId, welcome } = yield* machineIn(actor.accountId, actor.credentialId);
      return { ...base, credential: { id, name, parentId, welcome } } satisfies Me;
    }, Effect.orDie),

    listMachines: list,

    pair: Effect.fn('Access.pair')(function* ({
      actor,
      machine,
      endorsement,
      welcome,
    }: {
      readonly actor: ActorIdentity;
      readonly machine: NewMachine;
      readonly endorsement: string;
      readonly welcome: string;
    }) {
      if (actor._tag !== 'Owner') {
        return yield* new OwnerRequiredError({
          message:
            'Only the owner pairs a machine, from the link `baymutt pair` prints. A machine makes a narrower one with `baymutt machines create`.',
        });
      }
      yield* underLimit(actor.accountId, 'machines');
      const now = yield* Clock.currentTimeMillis;
      const made = madeBy(machine, now);
      const [inserted] = yield* sql
        .batch([
          insert(actor.accountId, machine, now)({ endorsement, welcome }),
          yield* audit.entry(
            {
              accountId: actor.accountId,
              actor: actorOf(actor),
              action: 'credential.pair',
              detail: machine.name,
            },
            made,
          ),
        ])
        .pipe(Effect.orDie);
      if ((inserted ?? []).length === 0) return yield* taken;
      return yield* one(actor, machine.id);
    }),

    createMachine: Effect.fn('Access.createMachine')(function* ({
      actor,
      machine,
      grants,
    }: {
      readonly actor: ActorIdentity;
      readonly machine: NewMachine;
      readonly grants: ReadonlyArray<{
        readonly projectId: string;
        readonly canWrite: boolean;
        readonly readWrap: string | null;
        readonly keyProof: string;
      }>;
    }) {
      if (actor._tag !== 'Machine' || actor.parentId !== null) {
        return yield* new OwnerRequiredError({
          message:
            actor._tag === 'Owner'
              ? 'A machine makes a narrower machine, with `baymutt machines create`; the owner pairs one with `baymutt pair`.'
              : 'A machine made by another machine can make no others. Run this from a machine the owner paired.',
        });
      }
      // It can hand on only what it holds: the store checks the grant, and a read is a wrap only
      // its maker, holding the project key, could have sealed.
      const held = yield* projectsOf(actor);
      for (const grant of grants) {
        const access = held.find(({ project }) => project.id === grant.projectId);
        if (access === undefined) {
          return yield* new NotFoundError({
            message: `No project ${grant.projectId} is granted to this machine.`,
          });
        }
        for (const need of ['read', 'write'] as const) {
          const wants = need === 'read' ? grant.readWrap !== null : grant.canWrite;
          const holds = need === 'read' ? access.project.canRead : access.project.canWrite;
          if (wants && !holds) {
            return yield* new NoAccessError({
              need,
              message: `This machine has no ${need} access to ${access.project.name}, so it cannot hand it on.`,
            });
          }
        }
      }
      yield* underLimit(actor.accountId, 'machines');
      const now = yield* Clock.currentTimeMillis;
      const made = madeBy(machine, now);
      const [inserted] = yield* sql
        .batch([
          insert(actor.accountId, machine, now)({ parentId: actor.credentialId }),
          ...grants.map(grant => {
            const keyVersion =
              held.find(({ project }) => project.id === grant.projectId)?.project.keyVersion ?? 0;
            return sql`INSERT INTO project_grant
                (project_id, credential_id, account_id, can_write, read_wrap, key_proof,
                 key_version, created_at)
              SELECT ${grant.projectId}, ${machine.id}, ${actor.accountId},
                ${grant.canWrite ? 1 : 0}, ${grant.readWrap}, ${grant.keyProof}, ${keyVersion},
                ${now}
              WHERE ${made}`;
          }),
          yield* audit.entry(
            {
              accountId: actor.accountId,
              actor: actorOf(actor),
              action: 'credential.create',
              detail: machine.name,
            },
            made,
          ),
        ])
        .pipe(Effect.orDie);
      if ((inserted ?? []).length === 0) return yield* taken;
      return yield* one(actor, machine.id);
    }),

    revoke: Effect.fn('Access.revoke')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      const target = yield* machineIn(actor.accountId, id);
      const isOwn =
        actor._tag === 'Owner' ||
        target.id === actor.credentialId ||
        target.parentId === actor.credentialId;
      if (!isOwn) {
        return yield* new OwnerRequiredError({
          message: 'A machine can revoke itself and the machines it made. The owner revokes any.',
        });
      }
      const now = yield* Clock.currentTimeMillis;
      const revokedIds = sql`SELECT id FROM credential
        WHERE (id = ${id} OR parent_id = ${id}) AND account_id = ${actor.accountId}`;
      // One batch: the bearers stop working, the wraps and pending requests go, and the log says
      // so. A machine it made holds nothing its maker did not, so it goes with it.
      const [revoked] = yield* sql
        .batch([
          sql`UPDATE credential SET revoked_at = ${now}, bearer_hash = ''
              WHERE id IN (${revokedIds}) AND revoked_at IS NULL RETURNING id`,
          sql`DELETE FROM project_grant WHERE credential_id IN (${revokedIds})`,
          sql`UPDATE access_request SET status = 'denied', resolved_at = ${now}
              WHERE credential_id IN (${revokedIds}) AND status = 'pending'`,
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
