// The audit log: who fetched, wrote or granted what, and when. Never a value.

import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import { ActorSchema, TimestampSchema } from './fields.ts';
import { Authenticated, Credentials } from './guards.ts';

export const AUDIT_ACTIONS = [
  'account.create',
  'passkey.add',
  'passkey.remove',
  'password.set',
  'password.remove',
  'recovery.rotate',
  'credential.pair',
  'credential.create',
  'credential.revoke',
  'credential.expiry',
  'project.create',
  /** What deleting a project was logged as before the bin: the same deed. */
  'project.archive',
  'project.delete',
  'project.restore',
  'project.purge',
  'project.load',
  'secret.write',
  'secret.delete',
  'secret.rollback',
  'secret.reveal',
  'secret.purge',
  'grant.set',
  'grant.remove',
  'access.request',
  'access.approve',
  'access.deny',
  'paste.request',
  'paste.fulfil',
  'paste.cancel',
] as const;

export const AuditActionSchema = Schema.Literals(AUDIT_ACTIONS);
export type AuditAction = typeof AuditActionSchema.Type;

export const AuditEventSchema = Schema.Struct({
  id: Schema.String,
  at: TimestampSchema,
  actor: ActorSchema,
  action: AuditActionSchema,
  projectId: Schema.NullOr(Schema.String),
  projectName: Schema.NullOr(Schema.String),
  secretName: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.Int),
  /** The other party or the detail the action names: a service account's name, a grant's shape. */
  detail: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'AuditEvent' });
export type AuditEvent = typeof AuditEventSchema.Type;

export class AuditGroup extends HttpApiGroup.make('audit')
  .add(
    HttpApiEndpoint.get('list', '/audit', {
      query: {
        projectId: Schema.optionalKey(Schema.String),
        before: Schema.optionalKey(Schema.String).annotate({
          description: 'An event id: answers the events before it.',
        }),
        limit: Schema.optionalKey(
          Schema.FiniteFromString.check(
            Schema.isInt(),
            Schema.isBetween({ minimum: 1, maximum: 200 }),
          ),
        ),
      },
      success: Schema.Struct({
        events: Schema.Array(AuditEventSchema),
        nextBefore: Schema.NullOr(Schema.String),
      }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Read the audit log',
        description:
          'Newest first. The owner reads all of it; a service account reads what it did itself.',
      }),
    ),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Audit log' })) {}
