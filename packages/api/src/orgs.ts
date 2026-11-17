// Orgs: what environments belong to. An environment is addressed as `<slug>/<name>`. Each org has
// one member for now, its owner.

import { coded } from '@internal/effect-api';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import {
  AlreadyExistsError,
  LimitReachedError,
  NamesNotSealedError,
  NotEmptyError,
  NotFoundError,
} from './errors.ts';
import {
  LabelSchema,
  NameIndexSchema,
  NamesKeyWrapSchema,
  OrgSlugSchema,
  SealedNameSchema,
  StoredEnvironmentNameSchema,
  StoredSecretNameSchema,
  TimestampSchema,
} from './fields.ts';
import { Authenticated, Credentials, OwnerRequiredError } from './guards.ts';

export const OrgSchema = Schema.Struct({
  id: Schema.String,
  name: LabelSchema,
  slug: OrgSlugSchema,
  /** Live environments; the bin's are not counted. */
  environmentCount: Schema.Int,
  /**
   * Whether the org has a names key. Until it does, its names are stored as written, and nothing
   * with a new name can be made in it: the owner's dashboard seals them when it is next opened.
   */
  areNamesSealed: Schema.Boolean,
  createdAt: TimestampSchema,
}).annotate({ identifier: 'Org' });
export type Org = typeof OrgSchema.Type;

/** One reader's copy of an org's names key. A reader is the owner's account, a CLI login or a service account. */
export const NamesKeyReaderWrapSchema = Schema.Struct({
  readerId: Schema.String,
  wrap: NamesKeyWrapSchema,
}).annotate({ identifier: 'NamesKeyReaderWrap' });

/** Every name an org still stores as written: what the owner's browser seals, once. */
export const UnsealedNamesSchema = Schema.Struct({
  /** Every environment of the org, the bin's and those only the activity still names included. */
  environments: Schema.Array(
    Schema.Struct({ id: Schema.String, name: StoredEnvironmentNameSchema }),
  ),
  /** Every secret name, per environment: live, in the bin, on a paste link or only in the activity. */
  secrets: Schema.Array(
    Schema.Struct({ environmentId: Schema.String, name: StoredSecretNameSchema }),
  ),
}).annotate({ identifier: 'UnsealedNames' });
export type UnsealedNames = typeof UnsealedNamesSchema.Type;

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
    // The owner's alone, from the dashboard with the vault open.
    HttpApiEndpoint.get('unsealedNames', '/orgs/:id/unsealed-names', {
      params: { id: Schema.String },
      success: UnsealedNamesSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(OpenApi.annotations({ exclude: true })),
    HttpApiEndpoint.post('sealNames', '/orgs/:id/seal-names', {
      params: { id: Schema.String },
      payload: Schema.Struct({
        /** The new names key, wrapped to the owner's account, every CLI login, and every key of this org: no key of another org. */
        wraps: Schema.Array(NamesKeyReaderWrapSchema),
        environments: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            name: NameIndexSchema,
            sealedName: SealedNameSchema,
          }),
        ),
        secrets: Schema.Array(
          Schema.Struct({
            environmentId: Schema.String,
            /** The name as the store holds it now. */
            unsealedName: StoredSecretNameSchema,
            name: NameIndexSchema,
            sealedName: SealedNameSchema,
          }),
        ),
      }),
      success: OrgSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError), coded(AlreadyExistsError)],
    }).annotateMerge(OpenApi.annotations({ exclude: true })),
    HttpApiEndpoint.put('putNamesKeyWrap', '/orgs/:id/names-key-wraps/:readerId', {
      params: { id: Schema.String, readerId: Schema.String },
      payload: Schema.Struct({ wrap: NamesKeyWrapSchema }),
      success: Schema.Struct({ readerId: Schema.String }),
      error: [coded(NotFoundError), coded(OwnerRequiredError), coded(NamesNotSealedError)],
    }).annotateMerge(OpenApi.annotations({ exclude: true })),
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
