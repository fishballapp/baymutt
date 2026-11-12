// A machine asking the owner for access it does not hold.
import {
  type AccessRequest,
  type ActorIdentity,
  AlreadyExistsError,
  LinkSpentError,
  NotFoundError,
  OwnerRequiredError,
} from '@baymutt/api';
import type * as D1Client from '@effect/sql-d1/D1Client';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import * as SqlSchema from 'effect/sql/SqlSchema';
import { actorOf } from '../actors.ts';
import type { Audit } from '../audit.ts';
import type { projects } from './projects.ts';

const RequestRowSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  projectName: Schema.String,
  credentialId: Schema.String,
  credentialName: Schema.String,
  credentialPublicKey: Schema.String,
  endorsement: Schema.NullOr(Schema.String),
  wantsRead: Schema.Finite,
  wantsWrite: Schema.Finite,
  reason: Schema.String,
  status: Schema.Literals(['pending', 'approved', 'denied']),
  createdAt: Schema.Finite,
});

export const accessRequests = ({
  sql,
  audit,
  grantStatement,
}: {
  readonly sql: D1Client.D1Client;
  readonly audit: Audit['Service'];
  readonly grantStatement: ReturnType<typeof projects>['grantStatement'];
}) => {
  const rows = SqlSchema.findAll({
    Request: Schema.Struct({
      accountId: Schema.String,
      credentialId: Schema.NullOr(Schema.String),
      id: Schema.NullOr(Schema.String),
    }),
    Result: RequestRowSchema,
    // The owner's list is what awaits an answer; a machine's is its own, answered or not.
    execute: ({ accountId, credentialId, id }) =>
      sql`SELECT r.id, r.project_id, p.name AS project_name, r.credential_id,
            c.name AS credential_name, c.public_key AS credential_public_key, c.endorsement,
            r.wants_read, r.wants_write, r.reason, r.status, r.created_at
          FROM access_request r
          JOIN project p ON p.id = r.project_id
          JOIN credential c ON c.id = r.credential_id
          WHERE r.account_id = ${accountId}
            AND (${id} IS NOT NULL OR ${credentialId} IS NOT NULL OR r.status = 'pending')
            AND (${id} IS NULL OR r.id = ${id})
            AND (${credentialId} IS NULL OR r.credential_id = ${credentialId})
          ORDER BY r.created_at DESC LIMIT 200`,
  });

  const list = (actor: ActorIdentity, id: string | null = null) =>
    rows({
      accountId: actor.accountId,
      credentialId: actor._tag === 'Machine' ? actor.credentialId : null,
      id,
    }).pipe(
      Effect.orDie,
      Effect.map(found =>
        found.map(
          ({ wantsRead, wantsWrite, endorsement, ...row }): AccessRequest => ({
            ...row,
            endorsement: actor._tag === 'Owner' ? endorsement : null,
            wantsRead: wantsRead !== 0,
            wantsWrite: wantsWrite !== 0,
          }),
        ),
      ),
    );

  const one = Effect.fnUntraced(function* (actor: ActorIdentity, id: string) {
    const [request] = yield* list(actor, id);
    if (request === undefined) {
      return yield* new NotFoundError({ message: 'No access request has this id.' });
    }
    return request;
  });

  const pendingForOwner = Effect.fnUntraced(function* (actor: ActorIdentity, id: string) {
    if (actor._tag !== 'Owner') {
      return yield* new OwnerRequiredError({
        message: 'Only the owner answers an access request, from the dashboard.',
      });
    }
    const request = yield* one(actor, id);
    if (request.status !== 'pending') {
      return yield* new LinkSpentError({ message: `This request was already ${request.status}.` });
    }
    return request;
  });

  return {
    listAccessRequests: Effect.fn('Access.listAccessRequests')(function* (actor: ActorIdentity) {
      return yield* list(actor);
    }),

    requestAccess: Effect.fn('Access.requestAccess')(function* ({
      actor,
      request,
    }: {
      readonly actor: ActorIdentity;
      readonly request: {
        readonly id: string;
        readonly projectName: string;
        readonly wantsRead: boolean;
        readonly wantsWrite: boolean;
        readonly reason: string;
      };
    }) {
      if (actor._tag !== 'Machine') {
        return yield* new OwnerRequiredError({
          message: 'The owner grants access directly; a request is how a machine asks for it.',
        });
      }
      if (!request.wantsRead && !request.wantsWrite) {
        return yield* new NotFoundError({ message: 'Ask for read, write or both.' });
      }
      // By name, and whether or not this machine can see the project: asking is how it comes to.
      const [project] = yield* sql`SELECT id FROM project
        WHERE account_id = ${actor.accountId} AND name = ${request.projectName}
          AND archived_at IS NULL`.pipe(Effect.orDie);
      if (project === undefined) {
        return yield* new NotFoundError({
          message: `This account has no project named ${request.projectName}. Create it with \`baymutt projects create ${request.projectName}\`.`,
        });
      }
      const projectId = String(project.id);
      const now = yield* Clock.currentTimeMillis;
      const [inserted] = yield* sql
        .batch([
          sql`INSERT OR IGNORE INTO access_request
                (id, account_id, project_id, credential_id, wants_read, wants_write, reason,
                 status, created_at)
              VALUES (${request.id}, ${actor.accountId}, ${projectId}, ${actor.credentialId},
                ${request.wantsRead ? 1 : 0}, ${request.wantsWrite ? 1 : 0}, ${request.reason},
                'pending', ${now})
              RETURNING id`,
          yield* audit.entry(
            {
              accountId: actor.accountId,
              actor: actorOf(actor),
              action: 'access.request',
              projectId,
              projectName: request.projectName,
              detail: request.reason,
            },
            sql`EXISTS (SELECT 1 FROM access_request WHERE id = ${request.id} AND created_at = ${now})`,
          ),
        ])
        .pipe(Effect.orDie);
      if ((inserted ?? []).length === 0) {
        return yield* new AlreadyExistsError({ message: 'An access request with this id exists.' });
      }
      return yield* one(actor, request.id).pipe(Effect.orDie);
    }),

    approveAccess: Effect.fn('Access.approveAccess')(function* ({
      actor,
      id,
      canWrite,
      readWrap,
      keyProof,
      keyVersion,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
      readonly canWrite: boolean;
      readonly readWrap: string | null;
      readonly keyProof: string;
      readonly keyVersion: number;
    }) {
      const request = yield* pendingForOwner(actor, id);
      const now = yield* Clock.currentTimeMillis;
      yield* sql
        .batch([
          sql`UPDATE access_request SET status = 'approved', resolved_at = ${now}
              WHERE id = ${id} AND status = 'pending'`,
          grantStatement({
            accountId: actor.accountId,
            projectId: request.projectId,
            credentialId: request.credentialId,
            canWrite,
            readWrap,
            keyProof,
            keyVersion,
            now,
          }),
          yield* audit.entry({
            accountId: actor.accountId,
            actor: actorOf(actor),
            action: 'access.approve',
            projectId: request.projectId,
            projectName: request.projectName,
            detail: `${request.credentialName}: ${[readWrap !== null && 'read', canWrite && 'write'].filter(Boolean).join(' + ')}`,
          }),
        ])
        .pipe(Effect.orDie);
      return yield* one(actor, id).pipe(Effect.orDie);
    }),

    denyAccess: Effect.fn('Access.denyAccess')(function* ({
      actor,
      id,
    }: {
      readonly actor: ActorIdentity;
      readonly id: string;
    }) {
      const request = yield* pendingForOwner(actor, id);
      const now = yield* Clock.currentTimeMillis;
      yield* sql
        .batch([
          sql`UPDATE access_request SET status = 'denied', resolved_at = ${now}
              WHERE id = ${id} AND status = 'pending'`,
          yield* audit.entry({
            accountId: actor.accountId,
            actor: actorOf(actor),
            action: 'access.deny',
            projectId: request.projectId,
            projectName: request.projectName,
            detail: request.credentialName,
          }),
        ])
        .pipe(Effect.orDie);
      return yield* one(actor, id).pipe(Effect.orDie);
    }),
  };
};
