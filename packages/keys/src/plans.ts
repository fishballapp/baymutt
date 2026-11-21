/**
 * What passes between a CLI login and the owner over a plan, through a store that may read and make
 * neither. Both are vouched boxes, so opening one proves which of the two sealed it:
 *
 * ```
 * proposedValue = vouched(loginPriv → accountPub, value, info "baymutt-proposed-value",
 *                         aad = [planId, stepIndex, environmentId, name])         → stored on the item
 * hint          = vouched(loginPriv → accountPub, text, info "baymutt-paste-hint",
 *                         aad = [planId, stepIndex, environmentId, name])         → stored on the item
 * note          = vouched(accountPriv → loginPub, text, info "baymutt-decision-note",
 *                         aad = [planId, stepIndex, decision])                    → stored on the step
 * ```
 *
 * A login holds no environment, so it cannot seal a value to one: it seals what it proposes to the
 * account key it pinned at pairing, and the owner's browser, trusting the login through the vault's
 * endorsement, opens it and seals it to the environment on approval. A paste item's hint, where the
 * owner finds the value, is sealed the same way under its own label: an agent may write a value
 * into it, and the store must not be able to read that either. The binding names the secret's
 * plain name, as a value's does, so the store cannot move a proposal or a hint to another plan,
 * step, environment or secret, nor pass one off as the other, nor a note to another step or plan,
 * nor show a note beside the opposite decision.
 *
 * Either holder of a vouched box's two keys can make it: each side knows the other wrote one
 * because it did not write it itself. A note proves its text, its step and the decision it came
 * with, and nothing about what the store then did.
 */

import {
  decodePublicKey,
  fromBase64,
  fromUtf8,
  openVouched,
  type PrivateKey,
  sealVouched,
  toBase64,
  utf8,
  VaultError,
} from '@internal/zk-vault';
import { tuple } from './encoding.ts';

const PROPOSED_VALUE_INFO = 'baymutt-proposed-value';
const NOTE_INFO = 'baymutt-decision-note';
const HINT_INFO = 'baymutt-paste-hint';

/** The API's `MAX_VALUE_BYTES`: a proposal becomes a value, so it is held to the same size. */
const MAX_PROPOSED_VALUE_BYTES = 65_536;

export const MAX_NOTE_BYTES = 2048;

/** A hint is at most 500 characters (`ReasonSchema`), and each is at most 3 bytes of UTF-8. */
export const MAX_HINT_BYTES = 1500;

/**
 * The item a proposed value or a hint belongs to: a step of a plan (its index, from 0) names each
 * secret once. `name` is the secret's plain name, never its index.
 */
export type ItemSlot = {
  readonly planId: string;
  readonly stepIndex: number;
  readonly environmentId: string;
  readonly name: string;
};

/** The step a note answers (its index in the plan, from 0) and what the owner decided on it. */
export type NoteStep = {
  readonly planId: string;
  readonly stepIndex: number;
  readonly decision: 'approved' | 'rejected';
};

const itemAad = ({ planId, stepIndex, environmentId, name }: ItemSlot) =>
  tuple(planId, String(stepIndex), environmentId, name);

const noteAad = ({ planId, stepIndex, decision }: NoteStep) =>
  tuple(planId, String(stepIndex), decision);

const utf8Within = (text: string, maxBytes: number, what: string): Uint8Array<ArrayBuffer> => {
  const bytes = utf8(text);
  if (bytes.length > maxBytes) {
    throw new VaultError('malformed', `${what} is ${bytes.length} bytes; at most ${maxBytes}`);
  }
  return bytes;
};

/** A login proposes `value` for the owner. `accountPublicKey` must be the one it pinned at pairing. */
export const sealProposedValue = async ({
  loginKey,
  accountPublicKey,
  slot,
  value,
}: {
  readonly loginKey: PrivateKey;
  readonly accountPublicKey: string;
  readonly slot: ItemSlot;
  readonly value: string;
}): Promise<string> =>
  toBase64(
    await sealVouched({
      sender: loginKey,
      recipient: decodePublicKey(accountPublicKey, 'the account public key'),
      info: PROPOSED_VALUE_INFO,
      aad: itemAad(slot),
      plaintext: utf8Within(value, MAX_PROPOSED_VALUE_BYTES, `the value proposed for ${slot.name}`),
    }),
  );

/**
 * The value a login proposed, opened in the owner's browser. `loginPublicKey` must come from the
 * vault's endorsement of that login: refused unless its holder sealed this, for this slot.
 */
export const openProposedValue = async ({
  accountKey,
  loginPublicKey,
  slot,
  ciphertext,
}: {
  readonly accountKey: PrivateKey;
  readonly loginPublicKey: string;
  readonly slot: ItemSlot;
  readonly ciphertext: string;
}): Promise<string> => {
  const what = `the value proposed for ${slot.name}`;
  return fromUtf8(
    await openVouched({
      recipient: accountKey,
      sender: decodePublicKey(loginPublicKey, 'the login public key'),
      info: PROPOSED_VALUE_INFO,
      aad: itemAad(slot),
      box: fromBase64(ciphertext, what),
      what,
    }),
  );
};

/**
 * A login tells the owner where to find the value to paste for `slot`. `accountPublicKey` must be
 * the one it pinned at pairing.
 */
export const sealHint = async ({
  loginKey,
  accountPublicKey,
  slot,
  hint,
}: {
  readonly loginKey: PrivateKey;
  readonly accountPublicKey: string;
  readonly slot: ItemSlot;
  readonly hint: string;
}): Promise<string> =>
  toBase64(
    await sealVouched({
      sender: loginKey,
      recipient: decodePublicKey(accountPublicKey, 'the account public key'),
      info: HINT_INFO,
      aad: itemAad(slot),
      plaintext: utf8Within(hint, MAX_HINT_BYTES, `the hint for ${slot.name}`),
    }),
  );

/**
 * A paste item's hint, opened in the owner's browser. `loginPublicKey` must come from the vault's
 * endorsement of that login: refused unless its holder sealed this, for this slot.
 */
export const openHint = async ({
  accountKey,
  loginPublicKey,
  slot,
  ciphertext,
}: {
  readonly accountKey: PrivateKey;
  readonly loginPublicKey: string;
  readonly slot: ItemSlot;
  readonly ciphertext: string;
}): Promise<string> => {
  const what = `the hint for ${slot.name}`;
  return fromUtf8(
    await openVouched({
      recipient: accountKey,
      sender: decodePublicKey(loginPublicKey, 'the login public key'),
      info: HINT_INFO,
      aad: itemAad(slot),
      box: fromBase64(ciphertext, what),
      what,
    }),
  );
};

/** The owner's note on a step, to the login that made the plan. `loginPublicKey` must come from the vault's endorsement. */
export const sealNote = async ({
  accountKey,
  loginPublicKey,
  step,
  note,
}: {
  readonly accountKey: PrivateKey;
  readonly loginPublicKey: string;
  readonly step: NoteStep;
  readonly note: string;
}): Promise<string> =>
  toBase64(
    await sealVouched({
      sender: accountKey,
      recipient: decodePublicKey(loginPublicKey, 'the login public key'),
      info: NOTE_INFO,
      aad: noteAad(step),
      plaintext: utf8Within(note, MAX_NOTE_BYTES, 'the note'),
    }),
  );

/** The owner's note, opened by the login. Refused unless the account key it pinned at pairing sealed it, for this step. */
export const openNote = async ({
  loginKey,
  accountPublicKey,
  step,
  ciphertext,
}: {
  readonly loginKey: PrivateKey;
  readonly accountPublicKey: string;
  readonly step: NoteStep;
  readonly ciphertext: string;
}): Promise<string> =>
  fromUtf8(
    await openVouched({
      recipient: loginKey,
      sender: decodePublicKey(accountPublicKey, 'the account public key'),
      info: NOTE_INFO,
      aad: noteAad(step),
      box: fromBase64(ciphertext, 'the note'),
      what: 'the note',
    }),
  );
