// Environment requests: how a CLI login gets a new environment. `baymutt ask create-environment`
// names one and says why; the owner approves by creating it (`environments.create`, naming the
// request it answers), or rejects it. It gives nobody access: that is a request of its own
// (`baymutt ask access`), once the environment exists.

import { coded } from '@internal/effect-api';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import {
  AlreadyExistsError,
  LimitReachedError,
  LinkSpentError,
  NamesNotSealedError,
  NotFoundError,
} from './errors.ts';
import {
  ActorSchema,
  DescriptionSchema,
  IdSchema,
  NameIndexSchema,
  OrgSlugSchema,
  SealedNameSchema,
  TimestampSchema,
} from './fields.ts';
import { Authenticated, Credentials, OwnerRequiredError } from './guards.ts';

/** How long an environment request waits for the owner, in milliseconds. Unanswered by then, it has expired. */
export const ENVIRONMENT_REQUEST_WAIT_MS = 3600 * 1000;

export const EnvironmentRequestSchema = Schema.Struct({
  /** The id the environment has once the request is approved. */
  id: IdSchema,
  orgId: Schema.String,
  orgSlug: OrgSlugSchema,
  /** The name asked for, as its index and sealed under the org's names key. */
  name: NameIndexSchema,
  sealedName: SealedNameSchema,
  /** Why, in its maker's words. A claim. */
  reason: DescriptionSchema,
  /** `expired`: nobody answered it within `ENVIRONMENT_REQUEST_WAIT_MS` of `createdAt`. */
  status: Schema.Literals(['pending', 'approved', 'rejected', 'expired']),
  /** The CLI login that asked. */
  createdBy: ActorSchema,
  createdAt: TimestampSchema,
  resolvedAt: Schema.NullOr(TimestampSchema),
}).annotate({ identifier: 'EnvironmentRequest' });
export type EnvironmentRequest = typeof EnvironmentRequestSchema.Type;

export class EnvironmentRequestsGroup extends HttpApiGroup.make('environmentRequests')
  .add(
    HttpApiEndpoint.get('list', '/environment-requests', {
      success: Schema.Struct({ requests: Schema.Array(EnvironmentRequestSchema) }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List environment requests waiting for the owner',
        description:
          'The owner sees every pending one in their orgs; a CLI login sees those it made.',
      }),
    ),
    HttpApiEndpoint.get('get', '/environment-requests/:id', {
      params: { id: Schema.String },
      success: EnvironmentRequestSchema,
      error: coded(NotFoundError),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Get an environment request',
        description:
          'Answered or not, to the owner or the CLI login that made it. It is how a terminal learns that the owner answered.',
      }),
    ),
    HttpApiEndpoint.post('create', '/environment-requests', {
      payload: Schema.Struct({
        /** The id the environment is to have. */
        id: IdSchema,
        orgId: Schema.String,
        name: NameIndexSchema,
        sealedName: SealedNameSchema,
        reason: DescriptionSchema,
      }),
      success: EnvironmentRequestSchema.pipe(HttpApiSchema.status(201)),
      error: [
        coded(OwnerRequiredError),
        coded(AlreadyExistsError),
        coded(NotFoundError),
        coded(LimitReachedError),
        coded(NamesNotSealedError),
      ],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Ask for a new environment',
        description:
          'A CLI login only, in an org of its person. Nothing is created until the owner approves, which they do by creating the environment (`POST /environments` with `answers`). `AlreadyExistsError` when the org has an environment by this name, or one is already asked for. Left unanswered for an hour, it expires.',
      }),
    ),
    HttpApiEndpoint.post('reject', '/environment-requests/:id/reject', {
      params: { id: Schema.String },
      success: EnvironmentRequestSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError), coded(LinkSpentError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Reject an environment request',
        description: 'The owner, or the CLI login that made it. Nothing was created.',
      }),
    ),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Environment requests' })) {}
