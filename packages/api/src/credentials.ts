// Service accounts: what the CLI acts as. The owner approves one from the dashboard; a service
// account may make another that holds no more than it does.

import { coded } from '@internal/effect-api';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import { AlreadyExistsError, LimitReachedError, NoAccessError, NotFoundError } from './errors.ts';
import {
  HashSchema,
  IdSchema,
  KeyProofSchema,
  LabelSchema,
  PublicKeySchema,
  SealedSchema,
  TimestampSchema,
  WrapSchema,
} from './fields.ts';
import { Authenticated, Credentials, OwnerRequiredError } from './guards.ts';

export const CredentialGrantSchema = Schema.Struct({
  projectId: Schema.String,
  projectName: Schema.String,
  canRead: Schema.Boolean,
  canWrite: Schema.Boolean,
}).annotate({ identifier: 'CredentialGrant' });

export const ServiceAccountSchema = Schema.Struct({
  id: Schema.String,
  name: LabelSchema,
  publicKey: PublicKeySchema,
  /** The service account that made this one; null for a service account the owner paired. */
  parentId: Schema.NullOr(Schema.String),
  /** The owner's vault vouching for `publicKey`. Only a service account the owner paired has one, and only the owner can read it. */
  endorsement: Schema.NullOr(SealedSchema),
  createdAt: TimestampSchema,
  lastUsedAt: Schema.NullOr(TimestampSchema),
  grants: Schema.Array(CredentialGrantSchema),
}).annotate({ identifier: 'ServiceAccount' });
export type ServiceAccount = typeof ServiceAccountSchema.Type;

const newCredential = {
  id: IdSchema,
  name: LabelSchema,
  publicKey: PublicKeySchema,
  bearerHash: HashSchema,
};

/** What the pairing link carries in its fragment, from the service account to the owner's browser. */
export const PairingRequestSchema = Schema.Struct({
  ...newCredential,
  /** Seals the browser's answer, so the store cannot write one. */
  pairingSecret: HashSchema,
}).annotate({ identifier: 'PairingRequest' });
export type PairingRequest = typeof PairingRequestSchema.Type;

/** Who the caller is. A service account reads its `welcome` here once the owner has approved it. */
export const MeSchema = Schema.Struct({
  accountId: Schema.String,
  accountName: Schema.String,
  accountPublicKey: PublicKeySchema,
  credential: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      name: LabelSchema,
      parentId: Schema.NullOr(Schema.String),
      welcome: Schema.NullOr(SealedSchema),
    }),
  ),
}).annotate({ identifier: 'Me' });
export type Me = typeof MeSchema.Type;

export class CredentialsGroup extends HttpApiGroup.make('credentials')
  .add(
    HttpApiEndpoint.get('me', '/me', { success: MeSchema }).annotateMerge(
      OpenApi.annotations({ summary: 'Who this credential is' }),
    ),
    HttpApiEndpoint.get('list', '/credentials', {
      success: Schema.Struct({ credentials: Schema.Array(ServiceAccountSchema) }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List service accounts',
        description:
          'The owner sees every service account; a service account sees itself and those it made.',
      }),
    ),
    HttpApiEndpoint.post('pair', '/credentials/pair', {
      payload: Schema.Struct({
        ...newCredential,
        endorsement: SealedSchema,
        welcome: SealedSchema,
      }),
      success: ServiceAccountSchema.pipe(HttpApiSchema.status(201)),
      error: [coded(OwnerRequiredError), coded(AlreadyExistsError), coded(LimitReachedError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Approve a service account',
        description:
          'The owner’s approval of the link `baymutt login` prints. The service account starts with no access.',
      }),
    ),
    HttpApiEndpoint.post('create', '/credentials', {
      payload: Schema.Struct({
        ...newCredential,
        grants: Schema.Array(
          Schema.Struct({
            projectId: Schema.String,
            canWrite: Schema.Boolean,
            /** The project key wrapped to the new service account by its maker, or null for no read. */
            readWrap: Schema.NullOr(WrapSchema),
            /** Its maker's proof of the project's public key. */
            keyProof: KeyProofSchema,
          }),
        ),
      }),
      success: ServiceAccountSchema.pipe(HttpApiSchema.status(201)),
      error: [
        coded(OwnerRequiredError),
        coded(AlreadyExistsError),
        coded(NoAccessError),
        coded(NotFoundError),
        coded(LimitReachedError),
      ],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Make a narrower service account',
        description:
          'A service account hands part of its own access to a new one, such as a CI job. It cannot grant what it does not hold, and a service account made this way can make no others.',
      }),
    ),
    HttpApiEndpoint.delete('revoke', '/credentials/:id', {
      params: { id: Schema.String },
      success: Schema.Struct({ revoked: Schema.Array(Schema.String) }),
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Revoke a service account',
        description:
          'Deletes its bearer and its wraps, and those of every service account it made. What it already read stays read: replace those values at their vendors.',
      }),
    ),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Service accounts' })) {}
