// The bin: deleted projects and secrets, kept for 30 days and then removed for good. Restoring is
// for whoever could delete it; removing one for good early is the owner's alone.

import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import {
  ActorSchema,
  ProjectNameSchema,
  SecretNameSchema,
  TimestampSchema,
  VersionSchema,
} from './fields.ts';
import { Authenticated, Credentials } from './guards.ts';

/** How long something deleted stays in the bin before the store removes it for good. */
export const BIN_DAYS = 30;

export const BinProjectSchema = Schema.Struct({
  id: Schema.String,
  name: ProjectNameSchema,
  deletedAt: TimestampSchema,
  /** When it is removed for good, with its secrets, versions and grants. */
  purgeAt: TimestampSchema,
}).annotate({ identifier: 'BinProject' });
export type BinProject = typeof BinProjectSchema.Type;

export const BinSecretSchema = Schema.Struct({
  projectId: Schema.String,
  projectName: ProjectNameSchema,
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
        projects: Schema.Array(BinProjectSchema),
        /** Deleted secrets of projects that are not in the bin themselves. */
        secrets: Schema.Array(BinSecretSchema),
      }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'What is in the bin',
        description:
          'Newest first. The owner and a login see the whole account; any other service account sees what is in the projects it holds a grant on. A secret is restored with a rollback; a project, by the owner.',
      }),
    ),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Bin' })) {}
