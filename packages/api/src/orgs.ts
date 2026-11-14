// Orgs: what environments belong to. An environment is addressed as `<slug>/<name>`. Each org has
// one member for now, its owner.

import { coded } from '@internal/effect-api';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import { AlreadyExistsError, LimitReachedError, NotEmptyError, NotFoundError } from './errors.ts';
import { LabelSchema, OrgSlugSchema, TimestampSchema } from './fields.ts';
import { Authenticated, Credentials, OwnerRequiredError } from './guards.ts';

export const OrgSchema = Schema.Struct({
  id: Schema.String,
  name: LabelSchema,
  slug: OrgSlugSchema,
  /** Live environments; the bin's are not counted. */
  environmentCount: Schema.Int,
  createdAt: TimestampSchema,
}).annotate({ identifier: 'Org' });
export type Org = typeof OrgSchema.Type;

export class OrgsGroup extends HttpApiGroup.make('orgs')
  .add(
    HttpApiEndpoint.get('list', '/orgs', {
      success: Schema.Struct({ orgs: Schema.Array(OrgSchema) }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List orgs',
        description:
          'The owner and a CLI login see every org the person belongs to; a service account sees the orgs of the environments it holds.',
      }),
    ),
    HttpApiEndpoint.post('create', '/orgs', {
      payload: Schema.Struct({ name: LabelSchema, slug: OrgSlugSchema }),
      success: OrgSchema.pipe(HttpApiSchema.status(201)),
      error: [coded(AlreadyExistsError), coded(OwnerRequiredError), coded(LimitReachedError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Create an org',
        description:
          'A person signed in to the dashboard, vault open; never a CLI login or service account. The person becomes its owner. A slug is unique across baymutt.',
      }),
    ),
    HttpApiEndpoint.delete('remove', '/orgs/:id', {
      params: { id: Schema.String },
      success: Schema.Struct({ deleted: Schema.Boolean }),
      error: [coded(NotFoundError), coded(OwnerRequiredError), coded(NotEmptyError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Delete an org',
        description:
          'Owner only, from the dashboard, and only when it holds no environment, in the bin or not. Its activity goes with it.',
      }),
    ),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Orgs' })) {}
