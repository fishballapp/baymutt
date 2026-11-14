// Paste links: a single-use link a credential makes, to a page where the owner pastes one value
// only they can fetch.

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
  OrgSlugSchema,
  PublicKeySchema,
  ReasonSchema,
  SecretNameSchema,
  TimestampSchema,
  VersionSchema,
} from './fields.ts';
import { Authenticated, Credentials, MaybeAuthenticated, UnauthorizedError } from './guards.ts';
import { SecretSchema, WriteSecretPayloadSchema } from './secrets.ts';

export const PasteLinkSchema = Schema.Struct({
  id: Schema.String,
  orgId: Schema.String,
  orgSlug: OrgSlugSchema,
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
}).annotate({ identifier: 'PasteLink' });
export type PasteLink = typeof PasteLinkSchema.Type;

/** What the paste page needs to seal one value: the slot, and the key to seal to. */
export const PasteTargetSchema = Schema.Struct({
  link: PasteLinkSchema,
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

export class PasteLinksGroup extends HttpApiGroup.make('pasteLinks')
  .add(
    HttpApiEndpoint.get('list', '/paste-links', {
      success: Schema.Struct({ links: Schema.Array(PasteLinkSchema) }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List paste links waiting for a value',
        description:
          'The owner sees every pending one in their orgs; a credential sees those it made.',
      }),
    ),
    HttpApiEndpoint.post('create', '/paste-links', {
      payload: Schema.Struct({
        id: IdSchema,
        environmentId: Schema.String,
        name: SecretNameSchema,
        reason: ReasonSchema,
        hint: ReasonSchema,
        /** SHA-256 of the link's token, which the credential made and the store never sees. */
        tokenHash: HashSchema,
      }),
      success: PasteLinkSchema.pipe(HttpApiSchema.status(201)),
      error: [coded(NotFoundError), coded(NoAccessError), coded(AlreadyExistsError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Make a paste link',
        description:
          'For a value only the owner can fetch from a vendor. Needs a write grant. The link is single-use and bound to this environment and name.',
      }),
    ),
    HttpApiEndpoint.delete('cancel', '/paste-links/:id', {
      params: { id: Schema.String },
      success: PasteLinkSchema,
      error: [coded(NotFoundError), coded(LinkSpentError)],
    }).annotateMerge(OpenApi.annotations({ summary: 'Cancel a paste link' })),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Paste links' })) {}

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
