// Projects and the grants on them.
import {
  type ActorIdentity,
  AlreadyExistsError,
  type Grant,
  NotFoundError,
  OwnerRequiredError,
} from '@baymutt/api';
import type * as D1Client from '@effect/sql-d1/D1Client';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import { actorOf, encodeActor } from '../actors.ts';
import type { Audit } from '../audit.ts';
import type { Lookups } from './rows.ts';

const GrantRowSchema = Schema.Struct({
  credentialId: Schema.String,
  credentialName: Schema.String,
  credentialPublicKey: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  endorsement: Schema.NullOr(Schema.String),
  canRead: Schema.Finite,
  canWrite: Schema.Finite,
  createdAt: Schema.Finite,
});

const ownerOnly = (actor: ActorIdentity, what: string) =>
  actor._tag === 'Owner'
    ? Effect.void
    : Effect.fail(
        new OwnerRequiredError({ message: `Only the owner ${what}, from the dashboard.` }),
      );

export const projects = ({
  sql,
  audit,
  lookups: { projectsOf, projectFor, ownersProject, serviceAccountIn, underLimit },
}: {
  readonly sql: D1Client.D1Client;
  readonly audit: Audit['Service'];
  readonly lookups: Lookups;
}) => {
  const grantRows = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: Schema.String,
      credentialId: Schema.NullOr(Schema.String),
    }),
    Result: GrantRowSchema,
    execute: ({ projectId, credentialId }) =>
      sql`SELECT g.credential_id, c.name AS credential_name, c.public_key AS credential_public_key,
            c.parent_id, c.endorsement, g.read_wrap IS NOT NULL AS can_read, g.can_write,
            g.created_at
          FROM project_grant g JOIN credential c ON c.id = g.credential_id
          WHERE g.project_id = ${projectId} AND c.revoked_at IS NULL
            AND (${credentialId} IS NULL OR g.credential_id = ${credentialId})
          ORDER BY c.name`,
  });

  const creatorOf = SqlSchema.findAll({
    Request: Schema.Struct({ accountId: Schema.String, id: Schema.String }),
    Result: Schema.Struct({
      id: Schema.String,
      publicKey: Schema.String,
      endorsement: Schema.NullOr(Schema.String),
    }),
    execute: ({ accountId, id }) =>
      sql`SELECT id, public_key, endorsement FROM credential
          WHERE id = ${id} AND account_id = ${accountId}`,
  });

  const grantsOn = (actor: ActorIdentity, projectId: string, credentialId: string | null = null) =>
    grantRows({ projectId, credentialId }).pipe(
      Effect.orDie,
      Effect.map(rows =>
        rows.map(
          ({ canRead, canWrite, endorsement, ...row }): Grant => ({
            ...row,
            endorsement: actor._tag === 'Owner' ? endorsement : null,
            canRead: canRead !== 0,
            canWrite: canWrite !== 0,
          }),
        ),
      ),
    );

  /** A grant written by the owner. `readWrap` null with `canWrite` false is no grant at all. */
  const grantStatement = ({
    accountId,
    projectId,
    credentialId,
    canWrite,
    readWrap,
    keyProof,
    keyVersion,
    now,
  }: {
    readonly accountId: string;
    readonly projectId: string;
    readonly credentialId: string;
    readonly canWrite: boolean;
    readonly readWrap: string | null;
    readonly keyProof: string;
    readonly keyVersion: number;
    readonly now: number;
  }) =>
    sql`INSERT INTO project_grant
          (project_id, credential_id, account_id, can_write, read_wrap, key_proof, key_version,
           created_at)
        VALUES (${projectId}, ${credentialId}, ${accountId}, ${canWrite ? 1 : 0}, ${readWrap},
          ${keyProof}, ${keyVersion}, ${now})
        ON CONFLICT (project_id, credential_id) DO UPDATE
          SET can_write = excluded.can_write, read_wrap = excluded.read_wrap,
              key_proof = excluded.key_proof, key_version = excluded.key_version`;

  return {
    grantStatement,

    listProjects: Effect.fn('Access.listProjects')(function* (actor: ActorIdentity) {
      return (yield* projectsOf(actor)).map(({ project }) => project);
    }),

    project: projectFor,

    createProject: Effect.fn('Access.createProject')(function* ({
      actor,
      project,
    }: {
      readonly actor: ActorIdentity;
      readonly project: {
        readonly id: string;
        readonly name: string;
        readonly publicKey: string;
        readonly ownerWrap: string;
        readonly ownerProof: string;
        readonly creatorWrap: string | null;
        readonly creatorProof: string | null;
        readonly loginGrants?: ReadonlyArray<{
          readonly credentialId: string;
          readonly readWrap: string;
          readonly keyProof: string;
        }>;
      };
    }) {
      const loginGrants = project.loginGrants ?? [];
      // The owner's vault vouches for a login's key and for no other, so a project made by a
      // scoped service account is one the owner could never open or hand to a login.
      if (actor._tag === 'ServiceAccount' && actor.parentId !== null) {
        return yield* new OwnerRequiredError({
          message:
            'A service account a login made cannot create a project. The owner or a login creates it and hands this service account access.',
        });
      }
      if (actor._tag === 'ServiceAccount' && loginGrants.length > 0) {
        return yield* new OwnerRequiredError({
          message:
            'Only the owner’s vault vouches for a login’s key, so only the owner hands a new project to the logins. The dashboard does it once the owner opens it.',
        });
      }
      if (
        actor._tag === 'ServiceAccount' &&
        (project.creatorWrap === null || project.creatorProof === null)
      ) {
        return yield* new OwnerRequiredError({
          message:
            'A service account that creates a project wraps the project key to itself and vouches for it (`creatorWrap`, `creatorProof`), or it could never read what it made.',
        });
      }
      yield* underLimit(actor.accountId, 'projects');
      const now = yield* Clock.currentTimeMillis;
      // The wrap is this request's own: an id that was taken leaves another's there.
      const made = sql`EXISTS (SELECT 1 FROM project
        WHERE id = ${project.id} AND created_at = ${now} AND owner_wrap = ${project.ownerWrap})`;
      // One batch: the project, its creator's grant and the log entry, or none. `OR IGNORE`
      // leaves a taken name or id without a row.
      const [inserted] = yield* sql
        .batch([
          sql`INSERT OR IGNORE INTO project
                (id, account_id, name, public_key, key_version, owner_wrap, owner_proof,
                 created_by, created_at)
              VALUES (${project.id}, ${actor.accountId}, ${project.name}, ${project.publicKey}, 1,
                ${project.ownerWrap}, ${project.ownerProof}, ${encodeActor(actorOf(actor))}, ${now})
              RETURNING id`,
          ...(actor._tag === 'ServiceAccount'
            ? [
                sql`INSERT INTO project_grant
                      (project_id, credential_id, account_id, can_write, read_wrap, key_proof,
                       key_version, created_at)
                    SELECT ${project.id}, ${actor.credentialId}, ${actor.accountId}, 1,
                      ${project.creatorWrap}, ${project.creatorProof}, 1, ${now}
                    WHERE ${made}`,
              ]
            : []),
          // Each login the owner wrapped the key to, if it is still a live login of this account.
          ...loginGrants.map(
            grant =>
              sql`INSERT INTO project_grant
                    (project_id, credential_id, account_id, can_write, read_wrap, key_proof,
                     key_version, created_at)
                  SELECT ${project.id}, id, account_id, 1, ${grant.readWrap}, ${grant.keyProof}, 1,
                    ${now}
                  FROM credential
                  WHERE id = ${grant.credentialId} AND account_id = ${actor.accountId}
                    AND parent_id IS NULL AND revoked_at IS NULL AND ${made}`,
          ),
          yield* audit.entry(
            {
              accountId: actor.accountId,
              actor: actorOf(actor),
              action: 'project.create',
              projectId: project.id,
              projectName: project.name,
            },
            made,
          ),
        ])
        .pipe(Effect.orDie);
      if ((inserted ?? []).length === 0) {
        return yield* new AlreadyExistsError({
          message: `A project named ${project.name} exists in this account (an archived one keeps its name).`,
        });
      }
      return (yield* projectFor(actor, project.id).pipe(Effect.orDie)).project;
    }),

    archiveProject: Effect.fn('Access.archiveProject')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      yield* ownerOnly(actor, 'archives a project');
      const { project } = yield* ownersProject(actor, id);
      const now = yield* Clock.currentTimeMillis;
      yield* sql
        .batch([
          sql`UPDATE project SET archived_at = ${now} WHERE id = ${id} AND archived_at IS NULL`,
          sql`UPDATE access_request SET status = 'denied', resolved_at = ${now}
              WHERE project_id = ${id} AND status = 'pending'`,
          sql`UPDATE paste_request SET status = 'cancelled', resolved_at = ${now}
              WHERE project_id = ${id} AND status = 'pending'`,
          yield* audit.entry({
            accountId: actor.accountId,
            actor: actorOf(actor),
            action: 'project.archive',
            projectId: id,
            projectName: project.name,
          }),
        ])
        .pipe(Effect.orDie);
      return { archivedAt: now };
    }),

    ownerWrap: Effect.fn('Access.ownerWrap')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      yield* ownerOnly(actor, 'reads the owner’s wrap');
      const { wrap, ownerProof, project } = yield* ownersProject(actor, id);
      if (wrap === null) return yield* Effect.die(`project ${id} has no owner wrap`);
      // The creator's key as the store holds it, revoked or not: the owner's vault decides whether
      // it is one it endorsed.
      const creators =
        project.createdBy.kind === 'machine'
          ? yield* creatorOf({ accountId: actor.accountId, id: project.createdBy.id }).pipe(
              Effect.orDie,
            )
          : [];
      return {
        ownerWrap: wrap,
        ownerProof,
        keyVersion: project.keyVersion,
        creator: creators[0] ?? null,
      };
    }),

    grants: Effect.fn('Access.grants')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      yield* projectFor(actor, id);
      return yield* grantsOn(actor, id);
    }),

    setGrant: Effect.fn('Access.setGrant')(function* ({
      actor,
      id,
      credentialId,
      canWrite,
      readWrap,
      keyProof,
      keyVersion,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly credentialId: string;
      readonly canWrite: boolean;
      readonly readWrap: string | null;
      readonly keyProof: string;
      readonly keyVersion: number;
    }) {
      yield* ownerOnly(actor, 'grants access');
      const { project } = yield* ownersProject(actor, id);
      const serviceAccount = yield* serviceAccountIn(actor.accountId, credentialId);
      if (!canWrite && readWrap === null) {
        return yield* new NotFoundError({
          message: 'A grant gives read, write or both. To take access away, remove the grant.',
        });
      }
      const now = yield* Clock.currentTimeMillis;
      yield* sql
        .batch([
          grantStatement({
            accountId: actor.accountId,
            projectId: id,
            credentialId,
            canWrite,
            readWrap,
            keyProof,
            keyVersion,
            now,
          }),
          // A grant of both settles anything the service account asked for on this project.
          ...(readWrap !== null && canWrite
            ? [
                sql`UPDATE access_request SET status = 'approved', resolved_at = ${now}
                    WHERE project_id = ${id} AND credential_id = ${credentialId}
                      AND status = 'pending'`,
              ]
            : []),
          yield* audit.entry({
            accountId: actor.accountId,
            actor: actorOf(actor),
            action: 'grant.set',
            projectId: id,
            projectName: project.name,
            detail: `${serviceAccount.name}: ${[readWrap !== null && 'read', canWrite && 'write'].filter(Boolean).join(' + ')}`,
          }),
        ])
        .pipe(Effect.orDie);
      const [grant] = yield* grantsOn(actor, id, credentialId);
      if (grant === undefined) return yield* Effect.die(`grant ${id}/${credentialId} vanished`);
      return grant;
    }),

    removeGrant: Effect.fn('Access.removeGrant')(function* ({
      actor,
      id,
      credentialId,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly credentialId: string;
    }) {
      yield* ownerOnly(actor, 'removes access');
      const { project } = yield* ownersProject(actor, id);
      const serviceAccount = yield* serviceAccountIn(actor.accountId, credentialId);
      // A service account made by this one holds a copy of the same access, so it loses it too.
      const [removed] = yield* sql
        .batch([
          sql`DELETE FROM project_grant
              WHERE project_id = ${id}
                AND credential_id IN (SELECT id FROM credential
                                      WHERE id = ${credentialId} OR parent_id = ${credentialId})
              RETURNING credential_id`,
          yield* audit.entry({
            accountId: actor.accountId,
            actor: actorOf(actor),
            action: 'grant.remove',
            projectId: id,
            projectName: project.name,
            detail: serviceAccount.name,
          }),
        ])
        .pipe(Effect.orDie);
      return { removed: (removed ?? []).length > 0 };
    }),
  };
};
