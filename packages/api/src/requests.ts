// The two things a machine asks the owner for: access it does not hold, and a value only the owner
// can fetch (a paste link).

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
  HashSchema,
  IdSchema,
  KeyProofSchema,
  LabelSchema,
  ProjectNameSchema,
  PublicKeySchema,
  ReasonSchema,
  SealedSchema,
  SecretNameSchema,
  TimestampSchema,
  VersionSchema,
  WrapSchema,
} from './fields.ts';
import {
  Authenticated,
  Credentials,
  MaybeAuthenticated,
  OwnerRequiredError,
  UnauthorizedError,
} from './guards.ts';
import { SecretSchema, WriteSecretPayloadSchema } from './secrets.ts';

export const AccessRequestSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  projectName: ProjectNameSchema,
  credentialId: Schema.String,
  credentialName: LabelSchema,
  credentialPublicKey: PublicKeySchema,
  /** The owner's vault vouching for that key; null for a machine the owner did not pair, which cannot be given a read. */
  endorsement: Schema.NullOr(SealedSchema),
  wantsRead: Schema.Boolean,
  wantsWrite: Schema.Boolean,
  reason: ReasonSchema,
  status: Schema.Literals(['pending', 'approved', 'denied']),
  createdAt: TimestampSchema,
}).annotate({ identifier: 'AccessRequest' });
export type AccessRequest = typeof AccessRequestSchema.Type;

export class AccessRequestsGroup extends HttpApiGroup.make('accessRequests')
  .add(
    HttpApiEndpoint.get('list', '/access-requests', {
      success: Schema.Struct({ requests: Schema.Array(AccessRequestSchema) }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List access requests',
        description: 'The owner sees every pending one; a machine sees its own, resolved or not.',
      }),
    ),
    HttpApiEndpoint.post('create', '/access-requests', {
      payload: Schema.Struct({
        id: IdSchema,
        projectName: ProjectNameSchema,
        wantsRead: Schema.Boolean,
        wantsWrite: Schema.Boolean,
        reason: ReasonSchema,
      }),
      success: AccessRequestSchema.pipe(HttpApiSchema.status(201)),
      error: [coded(NotFoundError), coded(OwnerRequiredError), coded(AlreadyExistsError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Ask the owner for access to a project',
        description: 'A machine cannot give itself access. The owner approves in the dashboard.',
      }),
    ),
    HttpApiEndpoint.post('approve', '/access-requests/:id/approve', {
      params: { id: Schema.String },
      payload: Schema.Struct({
        canWrite: Schema.Boolean,
        readWrap: Schema.NullOr(WrapSchema),
        keyProof: KeyProofSchema,
        keyVersion: Schema.Int,
      }),
      success: AccessRequestSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError), coded(LinkSpentError)],
    }).annotateMerge(OpenApi.annotations({ exclude: true })),
    HttpApiEndpoint.post('deny', '/access-requests/:id/deny', {
      params: { id: Schema.String },
      success: AccessRequestSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError), coded(LinkSpentError)],
    }).annotateMerge(OpenApi.annotations({ exclude: true })),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Access requests' })) {}

export const PasteRequestSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  projectName: ProjectNameSchema,
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
  projectPublicKey: PublicKeySchema,
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
        description: 'The owner sees every pending one; a machine sees those it made.',
      }),
    ),
    HttpApiEndpoint.post('create', '/paste-requests', {
      payload: Schema.Struct({
        id: IdSchema,
        projectId: Schema.String,
        name: SecretNameSchema,
        reason: ReasonSchema,
        hint: ReasonSchema,
        /** SHA-256 of the link's token, which the machine made and the store never sees. */
        tokenHash: HashSchema,
      }),
      success: PasteRequestSchema.pipe(HttpApiSchema.status(201)),
      error: [coded(NotFoundError), coded(NoAccessError), coded(AlreadyExistsError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Ask the owner to paste a value',
        description:
          'For a value only the owner can fetch from a vendor. Needs a write grant. The link is single-use and bound to this project and name.',
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
