// Who acted, as history keeps it: stored beside what they did, so it reads the same after a
// machine is renamed or revoked.
import { type Actor, type ActorIdentity, ActorSchema } from '@baymutt/api';
import * as Schema from 'effect/Schema';

export const ActorJsonSchema = Schema.fromJsonString(ActorSchema);

export const encodeActor = Schema.encodeSync(ActorJsonSchema);

export const actorOf = (identity: ActorIdentity): Actor =>
  identity._tag === 'Owner'
    ? { kind: 'owner', id: identity.accountId, name: 'Owner' }
    : { kind: 'machine', id: identity.credentialId, name: identity.name };

/** A value sealed through a paste link, by whoever held the link. */
export const LINK_ACTOR: Actor = { kind: 'link', id: 'paste-link', name: 'Paste link' };
