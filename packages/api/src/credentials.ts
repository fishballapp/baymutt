// Machines: what a laptop, an agent or a CI job acts as. The owner pairs one from the dashboard; a
// machine may make another that holds no more than it does.

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

export const MachineSchema = Schema.Struct({
  id: Schema.String,
  name: LabelSchema,
  publicKey: PublicKeySchema,
  /** The machine that made this one; null for a machine the owner paired. */
  parentId: Schema.NullOr(Schema.String),
  /** The owner's vault vouching for `publicKey`. Only a machine the owner paired has one, and only the owner can read it. */
  endorsement: Schema.NullOr(SealedSchema),
  createdAt: TimestampSchema,
  lastUsedAt: Schema.NullOr(TimestampSchema),
  grants: Schema.Array(CredentialGrantSchema),
}).annotate({ identifier: 'Machine' });
export type Machine = typeof MachineSchema.Type;

const newCredential = {
  id: IdSchema,
  name: LabelSchema,
  publicKey: PublicKeySchema,
  bearerHash: HashSchema,
};

/** What the pairing link carries in its fragment, from the machine to the owner's browser. */
export const PairingRequestSchema = Schema.Struct({
  ...newCredential,
  /** Seals the browser's answer, so the store cannot write one. */
  pairingSecret: HashSchema,
}).annotate({ identifier: 'PairingRequest' });
export type PairingRequest = typeof PairingRequestSchema.Type;

/** Who the caller is. A machine reads its `welcome` here once it has been paired. */
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
      success: Schema.Struct({ credentials: Schema.Array(MachineSchema) }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List machines',
        description: 'The owner sees every machine; a machine sees itself and those it made.',
      }),
    ),
    HttpApiEndpoint.post('pair', '/credentials/pair', {
      payload: Schema.Struct({
        ...newCredential,
        endorsement: SealedSchema,
        welcome: SealedSchema,
      }),
      success: MachineSchema.pipe(HttpApiSchema.status(201)),
      error: [coded(OwnerRequiredError), coded(AlreadyExistsError), coded(LimitReachedError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Pair a machine',
        description: 'The owner’s approval of a pairing link. The machine starts with no access.',
      }),
    ),
    HttpApiEndpoint.post('create', '/credentials', {
      payload: Schema.Struct({
        ...newCredential,
        grants: Schema.Array(
          Schema.Struct({
            projectId: Schema.String,
            canWrite: Schema.Boolean,
            /** The project key wrapped to the new machine by its maker, or null for no read. */
            readWrap: Schema.NullOr(WrapSchema),
            /** Its maker's proof of the project's public key. */
            keyProof: KeyProofSchema,
          }),
        ),
      }),
      success: MachineSchema.pipe(HttpApiSchema.status(201)),
      error: [
        coded(OwnerRequiredError),
        coded(AlreadyExistsError),
        coded(NoAccessError),
        coded(NotFoundError),
        coded(LimitReachedError),
      ],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Make a narrower machine',
        description:
          'A machine hands part of its own access to a new one, such as a CI job. It cannot grant what it does not hold, and a machine made this way can make no others.',
      }),
    ),
    HttpApiEndpoint.delete('revoke', '/credentials/:id', {
      params: { id: Schema.String },
      success: Schema.Struct({ revoked: Schema.Array(Schema.String) }),
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Revoke a machine',
        description:
          'Deletes its bearer and its wraps, and those of every machine it made. What it already read stays read: replace those values at their vendors.',
      }),
    ),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Machines' })) {}
