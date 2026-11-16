// Paste links: a single-use link a credential makes, to a page where the signed-in owner pastes
// one value only they can fetch. The link carries nothing but its id: the owner's open vault is
// what answers it. One nobody answers within the hour has expired, and its maker makes another.

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
  NoAccessError,
  NotFoundError,
  VersionConflictError,
} from './errors.ts';
import {
  ActorSchema,
  IdSchema,
  NameIndexSchema,
  OrgSlugSchema,
  PublicKeySchema,
  ReasonSchema,
  SealedNameSchema,
  StoredEnvironmentNameSchema,
  StoredSecretNameSchema,
  TimestampSchema,
  VersionSchema,
} from './fields.ts';
import { Authenticated, Credentials, OwnerRequiredError } from './guards.ts';
import { SealedValuePayloadSchema, SecretSchema } from './secrets.ts';

/** How long a paste link waits for the owner, in milliseconds. Unanswered by then, it has expired. */
export const PASTE_LINK_WAIT_MS = 3600 * 1000;

export const PasteLinkSchema = Schema.Struct({
  id: IdSchema,
  orgId: Schema.String,
  orgSlug: OrgSlugSchema,
  environmentId: Schema.String,
  environmentName: StoredEnvironmentNameSchema,
  environmentSealedName: Schema.NullOr(SealedNameSchema),
  name: StoredSecretNameSchema,
  /** Null only on a link made before its org's names were sealed. */
  sealedName: Schema.NullOr(SealedNameSchema),
  reason: ReasonSchema,
  /** Where the owner finds the value, such as "Stripe dashboard, Developers, API keys". */
  hint: ReasonSchema,
  /** `expired`: nobody answered it within `PASTE_LINK_WAIT_MS` of `createdAt`. */
  status: Schema.Literals(['pending', 'fulfilled', 'cancelled', 'expired']),
  createdBy: ActorSchema,
  createdAt: TimestampSchema,
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

export class PasteLinksGroup extends HttpApiGroup.make('pasteLinks')
  .add(
    HttpApiEndpoint.get('list', '/paste-links', {
      success: Schema.Struct({ links: Schema.Array(PasteLinkSchema) }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List paste links waiting for a value',
        description:
          'The owner sees every pending one in their orgs; a CLI login or service account sees those it made.',
      }),
    ),
    HttpApiEndpoint.post('create', '/paste-links', {
      payload: Schema.Struct({
        id: IdSchema,
        environmentId: Schema.String,
        /** The secret's name, as its index and sealed: the secret need not exist yet. */
        name: NameIndexSchema,
        sealedName: SealedNameSchema,
        reason: ReasonSchema,
        hint: ReasonSchema,
      }),
      success: PasteLinkSchema.pipe(HttpApiSchema.status(201)),
      error: [
        coded(NotFoundError),
        coded(NoAccessError),
        coded(AlreadyExistsError),
        coded(NamesNotSealedError),
      ],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Make a paste link',
        description:
          'For a value only the owner can fetch from a vendor. For a CLI login of the environment’s org, or a service account with a write grant. The link is single-use, bound to this environment and name, answered only by the signed-in owner, and expires after an hour unanswered.',
      }),
    ),
    HttpApiEndpoint.get('get', '/paste-links/:id', {
      params: { id: Schema.String },
      success: PasteLinkSchema,
      error: coded(NotFoundError),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'One paste link, answered or not',
        description: 'For the owner, and for the CLI login or service account that made it.',
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

// The paste page's two calls: the owner's alone, signed in with the vault open.
export class PasteGroup extends HttpApiGroup.make('paste')
  .add(
    HttpApiEndpoint.get('target', '/paste/:id', {
      params: { id: Schema.String },
      success: PasteTargetSchema,
      error: [coded(NotFoundError), coded(LinkSpentError), coded(OwnerRequiredError)],
    }),
    HttpApiEndpoint.post('fulfil', '/paste/:id', {
      params: { id: Schema.String },
      payload: SealedValuePayloadSchema,
      success: SecretSchema,
      error: [
        coded(NotFoundError),
        coded(LinkSpentError),
        coded(OwnerRequiredError),
        coded(VersionConflictError),
        coded(LimitReachedError),
      ],
    }),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ exclude: true })) {}
