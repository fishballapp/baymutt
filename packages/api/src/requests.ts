// Requests: how a CLI login gets at an environment. `baymutt ask access` makes a key that holds nothing
// and a request naming the environments it wants and why; the owner approves or rejects it. An
// approved request's key is a service account holding exactly what the request named.

import { coded } from '@internal/effect-api';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import { KeyOrgSchema, ServiceAccountVouchersSchema } from './credentials.ts';
import {
  AlreadyExistsError,
  LimitReachedError,
  LinkSpentError,
  NamesNotSealedError,
  NotFoundError,
} from './errors.ts';
import {
  DescriptionSchema,
  ExpirySchema,
  HashSchema,
  IdSchema,
  KeyProofSchema,
  LabelSchema,
  OrgNamesKeyWrapSchema,
  OrgSlugSchema,
  PublicKeySchema,
  SealedNameSchema,
  SealedSchema,
  StoredEnvironmentNameSchema,
  TimestampSchema,
  VoucherSchema,
  WrapSchema,
} from './fields.ts';
import { Authenticated, Credentials, OwnerRequiredError } from './guards.ts';

/** How long a request's key works once approved, as its maker asks for it: a minute to ten years. */
export const LifetimeSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 60_000, maximum: 315_360_000_000 }),
).annotate({ description: 'Milliseconds from the approval.' });

/** The command a request's key will be piped into, as the terminal tells it. A claim, shown as one. */
export const CommandSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
).annotate({
  description: 'The command the key is piped into once approved, as its maker tells it.',
});

/** How long a request waits for the owner, in milliseconds. Unanswered by then, it has expired. */
export const REQUEST_WAIT_MS = 3600 * 1000;

/** One environment a request names, and what it asks for on it. */
export const RequestItemSchema = Schema.Struct({
  environmentId: Schema.String,
  orgId: Schema.String,
  orgSlug: OrgSlugSchema,
  environmentName: StoredEnvironmentNameSchema,
  environmentSealedName: Schema.NullOr(SealedNameSchema),
  canRead: Schema.Boolean,
  canWrite: Schema.Boolean,
}).annotate({ identifier: 'RequestItem' });
export type RequestItem = typeof RequestItemSchema.Type;

export const RequestSchema = Schema.Struct({
  /** The id of the key it is for: the service account it becomes. */
  id: IdSchema,
  name: LabelSchema,
  /** The org its key belongs to: every environment it names is in it. */
  org: KeyOrgSchema,
  /** Why, in its maker's words. A claim. */
  reason: DescriptionSchema,
  /** `expired`: nobody answered it within `REQUEST_WAIT_MS` of `createdAt`. Its maker asks again. */
  status: Schema.Literals(['pending', 'approved', 'rejected', 'expired']),
  /** Null for a key its maker keeps in a file; the command it is piped into otherwise. */
  command: Schema.NullOr(CommandSchema),
  /** How long its maker asked for, from the approval; null for no end. */
  lifetime: Schema.NullOr(LifetimeSchema),
  /** When the approved key stops working; null while pending, and for one with no end. */
  expiresAt: Schema.NullOr(TimestampSchema),
  items: Schema.Array(RequestItemSchema),
  publicKey: PublicKeySchema,
  /** Its maker vouching for `publicKey` to the owner. Null for any other caller. */
  keyVoucher: Schema.NullOr(VoucherSchema),
  /** The CLI login that made it, with the vault's endorsement of its key for the owner. */
  maker: Schema.Struct({
    id: Schema.String,
    name: LabelSchema,
    publicKey: PublicKeySchema,
    endorsement: Schema.NullOr(SealedSchema),
  }),
  createdAt: TimestampSchema,
  resolvedAt: Schema.NullOr(TimestampSchema),
}).annotate({ identifier: 'Request' });
export type Request = typeof RequestSchema.Type;

export class RequestsGroup extends HttpApiGroup.make('requests')
  .add(
    HttpApiEndpoint.get('list', '/requests', {
      success: Schema.Struct({ requests: Schema.Array(RequestSchema) }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List requests waiting for the owner',
        description: 'The owner sees every pending one; a CLI login sees those it made.',
      }),
    ),
    HttpApiEndpoint.get('get', '/requests/:id', {
      params: { id: Schema.String },
      success: RequestSchema,
      error: coded(NotFoundError),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Get a request',
        description:
          'Answered or not, to the owner, the CLI login that made it, or its own key. It is how a terminal learns that the owner answered.',
      }),
    ),
    HttpApiEndpoint.post('create', '/requests', {
      payload: Schema.Struct({
        id: IdSchema,
        name: LabelSchema,
        publicKey: PublicKeySchema,
        bearerHash: HashSchema,
        vouchers: ServiceAccountVouchersSchema,
        reason: DescriptionSchema,
        command: Schema.NullOr(CommandSchema),
        lifetime: Schema.NullOr(LifetimeSchema),
        /** At least one, each environment once, all of one org. Read, write or both on each. */
        items: Schema.NonEmptyArray(
          Schema.Struct({
            environmentId: Schema.String,
            canRead: Schema.Boolean,
            canWrite: Schema.Boolean,
          }),
        ),
      }),
      success: RequestSchema.pipe(HttpApiSchema.status(201)),
      error: [
        coded(OwnerRequiredError),
        coded(AlreadyExistsError),
        coded(NotFoundError),
        coded(LimitReachedError),
      ],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Ask for environments',
        description:
          'A CLI login only. It registers a new key that holds nothing, and a request for whole environments of one of the person’s orgs, each of which exists: the key belongs to that org. Environments of more than one org are refused; ask once per org. The key works once the owner approves; a request left unanswered for an hour expires.',
      }),
    ),
    HttpApiEndpoint.post('approve', '/requests/:id/approve', {
      params: { id: Schema.String },
      payload: Schema.Struct({
        /** When the key stops working: the owner's choice, whatever was asked for. Null for no end. */
        expiresAt: Schema.NullOr(ExpirySchema),
        /** One per item: the owner's proof of its key, and the key wrapped to the request's key where it asked to read. */
        grants: Schema.Array(
          Schema.Struct({
            environmentId: Schema.String,
            readWrap: Schema.NullOr(WrapSchema),
            keyProof: KeyProofSchema,
            keyVersion: Schema.Int,
          }),
        ),
        /** The names key of each org the items are in, wrapped to the request's key. */
        namesKeyWraps: Schema.Array(OrgNamesKeyWrapSchema),
      }),
      success: RequestSchema,
      error: [
        coded(NotFoundError),
        coded(OwnerRequiredError),
        coded(LinkSpentError),
        coded(NamesNotSealedError),
      ],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Approve a request',
        description:
          'Owner only. The key gets exactly what the request named, no more and no less, in one write: the owner changes only when it ends. `LinkSpentError` when it was already answered.',
      }),
    ),
    HttpApiEndpoint.post('reject', '/requests/:id/reject', {
      params: { id: Schema.String },
      success: RequestSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError), coded(LinkSpentError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Reject a request',
        description:
          'The owner, or the CLI login that made it. Its key is revoked and never held anything.',
      }),
    ),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Requests' })) {}
