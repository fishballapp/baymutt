// Activity: who fetched, wrote or granted what, and when. Never a value. An org's members read its
// entries; a person reads their own account's (sign-in, CLI logins, service accounts).

import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import {
  ActorSchema,
  SealedNameSchema,
  StoredEnvironmentNameSchema,
  StoredSecretNameSchema,
  TimestampSchema,
} from './fields.ts';
import { Authenticated, Credentials } from './guards.ts';

/** What the store logs today. */
export const LOGGED_ACTIONS = [
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
  'plan.create',
  'plan.cancel',
  'step.approve',
  'step.reject',
  'step.expire',
  'org.create',
  'org.delete',
  'names.seal',
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
] as const;

/**
 * What only an entry from before 0.11.0 says: the asks a plan replaced. Nothing logs them now, and
 * the log is never rewritten, so they are read for as long as such an entry is kept.
 */
export const PAST_ACTIONS = [
  'request.create',
  'request.approve',
  'request.reject',
  'request.expire',
  'key-change.create',
  'key-change.approve',
  'key-change.reject',
  'key-change.expire',
  'environment-request.create',
  'environment-request.reject',
  'paste-link.create',
  'paste-link.fulfil',
  'paste-link.cancel',
] as const;

export const ACTIVITY_ACTIONS = [...LOGGED_ACTIONS, ...PAST_ACTIONS] as const;

export const ActivityActionSchema = Schema.Literals(ACTIVITY_ACTIONS);
export type ActivityAction = typeof ActivityActionSchema.Type;
export type LoggedAction = (typeof LOGGED_ACTIONS)[number];

export const ActivityEventSchema = Schema.Struct({
  id: Schema.String,
  at: TimestampSchema,
  actor: ActorSchema,
  action: ActivityActionSchema,
  /** The org it happened in; null for what concerns the person's own account. */
  orgId: Schema.NullOr(Schema.String),
  environmentId: Schema.NullOr(Schema.String),
  /** As the store keeps them: an index and the sealed name, or the name itself in an entry written before the org's names were sealed. */
  environmentName: Schema.NullOr(StoredEnvironmentNameSchema),
  environmentSealedName: Schema.NullOr(SealedNameSchema),
  secretName: Schema.NullOr(StoredSecretNameSchema),
  secretSealedName: Schema.NullOr(SealedNameSchema),
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
