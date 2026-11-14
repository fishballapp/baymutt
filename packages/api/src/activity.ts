// Activity: who fetched, wrote or granted what, and when. Never a value. An org's members read its
// entries; a person reads their own account's (sign-in, CLI logins, service accounts).

import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import { ActorSchema, TimestampSchema } from './fields.ts';
import { Authenticated, Credentials } from './guards.ts';

export const ACTIVITY_ACTIONS = [
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
  'org.create',
  'org.delete',
  'environment.create',
  'environment.delete',
  'environment.restore',
  'environment.purge',
  'environment.load',
  'secret.write',
  'secret.delete',
  'secret.rollback',
  'secret.reveal',
  'secret.purge',
  'grant.set',
  'grant.remove',
  'paste-link.create',
  'paste-link.fulfil',
  'paste-link.cancel',
] as const;

export const ActivityActionSchema = Schema.Literals(ACTIVITY_ACTIONS);
export type ActivityAction = typeof ActivityActionSchema.Type;

export const ActivityEventSchema = Schema.Struct({
  id: Schema.String,
  at: TimestampSchema,
  actor: ActorSchema,
  action: ActivityActionSchema,
  /** The org it happened in; null for what concerns the person's own account. */
  orgId: Schema.NullOr(Schema.String),
  environmentId: Schema.NullOr(Schema.String),
  environmentName: Schema.NullOr(Schema.String),
  secretName: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.Int),
  /** The other party or the detail the action names: a credential's name, a grant's shape. */
  detail: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'ActivityEvent' });
export type ActivityEvent = typeof ActivityEventSchema.Type;

export class ActivityGroup extends HttpApiGroup.make('activity')
  .add(
    HttpApiEndpoint.get('list', '/activity', {
      query: {
        orgId: Schema.optionalKey(Schema.String).annotate({
          description: 'One org’s entries, beside the account’s own.',
        }),
        environmentId: Schema.optionalKey(Schema.String),
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
        events: Schema.Array(ActivityEventSchema),
        nextBefore: Schema.NullOr(Schema.String),
      }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Read the activity',
        description:
          'Newest first. The owner reads their orgs’ entries and their account’s; a credential reads what it did itself.',
      }),
    ),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Activity' })) {}
