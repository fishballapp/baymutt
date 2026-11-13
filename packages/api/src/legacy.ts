// What 0.5.0 clients asked, and what they got: the two routes a load calls, in the shapes 0.5.0
// sent them (`projects`, a bundle's `project`). The deploy loads baymutt's own secrets through the
// plugin it has just built, from the Worker that is still live, and a later one from this Worker
// with the plugin that deploy built: so the load path stays on these two routes for one release.
// The release after, `apps/cli/src/legacy-load.ts` and this file are deleted.

import { coded } from '@internal/effect-api';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import { NoAccessError, NotFoundError } from './errors.ts';
import {
  ActorSchema,
  CiphertextSchema,
  EnvironmentNameSchema,
  KeyProofSchema,
  PublicKeySchema,
  SecretNameSchema,
  TimestampSchema,
  VersionSchema,
  WrapSchema,
} from './fields.ts';
import { Authenticated, Credentials } from './guards.ts';

/** An environment as 0.5.0 listed it. */
export const LegacyProjectSchema = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  name: EnvironmentNameSchema,
  publicKey: PublicKeySchema,
  keyVersion: Schema.Int,
  createdAt: TimestampSchema,
  createdBy: ActorSchema,
  secretCount: Schema.Int,
  keyProof: Schema.NullOr(KeyProofSchema),
  canRead: Schema.Boolean,
  canWrite: Schema.Boolean,
}).annotate({ identifier: 'LegacyProject' });
export type LegacyProject = typeof LegacyProjectSchema.Type;

/** An environment's bundle as 0.5.0 answered it: the environment is `project`. */
export const LegacyBundleSchema = Schema.Struct({
  project: Schema.Struct({
    id: Schema.String,
    accountId: Schema.String,
    name: EnvironmentNameSchema,
    publicKey: PublicKeySchema,
    keyVersion: Schema.Int,
  }),
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
}).annotate({ identifier: 'LegacyBundle' });
export type LegacyBundle = typeof LegacyBundleSchema.Type;

export class LegacyLoadGroup extends HttpApiGroup.make('legacyLoad')
  .add(
    HttpApiEndpoint.get('list', '/projects', {
      success: Schema.Struct({ projects: Schema.Array(LegacyProjectSchema) }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List environments, as 0.5.0 asked',
        description:
          'Deprecated: the same as `GET /environments`, in the shape 0.5.0 clients read.',
      }),
    ),
    HttpApiEndpoint.get('bundle', '/projects/:projectId/bundle', {
      params: { projectId: Schema.String },
      success: LegacyBundleSchema,
      error: [coded(NotFoundError), coded(NoAccessError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Load an environment, as 0.5.0 asked',
        description:
          'Deprecated: the same as `GET /environments/:environmentId/bundle`, in the shape 0.5.0 clients read.',
      }),
    ),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Legacy load' })) {}
