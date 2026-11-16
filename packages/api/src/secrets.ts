// Secrets: named values in an environment. Every write adds a version and nothing is overwritten, which
// is what makes it safe for a credential to write without asking.

import { coded } from '@internal/effect-api';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import {
  LimitReachedError,
  NamesNotSealedError,
  NoAccessError,
  NotFoundError,
  VersionConflictError,
} from './errors.ts';
import {
  ActorSchema,
  CiphertextSchema,
  PublicKeySchema,
  SealedNameSchema,
  StoredEnvironmentNameSchema,
  StoredSecretNameSchema,
  TimestampSchema,
  VersionSchema,
  WrapSchema,
} from './fields.ts';
import { Authenticated, Credentials, OwnerRequiredError } from './guards.ts';

export const SecretSchema = Schema.Struct({
  /** Its index under the org's names key: what the store files it under, and what a route names it by. */
  name: StoredSecretNameSchema,
  /** The name, for whoever holds the names key. Null only in an org whose names are not sealed yet. */
  sealedName: Schema.NullOr(SealedNameSchema),
  /** The version a load answers with; null once deleted, while it is in the bin. */
  currentVersion: Schema.NullOr(VersionSchema),
  /** The highest version ever written: the next write is one above it. */
  latestVersion: VersionSchema,
  /** Of the current version's ciphertext, in bytes: the value's length plus 60. */
  size: Schema.NullOr(Schema.Int),
  updatedAt: TimestampSchema,
  updatedBy: ActorSchema,
  /** When a deleted secret leaves the bin for good, every version with it; null while it is live. */
  purgeAt: Schema.NullOr(TimestampSchema),
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

/**
 * Everything a reader needs to open an environment's current values, in one answer. `sealedName`
 * may be missing as well as null, for 0.8.0 only: a deploy loads its secrets with the new client
 * from the store it is about to replace, which answers without it.
 */
export const BundleSchema = Schema.Struct({
  environment: Schema.Struct({
    id: Schema.String,
    name: StoredEnvironmentNameSchema,
    sealedName: Schema.optionalKey(Schema.NullOr(SealedNameSchema)),
    publicKey: PublicKeySchema,
    keyVersion: Schema.Int,
  }),
  /** The environment's private key wrapped to the caller, and the reader id it is bound to. */
  wrap: WrapSchema,
  readerId: Schema.String,
  secrets: Schema.Array(
    Schema.Struct({
      name: StoredSecretNameSchema,
      sealedName: Schema.optionalKey(Schema.NullOr(SealedNameSchema)),
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

const environmentParam = { environmentId: Schema.String };
const secretParams = { ...environmentParam, name: StoredSecretNameSchema };

/** One sealed value and the slot it was sealed for. */
export const SealedValuePayloadSchema = Schema.Struct({
  /** One above the secret's latest version (1 for a new name): the slot the ciphertext was sealed for. */
  version: VersionSchema,
  keyVersion: Schema.Int,
  ciphertext: CiphertextSchema,
});

export const WriteSecretPayloadSchema = Schema.Struct({
  ...SealedValuePayloadSchema.fields,
  /** The name, sealed with the org's names key. Needed when the name is new; ignored otherwise. */
  sealedName: Schema.optionalKey(SealedNameSchema),
});

export class SecretsGroup extends HttpApiGroup.make('secrets')
  .add(
    HttpApiEndpoint.get('list', '/environments/:environmentId/secrets', {
      params: environmentParam,
      success: Schema.Struct({ secrets: Schema.Array(SecretSchema) }),
      error: [coded(NotFoundError), coded(NoAccessError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List an environment’s secrets',
        description:
          'Sealed names, versions and sizes; never a value. Either grant is enough, and so is being a CLI login of the environment’s org.',
      }),
    ),
    HttpApiEndpoint.get('bundle', '/environments/:environmentId/bundle', {
      params: environmentParam,
      success: BundleSchema,
      error: [coded(NotFoundError), coded(NoAccessError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Load an environment',
        description:
          'Every current value as ciphertext, with the environment key wrapped to the caller. Needs a read grant.',
      }),
    ),
    HttpApiEndpoint.put('write', '/environments/:environmentId/secrets/:name', {
      params: secretParams,
      payload: WriteSecretPayloadSchema,
      success: SecretSchema,
      error: [
        coded(NotFoundError),
        coded(NoAccessError),
        coded(VersionConflictError),
        coded(LimitReachedError),
        coded(NamesNotSealedError),
      ],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Write a secret',
        description:
          'Adds a version and makes it current. Needs a write grant, and no key. A new name comes with `sealedName`, and is refused in an org whose names are not sealed yet.',
      }),
    ),
    HttpApiEndpoint.delete('remove', '/environments/:environmentId/secrets/:name', {
      params: secretParams,
      success: SecretSchema,
      error: [coded(NotFoundError), coded(NoAccessError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Delete a secret',
        description:
          'It goes to the bin: a load stops answering it, and a rollback brings it back with every version. After 30 days in the bin it is removed for good.',
      }),
    ),
    HttpApiEndpoint.post('rollback', '/environments/:environmentId/secrets/:name/rollback', {
      params: secretParams,
      payload: Schema.Struct({
        version: VersionSchema,
        /** A restore from the bin: refused when the secret is no longer in it. */
        fromBin: Schema.optionalKey(Schema.Boolean),
      }),
      success: SecretSchema,
      error: [coded(NotFoundError), coded(NoAccessError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Make an earlier version current',
        description:
          'Needs a write grant. No version is removed. On a deleted secret, it is how one leaves the bin; `fromBin` refuses when it has already left.',
      }),
    ),
    HttpApiEndpoint.get('versions', '/environments/:environmentId/secrets/:name/versions', {
      params: secretParams,
      success: Schema.Struct({ versions: Schema.Array(SecretVersionSchema) }),
      error: [coded(NotFoundError), coded(NoAccessError)],
    }).annotateMerge(OpenApi.annotations({ summary: 'A secret’s history' })),
    HttpApiEndpoint.post('reveal', '/environments/:environmentId/secrets/:name/reveal', {
      params: secretParams,
      payload: Schema.Struct({ version: VersionSchema }),
      success: SealedVersionSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(OpenApi.annotations({ exclude: true })),
    // The owner's alone, from the dashboard with the vault open: it cannot be undone.
    HttpApiEndpoint.post('purge', '/environments/:environmentId/secrets/:name/purge', {
      params: secretParams,
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(OpenApi.annotations({ exclude: true })),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Secrets' })) {}
