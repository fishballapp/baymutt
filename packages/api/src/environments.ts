// Environments: the unit of access, each in one org and addressed as `<slug>/<name>`. Each has a key
// pair; values are sealed to its public half, and a read grant is its private half wrapped to one
// reader.

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
  NoAccessError,
  NotFoundError,
} from './errors.ts';
import {
  ActorSchema,
  IdSchema,
  KeyProofSchema,
  LabelSchema,
  NameIndexSchema,
  OrgNamesKeyWrapSchema,
  OrgSlugSchema,
  PublicKeySchema,
  SealedNameSchema,
  SealedSchema,
  StoredEnvironmentNameSchema,
  TimestampSchema,
  WrapSchema,
} from './fields.ts';
import { Authenticated, Credentials, OwnerRequiredError } from './guards.ts';

export const EnvironmentSchema = Schema.Struct({
  id: Schema.String,
  orgId: Schema.String,
  /** The first segment of its address: `<orgSlug>/<name>`. */
  orgSlug: OrgSlugSchema,
  /** Its index under the org's names key: what the store keeps in place of the name. */
  name: StoredEnvironmentNameSchema,
  /**
   * The name, for whoever holds the names key. Null in an org whose names are not sealed yet;
   * missing too, for 0.8.0 only, from the store a deploy is about to replace.
   */
  sealedName: Schema.optionalKey(Schema.NullOr(SealedNameSchema)),
  publicKey: PublicKeySchema,
  keyVersion: Schema.Int,
  createdAt: TimestampSchema,
  createdBy: ActorSchema,
  secretCount: Schema.Int,
  /**
   * The proof of `publicKey` made for the calling credential: a client seals to the key the proof
   * opens to, never to `publicKey` as it stands here. Null for the owner, whose proof comes with
   * the member wrap, and for a caller with no grant on it.
   */
  keyProof: Schema.NullOr(KeyProofSchema),
  /** Whether the caller reads it: an owner of its org, or a key it was granted to. Never a CLI login. */
  canRead: Schema.Boolean,
  /**
   * Whether the caller writes it: an owner of its org, and no one else, since a key only reads.
   * Kept for the CLI and the plugin before 0.11.0, which require it to load.
   */
  canWrite: Schema.Boolean,
}).annotate({ identifier: 'Environment' });
export type Environment = typeof EnvironmentSchema.Type;

/** A key that reads the environment: a grant is a read, the environment key wrapped to the key. */
export const GrantSchema = Schema.Struct({
  credentialId: Schema.String,
  credentialName: LabelSchema,
  credentialPublicKey: PublicKeySchema,
  parentId: Schema.NullOr(Schema.String),
  endorsement: Schema.NullOr(SealedSchema),
  createdAt: TimestampSchema,
}).annotate({ identifier: 'Grant' });
export type Grant = typeof GrantSchema.Type;

const idParam = { id: Schema.String };

export class EnvironmentsGroup extends HttpApiGroup.make('environments')
  .add(
    HttpApiEndpoint.get('list', '/environments', {
      success: Schema.Struct({
        environments: Schema.Array(EnvironmentSchema),
        /**
         * The caller's copy of the names key of each org it reaches whose names are sealed. Missing,
         * for 0.8.0 only, from the store a deploy is about to replace.
         */
        namesKeys: Schema.optionalKey(Schema.Array(OrgNamesKeyWrapSchema)),
      }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List environments',
        description:
          'Across every org the caller reaches. The owner and a CLI login see every environment of the person’s orgs; a CLI login holds none of them, so each is listed with no proof and no access. A service account sees those it holds a grant on.',
      }),
    ),
    HttpApiEndpoint.post('create', '/environments', {
      payload: Schema.Struct({
        id: IdSchema,
        orgId: Schema.String,
        name: NameIndexSchema,
        sealedName: SealedNameSchema,
        publicKey: PublicKeySchema,
        /** The private key wrapped to the owner's account key: their member copy. */
        memberWrap: WrapSchema,
        /** The owner's proof of `publicKey`, to their own account. */
        memberProof: KeyProofSchema,
      }),
      success: EnvironmentSchema.pipe(HttpApiSchema.status(201)),
      error: [
        coded(AlreadyExistsError),
        coded(OwnerRequiredError),
        coded(LimitReachedError),
        coded(NotFoundError),
        coded(NamesNotSealedError),
      ],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Create an environment',
        description:
          'An owner of the org only, from the dashboard: the owner’s browser makes the key pair. A CLI login asks for one in an ask’s `environments` step.',
      }),
    ),
    HttpApiEndpoint.get('get', '/environments/:id', {
      params: idParam,
      success: EnvironmentSchema,
      error: [coded(NotFoundError), coded(NoAccessError)],
    }).annotateMerge(OpenApi.annotations({ summary: 'Get an environment' })),
    HttpApiEndpoint.delete('remove', '/environments/:id', {
      params: idParam,
      success: Schema.Struct({ deletedAt: TimestampSchema, purgeAt: TimestampSchema }),
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Delete an environment',
        description:
          'An owner of its org only. It goes to the bin: nothing can load or write it, and its name stays taken. The owner can restore it for 30 days; then it is removed for good with its secrets and grants.',
      }),
    ),
    HttpApiEndpoint.post('restore', '/environments/:id/restore', {
      params: idParam,
      success: EnvironmentSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError), coded(LimitReachedError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Restore an environment from the bin',
        description: 'Owner only, as deleting it is. It comes back with its secrets and grants.',
      }),
    ),
    // The owner's alone, from the dashboard with the vault open: it cannot be undone.
    HttpApiEndpoint.post('purge', '/environments/:id/purge', {
      params: idParam,
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(OpenApi.annotations({ exclude: true })),
    HttpApiEndpoint.get('memberWrap', '/environments/:id/member-wrap', {
      params: idParam,
      success: Schema.Struct({
        memberWrap: WrapSchema,
        memberProof: KeyProofSchema,
        keyVersion: Schema.Int,
        /** The CLI login that created the environment and made the proof, even if since revoked; null when the owner did. */
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
    HttpApiEndpoint.get('grants', '/environments/:id/grants', {
      params: idParam,
      success: Schema.Struct({ grants: Schema.Array(GrantSchema) }),
      error: [coded(NotFoundError), coded(NoAccessError)],
    }).annotateMerge(OpenApi.annotations({ summary: 'Which keys read an environment' })),
    HttpApiEndpoint.put('setGrant', '/environments/:id/grants/:credentialId', {
      params: { ...idParam, credentialId: Schema.String },
      payload: Schema.Struct({
        /** The environment key wrapped to the key: a grant is a read. */
        readWrap: WrapSchema,
        keyProof: KeyProofSchema,
        keyVersion: Schema.Int,
      }),
      success: GrantSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Let a key read an environment',
        description:
          'An owner of its org only: it is what lets a new party read. Refused for a CLI login, which holds no environment.',
      }),
    ),
    HttpApiEndpoint.delete('removeGrant', '/environments/:id/grants/:credentialId', {
      params: { ...idParam, credentialId: Schema.String },
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(OpenApi.annotations({ summary: 'Stop a key reading an environment' })),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Environments' })) {}
