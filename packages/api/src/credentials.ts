// CLI logins and service accounts: what the CLI acts as. The owner approves a CLI login, which
// lists names and holds no environment; a service account comes from a request the owner approved
// (`requests.ts`) and holds the environments that request named.

import { coded } from '@internal/effect-api';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema';
import * as OpenApi from 'effect/http-api/OpenApi';
import * as Schema from 'effect/Schema';
import { AlreadyExistsError, LimitReachedError, NoAccessError, NotFoundError } from './errors.ts';
import {
  DescriptionSchema,
  ExpirySchema,
  HashSchema,
  IdSchema,
  KeyProofSchema,
  LabelSchema,
  OrgNamesKeyWrapSchema,
  OrgSlugSchema,
  PublicKeySchema,
  SealedNameSchema,
  SealedSchema,
  StoredEnvironmentNameSchema,
  TimestampSchema,
  VoucherSchema,
  WrapSchema,
} from './fields.ts';
import { Authenticated, Credentials, OwnerRequiredError } from './guards.ts';

export const CredentialGrantSchema = Schema.Struct({
  environmentId: Schema.String,
  orgId: Schema.String,
  orgSlug: OrgSlugSchema,
  environmentName: StoredEnvironmentNameSchema,
  environmentSealedName: Schema.NullOr(SealedNameSchema),
  canRead: Schema.Boolean,
  canWrite: Schema.Boolean,
}).annotate({ identifier: 'CredentialGrant' });

export const ServiceAccountSchema = Schema.Struct({
  id: Schema.String,
  name: LabelSchema,
  publicKey: PublicKeySchema,
  /**
   * The CLI login that asked for this one. Null for a CLI login: one `baymutt auth login` made and the
   * owner approved, which lists the names in every org of the person and holds no environment.
   */
  parentId: Schema.NullOr(Schema.String),
  description: Schema.NullOr(DescriptionSchema),
  /** When it stops working; null for never. An expired one is listed until it is revoked. */
  expiresAt: Schema.NullOr(TimestampSchema),
  /**
   * What the key is for, as it was asked for: a `service-account` is for another system (the ask
   * gave a command to pipe the key into), an `agent` key is for an agent's own work (kept in a
   * file). Null for a CLI login. Neither says whether it ends.
   */
  intent: Schema.NullOr(Schema.Literals(['service-account', 'agent'])),
  /** The owner's vault vouching for `publicKey`. Only a service account the owner paired has one, and only the owner can read it. */
  endorsement: Schema.NullOr(SealedSchema),
  /**
   * The login that made this one vouching for `publicKey`, to the caller: the owner, or that
   * login. Null for a login, and for any other caller.
   */
  keyVoucher: Schema.NullOr(VoucherSchema),
  createdAt: TimestampSchema,
  lastUsedAt: Schema.NullOr(TimestampSchema),
  grants: Schema.Array(CredentialGrantSchema),
}).annotate({ identifier: 'ServiceAccount' });
export type ServiceAccount = typeof ServiceAccountSchema.Type;

export const newCredential = {
  id: IdSchema,
  name: LabelSchema,
  publicKey: PublicKeySchema,
  bearerHash: HashSchema,
};

/** What `baymutt auth login` may say about a new CLI login. */
const aboutNewCredential = {
  description: Schema.optionalKey(DescriptionSchema),
  /** When it stops working. Omitted: never. */
  expiresAt: Schema.optionalKey(ExpirySchema),
};

/** What a login writes when it asks for a service account, so that the owner's browser and the new key learn each other's keys from it and not from the store. */
export const ServiceAccountVouchersSchema = Schema.Struct({
  /** Its public key, vouched for to the account's key: what the owner's browser trusts. */
  keyToOwner: VoucherSchema,
  /** Its public key, vouched for to its maker: what the maker trusts later. */
  keyToMaker: VoucherSchema,
  /** The account's public key, vouched for to it: so it takes the owner's proof of an environment's key. */
  accountKey: VoucherSchema,
}).annotate({ identifier: 'ServiceAccountVouchers' });
export type ServiceAccountVouchers = typeof ServiceAccountVouchersSchema.Type;

/** The access a service account holds on one environment, as it is to become. */
export const SetAccessPayloadSchema = Schema.Struct({
  canRead: Schema.Boolean,
  canWrite: Schema.Boolean,
  /** The environment key wrapped to it: needed when it gains read, and kept from before otherwise. */
  readWrap: Schema.optionalKey(WrapSchema),
  /** The granter's proof of the environment's public key: needed when it gains the environment, kept otherwise. */
  keyProof: Schema.optionalKey(KeyProofSchema),
}).annotate({ identifier: 'SetAccessPayload' });
export type SetAccessPayload = typeof SetAccessPayloadSchema.Type;

/** What the pairing link carries in its fragment, from the service account to the owner's browser. */
export const PairingRequestSchema = Schema.Struct({
  ...newCredential,
  /** What the terminal says it is for. A claim, shown as one. */
  ...aboutNewCredential,
  /** Seals the browser's answer, so the store cannot write one. */
  pairingSecret: HashSchema,
}).annotate({ identifier: 'PairingRequest' });
export type PairingRequest = typeof PairingRequestSchema.Type;

/** Who the caller is. A service account reads its `welcome` here once the owner has approved it. */
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
      /** Its maker vouching for the account's public key; null for a login. */
      accountVoucher: Schema.NullOr(VoucherSchema),
    }),
  ),
}).annotate({ identifier: 'Me' });
export type Me = typeof MeSchema.Type;

export class CredentialsGroup extends HttpApiGroup.make('credentials')
  .add(
    HttpApiEndpoint.get('me', '/me', { success: MeSchema }).annotateMerge(
      OpenApi.annotations({ summary: 'Who this key is' }),
    ),
    HttpApiEndpoint.get('list', '/credentials', {
      success: Schema.Struct({ credentials: Schema.Array(ServiceAccountSchema) }),
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'List CLI logins and service accounts',
        description:
          'The owner sees every one; a CLI login sees itself and the service accounts it asked for; a service account sees itself.',
      }),
    ),
    HttpApiEndpoint.post('pair', '/credentials/pair', {
      payload: Schema.Struct({
        ...newCredential,
        ...aboutNewCredential,
        endorsement: SealedSchema,
        welcome: SealedSchema,
        /** The names key of every org of the person whose names are sealed, written in the same batch as the approval. */
        namesKeyWraps: Schema.Array(OrgNamesKeyWrapSchema),
      }),
      success: ServiceAccountSchema.pipe(HttpApiSchema.status(201)),
      error: [coded(OwnerRequiredError), coded(AlreadyExistsError), coded(LimitReachedError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Approve a CLI login',
        description:
          'The owner’s approval of the link `baymutt auth login` prints. A CLI login lists the orgs, environments and secret names of the person’s orgs, makes paste links and requests, and holds no environment: it opens no value and writes none.',
      }),
    ),
    HttpApiEndpoint.put('setAccess', '/credentials/:id/grants/:environmentId', {
      params: { id: Schema.String, environmentId: Schema.String },
      payload: SetAccessPayloadSchema,
      success: ServiceAccountSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError), coded(NoAccessError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Change a service account’s access to an environment',
        description:
          'Owner only, for a service account. It keeps its key. A read is the environment key wrapped to it, which only a holder of the key can make. An environment in an org it did not reach before also needs that org’s names key wrapped to it (`orgs.putNamesKeyWrap`).',
      }),
    ),
    HttpApiEndpoint.delete('removeAccess', '/credentials/:id/grants/:environmentId', {
      params: { id: Schema.String, environmentId: Schema.String },
      success: ServiceAccountSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Take an environment away from a service account',
        description: 'Owner only. What it already read stays read.',
      }),
    ),
    HttpApiEndpoint.put('setExpiry', '/credentials/:id/expiry', {
      params: { id: Schema.String },
      payload: Schema.Struct({ expiresAt: Schema.NullOr(ExpirySchema) }),
      success: ServiceAccountSchema,
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Set when a CLI login or service account expires',
        description:
          'Owner only. Null for never; a later time revives one that has expired. Expiring, like revoking, does not take back what it already read.',
      }),
    ),
    HttpApiEndpoint.delete('revoke', '/credentials/:id', {
      params: { id: Schema.String },
      success: Schema.Struct({ revoked: Schema.Array(Schema.String) }),
      error: [coded(NotFoundError), coded(OwnerRequiredError)],
    }).annotateMerge(
      OpenApi.annotations({
        summary: 'Revoke a CLI login or service account',
        description:
          'The owner, or a CLI login for itself and the service accounts it asked for. Deletes its bearer and its wraps, and those of every service account it asked for. What it already read stays read: replace those values at their vendors.',
      }),
    ),
  )
  .middleware(Authenticated)
  .middleware(Credentials)
  .annotateMerge(OpenApi.annotations({ title: 'Service accounts' })) {}
