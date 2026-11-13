// Projects: the unit of access. Each has a key pair; values are sealed to its public half, and a
// read grant is its private half wrapped to one reader.

import { coded } from '@internal/effect-api';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import { AlreadyExistsError, LimitReachedError, NoAccessError, NotFoundError } from './errors.ts';
import {
  ActorSchema,
  IdSchema,
  KeyProofSchema,
  LabelSchema,
  ProjectNameSchema,
  PublicKeySchema,
  SealedSchema,
  TimestampSchema,
  WrapSchema,
} from './fields.ts';
import { Authenticated, Credentials, OwnerRequiredError } from './guards.ts';

export const ProjectSchema = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  name: ProjectNameSchema,
  publicKey: PublicKeySchema,
  keyVersion: Schema.Int,
  createdAt: TimestampSchema,
  createdBy: ActorSchema,
  secretCount: Schema.Int,
  /**
   * The proof of `publicKey` made for the calling service account: a client seals to the key the proof
   * opens to, never to `publicKey` as it stands here. Null for the owner, whose proof comes with
   * the owner wrap.
   */
  keyProof: Schema.NullOr(KeyProofSchema),
  /** What the caller may do. The owner may always do both. */
  canRead: Schema.Boolean,
  canWrite: Schema.Boolean,
}).annotate({ identifier: 'Project' });
export type Project = typeof ProjectSchema.Type;

export const GrantSchema = Schema.Struct({
  credentialId: Schema.String,
  credentialName: LabelSchema,
  credentialPublicKey: PublicKeySchema,
  parentId: Schema.NullOr(Schema.String),
  endorsement: Schema.NullOr(SealedSchema),
  canRead: Schema.Boolean,
  canWrite: Schema.Boolean,
  createdAt: TimestampSchema,
}).annotate({ identifier: 'Grant' });
export type Grant = typeof GrantSchema.Type;

const idParam = { id: Schema.String };

export class ProjectsGroup extends HttpApiGroup.make('projects')
  .add(
    HttpApiEndpoint.get('list', '/projects', {
      success: Schema.Struct({ projects: Schema.Array(ProjectSchema) }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List projects',
        description:
          'The owner sees every project. A login sees every project too, and `keyProof` is null on one the owner’s dashboard has not wrapped to it yet; any other service account sees those it holds a grant on.',
      }),
    ),
    HttpApiEndpoint.post('create', '/projects', {
      payload: Schema.Struct({
        id: IdSchema,
        name: ProjectNameSchema,
        publicKey: PublicKeySchema,
        /** The private key wrapped to the account's public key: the owner can read every project. */
        ownerWrap: WrapSchema,
        /** The creator's proof of `publicKey`, to the account. */
        ownerProof: KeyProofSchema,
        /** The private key wrapped to the service account creating it, and its proof to itself. Null when the owner creates it. */
        creatorWrap: Schema.NullOr(WrapSchema),
        creatorProof: Schema.NullOr(KeyProofSchema),
        /** Owner only: read and write for each login, the key wrapped and vouched for by the owner's vault. */
        loginGrants: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              credentialId: Schema.String,
              readWrap: WrapSchema,
              keyProof: KeyProofSchema,
            }),
          ),
        ),
      }),
      success: ProjectSchema.pipe(HttpApiSchema.status(201)),
      error: [coded(AlreadyExistsError), coded(OwnerRequiredError), coded(LimitReachedError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Create a project',
        description: 'Its creator makes the key pair and gets read and write on it.',
      }),
    ),
    HttpApiEndpoint.get('get', '/projects/:id', {
      params: idParam,
      success: ProjectSchema,
      error: [coded(NotFoundError), coded(NoAccessError)],
    }).annotateMerge(OpenApi.annotations({ summary: 'Get a project' })),
    HttpApiEndpoint.delete('remove', '/projects/:id', {
      params: idParam,
      success: Schema.Struct({ deletedAt: TimestampSchema, purgeAt: TimestampSchema }),
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Delete a project',
        description:
          'Owner only. It goes to the bin: nothing can load or write it, and its name stays taken. The owner can restore it for 30 days; then it is removed for good with its secrets and grants.',
      }),
    ),
    HttpApiEndpoint.post('restore', '/projects/:id/restore', {
      params: idParam,
      success: ProjectSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError), coded(LimitReachedError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Restore a project from the bin',
        description: 'Owner only, as deleting it is. It comes back with its secrets and grants.',
      }),
    ),
    // The owner's alone, from the dashboard with the vault open: it cannot be undone.
    HttpApiEndpoint.post('purge', '/projects/:id/purge', {
      params: idParam,
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(OpenApi.annotations({ exclude: true })),
    HttpApiEndpoint.get('ownerWrap', '/projects/:id/owner-wrap', {
      params: idParam,
      success: Schema.Struct({
        ownerWrap: WrapSchema,
        ownerProof: KeyProofSchema,
        keyVersion: Schema.Int,
        /** The service account that created the project and made the proof, even if since revoked; null when the owner did. */
        creator: Schema.NullOr(
          Schema.Struct({
            id: Schema.String,
            publicKey: PublicKeySchema,
            endorsement: Schema.NullOr(SealedSchema),
          }),
        ),
      }),
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(OpenApi.annotations({ exclude: true })),
    HttpApiEndpoint.get('grants', '/projects/:id/grants', {
      params: idParam,
      success: Schema.Struct({ grants: Schema.Array(GrantSchema) }),
      error: [coded(NotFoundError), coded(NoAccessError)],
    }).annotateMerge(OpenApi.annotations({ summary: 'Who can read or write a project' })),
    HttpApiEndpoint.put('setGrant', '/projects/:id/grants/:credentialId', {
      params: { ...idParam, credentialId: Schema.String },
      payload: Schema.Struct({
        canWrite: Schema.Boolean,
        /** The project key wrapped to the service account, or null for no read. */
        readWrap: Schema.NullOr(WrapSchema),
        keyProof: KeyProofSchema,
        keyVersion: Schema.Int,
      }),
      success: GrantSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Grant a service account access',
        description: 'Owner only: it is what lets a new party read.',
      }),
    ),
    HttpApiEndpoint.delete('removeGrant', '/projects/:id/grants/:credentialId', {
      params: { ...idParam, credentialId: Schema.String },
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(OpenApi.annotations({ summary: 'Remove a service account’s access' })),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Projects' })) {}
