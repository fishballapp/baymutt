// Who acted, as history keeps it: stored beside what they did, so it reads the same after a
// credential is renamed or revoked.
import { type Actor, type ActorIdentity, ActorSchema } from '@baymutt/api';
import * as Schema from 'effect/Schema';

export const ActorJsonSchema = Schema.fromJsonString(ActorSchema);

export const encodeActor = Schema.encodeSync(ActorJsonSchema);

export const actorOf = (identity: ActorIdentity): Actor =>
  identity._tag === 'Owner'
    ? { kind: 'owner', id: identity.accountId, name: 'Owner' }
    : { kind: 'credential', id: identity.credentialId, name: identity.name };
