// The bin: deleted environments and secrets, kept for 30 days and then removed for good. Restoring is
// for whoever could delete it; removing one for good early is the owner's alone.

import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import {
  ActorSchema,
  EnvironmentNameSchema,
  OrgSlugSchema,
  SecretNameSchema,
  TimestampSchema,
  VersionSchema,
} from './fields.ts';
import { Authenticated, Credentials } from './guards.ts';

/** How long something deleted stays in the bin before the store removes it for good. */
export const BIN_DAYS = 30;

export const BinEnvironmentSchema = Schema.Struct({
  id: Schema.String,
  orgId: Schema.String,
  orgSlug: OrgSlugSchema,
  name: EnvironmentNameSchema,
  deletedAt: TimestampSchema,
  /** When it is removed for good, with its secrets, versions and grants. */
  purgeAt: TimestampSchema,
}).annotate({ identifier: 'BinEnvironment' });
export type BinEnvironment = typeof BinEnvironmentSchema.Type;

export const BinSecretSchema = Schema.Struct({
  orgId: Schema.String,
  orgSlug: OrgSlugSchema,
  environmentId: Schema.String,
  environmentName: EnvironmentNameSchema,
  name: SecretNameSchema,
  /** The newest version: what restoring it makes current, unless another is named. */
  latestVersion: VersionSchema,
  deletedAt: TimestampSchema,
  deletedBy: ActorSchema,
  /** When it is removed for good, with every version. */
  purgeAt: TimestampSchema,
}).annotate({ identifier: 'BinSecret' });
export type BinSecret = typeof BinSecretSchema.Type;

export class BinGroup extends HttpApiGroup.make('bin')
  .add(
    HttpApiEndpoint.get('list', '/bin', {
      success: Schema.Struct({
        environments: Schema.Array(BinEnvironmentSchema),
        /** Deleted secrets of environments that are not in the bin themselves. */
        secrets: Schema.Array(BinSecretSchema),
      }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'What is in the bin',
        description:
          'Newest first, across the caller’s orgs. The owner and a CLI login see all of it; a service account sees what is in the environments it holds a grant on. A secret is restored with a rollback; an environment, by the owner.',
      }),
    ),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Bin' })) {}
