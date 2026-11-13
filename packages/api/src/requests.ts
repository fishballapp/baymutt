// What a service account asks the owner for: a value only the owner can fetch (a paste link).

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
  NoAccessError,
  NotFoundError,
  VersionConflictError,
} from './errors.ts';
import {
  ActorSchema,
  EnvironmentNameSchema,
  HashSchema,
  IdSchema,
  PublicKeySchema,
  ReasonSchema,
  SecretNameSchema,
  TimestampSchema,
  VersionSchema,
} from './fields.ts';
import {
  Authenticated,
  Credentials,
  MaybeAuthenticated,
  OwnerRequiredError,
  UnauthorizedError,
} from './guards.ts';
import { SecretSchema, WriteSecretPayloadSchema } from './secrets.ts';

/**
 * `baymutt access request` and `access list` from CLIs before 0.4.0. Access requests were removed:
 * both answer with an error that says what to do instead.
 */
export class RetiredGroup extends HttpApiGroup.make('retired')
  .add(
    HttpApiEndpoint.post('accessRequest', '/access-requests', {
      error: coded(OwnerRequiredError),
    }),
    HttpApiEndpoint.get('accessRequests', '/access-requests', {
      error: coded(OwnerRequiredError),
    }),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ exclude: true })) {}

export const PasteRequestSchema = Schema.Struct({
  id: Schema.String,
  environmentId: Schema.String,
  environmentName: EnvironmentNameSchema,
  name: SecretNameSchema,
  reason: ReasonSchema,
  /** Where the owner finds the value, such as "Stripe dashboard, Developers, API keys". */
  hint: ReasonSchema,
  status: Schema.Literals(['pending', 'fulfilled', 'cancelled']),
  createdBy: ActorSchema,
  createdAt: TimestampSchema,
  /** When the link stops working. The owner can still answer from the dashboard after it. */
  linkExpiresAt: TimestampSchema,
}).annotate({ identifier: 'PasteRequest' });
export type PasteRequest = typeof PasteRequestSchema.Type;

/** What the paste page needs to seal one value: the slot, and the key to seal to. */
export const PasteTargetSchema = Schema.Struct({
  request: PasteRequestSchema,
  accountId: Schema.String,
  environmentPublicKey: PublicKeySchema,
  keyVersion: Schema.Int,
  /** The version the pasted value will be: seal for this slot. */
  nextVersion: VersionSchema,
}).annotate({ identifier: 'PasteTarget' });
export type PasteTarget = typeof PasteTargetSchema.Type;

/** The link's token, sent as a header so it stays out of URLs and logs. */
export const PASTE_TOKEN_HEADER = 'x-baymutt-paste-token';

const pasteHeaders = Schema.Struct({
  [PASTE_TOKEN_HEADER]: Schema.optionalKey(Schema.String),
});

export class PasteRequestsGroup extends HttpApiGroup.make('pasteRequests')
  .add(
    HttpApiEndpoint.get('list', '/paste-requests', {
      success: Schema.Struct({ requests: Schema.Array(PasteRequestSchema) }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List paste requests',
        description: 'The owner sees every pending one; a service account sees those it made.',
      }),
    ),
    HttpApiEndpoint.post('create', '/paste-requests', {
      payload: Schema.Struct({
        id: IdSchema,
        environmentId: Schema.String,
        name: SecretNameSchema,
        reason: ReasonSchema,
        hint: ReasonSchema,
        /** SHA-256 of the link's token, which the service account made and the store never sees. */
        tokenHash: HashSchema,
      }),
      success: PasteRequestSchema.pipe(HttpApiSchema.status(201)),
      error: [coded(NotFoundError), coded(NoAccessError), coded(AlreadyExistsError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Ask the owner to paste a value',
        description:
          'For a value only the owner can fetch from a vendor. Needs a write grant. The link is single-use and bound to this environment and name.',
      }),
    ),
    HttpApiEndpoint.delete('cancel', '/paste-requests/:id', {
      params: { id: Schema.String },
      success: PasteRequestSchema,
      error: [coded(NotFoundError), coded(LinkSpentError)],
    }).annotateMerge(OpenApi.annotations({ summary: 'Cancel a paste request' })),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Paste requests' })) {}

// The paste page's two calls. Answered to the link's token or to the owner's session.
export class PasteGroup extends HttpApiGroup.make('paste')
  .add(
    HttpApiEndpoint.get('target', '/paste/:id', {
      params: { id: Schema.String },
      headers: pasteHeaders,
      success: PasteTargetSchema,
      error: [coded(NotFoundError), coded(LinkSpentError), coded(UnauthorizedError)],
    }),
    HttpApiEndpoint.post('fulfil', '/paste/:id', {
      params: { id: Schema.String },
      headers: pasteHeaders,
      payload: WriteSecretPayloadSchema,
      success: SecretSchema,
      error: [
        coded(NotFoundError),
        coded(LinkSpentError),
        coded(UnauthorizedError),
        coded(VersionConflictError),
        coded(LimitReachedError),
      ],
    }),
  )
  .middleware(MaybeAuthenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ exclude: true })) {}
