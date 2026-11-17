// Key changes: how a key an agent already holds gets more, or less. The CLI login that asked for
// the key asks to add environments or access to it, or to give some back, on the same key. Adding,
// or a new end, waits for the owner's approval; giving back alone takes effect at once.

import { coded } from '@internal/effect-api';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import { CredentialGrantSchema, KeyOrgSchema } from './credentials.ts';
import {
  AlreadyExistsError,
  LinkSpentError,
  NamesNotSealedError,
  NotFoundError,
} from './errors.ts';
import {
  DescriptionSchema,
  ExpirySchema,
  IdSchema,
  KeyProofSchema,
  LabelSchema,
  OrgNamesKeyWrapSchema,
  PublicKeySchema,
  SealedSchema,
  TimestampSchema,
  VoucherSchema,
  WrapSchema,
} from './fields.ts';
import { Authenticated, Credentials, OwnerRequiredError } from './guards.ts';
import { LifetimeSchema, RequestItemSchema } from './requests.ts';

export const KeyChangeSchema = Schema.Struct({
  id: IdSchema,
  /** The key it changes, as it is now. */
  key: Schema.Struct({
    id: Schema.String,
    name: LabelSchema,
    intent: Schema.NullOr(Schema.Literals(['service-account', 'agent'])),
    publicKey: PublicKeySchema,
    /** Its maker vouching for `publicKey` to the owner. Null for any other caller. */
    keyVoucher: Schema.NullOr(VoucherSchema),
    /** When it stops working now; null for never. */
    expiresAt: Schema.NullOr(TimestampSchema),
  }),
  /** The org its key belongs to: it adds environments of this org only. */
  org: KeyOrgSchema,
  /** Why, in its maker's words. A claim. */
  reason: DescriptionSchema,
  /**
   * `applied`: it only gave access back, which needs no approval. `expired`: nobody answered it
   * within an hour of `createdAt`; the key holds what it held.
   */
  status: Schema.Literals(['pending', 'approved', 'applied', 'rejected', 'expired']),
  /** A new end, from the approval, as asked for; null keeps the key's end. */
  lifetime: Schema.NullOr(LifetimeSchema),
  /** What the key holds now. */
  holds: Schema.Array(CredentialGrantSchema),
  /** Access it asks to add, on top of what it holds: read, write or both on each. */
  add: Schema.Array(RequestItemSchema),
  /** Environments it gives back, with what it held on each when it asked. */
  giveBack: Schema.Array(RequestItemSchema),
  /**
   * An environment it names was removed for good since: it is left out of `add` and `giveBack`,
   * and the change can only be rejected.
   */
  isMissingEnvironment: Schema.Boolean,
  /** The CLI login that asked, with the vault's endorsement of its key for the owner. */
  maker: Schema.Struct({
    id: Schema.String,
    name: LabelSchema,
    publicKey: PublicKeySchema,
    endorsement: Schema.NullOr(SealedSchema),
  }),
  createdAt: TimestampSchema,
  resolvedAt: Schema.NullOr(TimestampSchema),
}).annotate({ identifier: 'KeyChange' });
export type KeyChange = typeof KeyChangeSchema.Type;

export class KeyChangesGroup extends HttpApiGroup.make('keyChanges')
  .add(
    HttpApiEndpoint.get('list', '/key-changes', {
      success: Schema.Struct({ changes: Schema.Array(KeyChangeSchema) }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List key changes waiting for the owner',
        description: 'The owner sees every pending one; a CLI login sees those it asked for.',
      }),
    ),
    HttpApiEndpoint.get('get', '/key-changes/:id', {
      params: { id: Schema.String },
      success: KeyChangeSchema,
      error: coded(NotFoundError),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Get a key change',
        description: 'Answered or not, to the owner or the CLI login that asked for it.',
      }),
    ),
    HttpApiEndpoint.post('create', '/key-changes', {
      payload: Schema.Struct({
        id: IdSchema,
        /** A key this CLI login asked for, for an agent's own work, approved and not ended. */
        keyId: Schema.String,
        reason: DescriptionSchema,
        /** A new end, from the approval; null keeps the key's end. */
        lifetime: Schema.NullOr(LifetimeSchema),
        /** Access to add: read, write or both on each, each environment once, all of the key's org. */
        add: Schema.Array(
          Schema.Struct({
            environmentId: Schema.String,
            canRead: Schema.Boolean,
            canWrite: Schema.Boolean,
          }),
        ),
        /** Environments the key holds and gives back, whole. */
        giveBack: Schema.Array(Schema.String),
      }),
      success: KeyChangeSchema.pipe(HttpApiSchema.status(201)),
      error: [coded(OwnerRequiredError), coded(AlreadyExistsError), coded(NotFoundError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Ask to change a key',
        description:
          'A CLI login only, for a key it asked for, adding environments of the org the key belongs to and of no other. Adding access or a new end waits for the owner, who approves it all or none; one left unanswered for an hour expires, and the key holds what it held. Giving back alone takes effect at once.',
      }),
    ),
    HttpApiEndpoint.post('approve', '/key-changes/:id/approve', {
      params: { id: Schema.String },
      payload: Schema.Struct({
        /** When the key stops working: the owner's choice. Null for no end; absent keeps its end. */
        expiresAt: Schema.optionalKey(Schema.NullOr(ExpirySchema)),
        /**
         * One per environment it adds to: the owner's proof of its key, and the key wrapped to the
         * changed key where the change adds read. Where it reads already, it keeps its wrap.
         */
        grants: Schema.Array(
          Schema.Struct({
            environmentId: Schema.String,
            readWrap: Schema.NullOr(WrapSchema),
            keyProof: KeyProofSchema,
            keyVersion: Schema.Int,
          }),
        ),
        /** The names key of the key's org when it adds to it, wrapped to the changed key. */
        namesKeyWraps: Schema.Array(OrgNamesKeyWrapSchema),
      }),
      success: KeyChangeSchema,
      error: [
        coded(NotFoundError),
        coded(OwnerRequiredError),
        coded(LinkSpentError),
        coded(NamesNotSealedError),
      ],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Approve a key change',
        description:
          'Owner only. The key gains what the change adds and loses what it gives back, in one write; the owner changes only when it ends. `LinkSpentError` when it was already answered.',
      }),
    ),
    HttpApiEndpoint.post('reject', '/key-changes/:id/reject', {
      params: { id: Schema.String },
      success: KeyChangeSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError), coded(LinkSpentError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Reject a key change',
        description:
          'The owner, or the CLI login that asked. The key holds what it held, and keeps working.',
      }),
    ),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Key changes' })) {}
