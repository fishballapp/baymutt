// Secrets: named values in a project. Every write adds a version and nothing is overwritten, which
// is what makes it safe for a service account to write without asking.

import { coded } from '@internal/effect-api';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import { LimitReachedError, NoAccessError, NotFoundError, VersionConflictError } from './errors.ts';
import {
  ActorSchema,
  CiphertextSchema,
  ProjectNameSchema,
  PublicKeySchema,
  SecretNameSchema,
  TimestampSchema,
  VersionSchema,
  WrapSchema,
} from './fields.ts';
import { Authenticated, Credentials, OwnerRequiredError } from './guards.ts';

export const SecretSchema = Schema.Struct({
  name: SecretNameSchema,
  /** The version a load answers with; null once deleted. */
  currentVersion: Schema.NullOr(VersionSchema),
  /** The highest version ever written: the next write is one above it. */
  latestVersion: VersionSchema,
  /** Of the current version's ciphertext, in bytes: the value's length plus 60. */
  size: Schema.NullOr(Schema.Int),
  updatedAt: TimestampSchema,
  updatedBy: ActorSchema,
}).annotate({ identifier: 'Secret' });
export type Secret = typeof SecretSchema.Type;

export const SecretVersionSchema = Schema.Struct({
  version: VersionSchema,
  keyVersion: Schema.Int,
  size: Schema.Int,
  createdAt: TimestampSchema,
  createdBy: ActorSchema,
  isCurrent: Schema.Boolean,
}).annotate({ identifier: 'SecretVersion' });
export type SecretVersion = typeof SecretVersionSchema.Type;

/** Everything a reader needs to open a project's current values, in one answer. */
export const BundleSchema = Schema.Struct({
  project: Schema.Struct({
    id: Schema.String,
    accountId: Schema.String,
    name: ProjectNameSchema,
    publicKey: PublicKeySchema,
    keyVersion: Schema.Int,
  }),
  /** The project's private key wrapped to the caller, and the reader id it is bound to. */
  wrap: WrapSchema,
  readerId: Schema.String,
  secrets: Schema.Array(
    Schema.Struct({
      name: SecretNameSchema,
      version: VersionSchema,
      keyVersion: Schema.Int,
      ciphertext: CiphertextSchema,
    }),
  ),
}).annotate({ identifier: 'Bundle' });
export type Bundle = typeof BundleSchema.Type;

/** One version of one secret as sealed, for the owner's browser to open. */
export const SealedVersionSchema = Schema.Struct({
  version: VersionSchema,
  keyVersion: Schema.Int,
  ciphertext: CiphertextSchema,
}).annotate({ identifier: 'SealedVersion' });
export type SealedVersion = typeof SealedVersionSchema.Type;

const projectParam = { projectId: Schema.String };
const secretParams = { ...projectParam, name: SecretNameSchema };

export const WriteSecretPayloadSchema = Schema.Struct({
  /** One above the secret's latest version (1 for a new name): the slot the ciphertext was sealed for. */
  version: VersionSchema,
  keyVersion: Schema.Int,
  ciphertext: CiphertextSchema,
});

export class SecretsGroup extends HttpApiGroup.make('secrets')
  .add(
    HttpApiEndpoint.get('list', '/projects/:projectId/secrets', {
      params: projectParam,
      success: Schema.Struct({ secrets: Schema.Array(SecretSchema) }),
      error: [coded(NotFoundError), coded(NoAccessError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List a project’s secrets',
        description: 'Names, versions and sizes; never a value. Either grant is enough.',
      }),
    ),
    HttpApiEndpoint.get('bundle', '/projects/:projectId/bundle', {
      params: projectParam,
      success: BundleSchema,
      error: [coded(NotFoundError), coded(NoAccessError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Load a project',
        description:
          'Every current value as ciphertext, with the project key wrapped to the caller. Needs a read grant.',
      }),
    ),
    HttpApiEndpoint.put('write', '/projects/:projectId/secrets/:name', {
      params: secretParams,
      payload: WriteSecretPayloadSchema,
      success: SecretSchema,
      error: [
        coded(NotFoundError),
        coded(NoAccessError),
        coded(VersionConflictError),
        coded(LimitReachedError),
      ],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Write a secret',
        description: 'Adds a version and makes it current. Needs a write grant, and no key.',
      }),
    ),
    HttpApiEndpoint.delete('remove', '/projects/:projectId/secrets/:name', {
      params: secretParams,
      success: SecretSchema,
      error: [coded(NotFoundError), coded(NoAccessError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Delete a secret',
        description:
          'Soft: a load stops answering it, its versions stay, and a rollback brings it back.',
      }),
    ),
    HttpApiEndpoint.post('rollback', '/projects/:projectId/secrets/:name/rollback', {
      params: secretParams,
      payload: Schema.Struct({ version: VersionSchema }),
      success: SecretSchema,
      error: [coded(NotFoundError), coded(NoAccessError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Make an earlier version current',
        description: 'Needs a write grant. No version is removed.',
      }),
    ),
    HttpApiEndpoint.get('versions', '/projects/:projectId/secrets/:name/versions', {
      params: secretParams,
      success: Schema.Struct({ versions: Schema.Array(SecretVersionSchema) }),
      error: [coded(NotFoundError), coded(NoAccessError)],
    }).annotateMerge(OpenApi.annotations({ summary: 'A secret’s history' })),
    HttpApiEndpoint.post('reveal', '/projects/:projectId/secrets/:name/reveal', {
      params: secretParams,
      payload: Schema.Struct({ version: VersionSchema }),
      success: SealedVersionSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(OpenApi.annotations({ exclude: true })),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Secrets' })) {}
