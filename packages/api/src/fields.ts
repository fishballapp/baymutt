// The shapes more than one group's schemas are made of.

import * as Schema from 'effect/Schema';

/** Epoch milliseconds. */
export const TimestampSchema = Schema.Int.annotate({ description: 'Epoch milliseconds.' });

export const IdSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
).annotate({ description: 'A UUID the client makes.' });

/** A raw 32-byte X25519 public key. 43 characters carry 258 bits, so the last is limited to those whose spare bits are zero: one key has one spelling. */
export const PublicKeySchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u),
).annotate({ description: 'A raw X25519 public key, base64url without padding.' });

/** SHA-256 as base64url without padding. */
export const HashSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u),
).annotate({ description: 'A SHA-256 digest, base64url without padding.' });

/** What a person calls a service account, a passkey or an account. */
export const LabelSchema = Schema.String.check(Schema.isPattern(/^\S(.{0,58}\S)?$/u)).annotate({
  description: 'A name of 1 to 60 characters, with no space at either end.',
});

export const ProjectNameSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/u),
  Schema.isMaxLength(120),
).annotate({
  description:
    'Lower-case segments joined by `/`, such as `app/production`. Dev and production are separate projects.',
});

export const SecretNameSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u),
).annotate({ description: 'An environment variable name, such as `STRIPE_SECRET_KEY`.' });

/** A value may be 64 KiB; a box adds 60 bytes, and base64 a third. */
export const MAX_VALUE_BYTES = 65_536;

const base64 = (maxBytes: number) =>
  Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/u),
    Schema.isMaxLength(Math.ceil(maxBytes / 3) * 4),
  );

export const CiphertextSchema = base64(MAX_VALUE_BYTES + 60).annotate({
  description: 'A value sealed to the project’s public key, base64. The store cannot open it.',
});

/** A project private key (PKCS #8, base64url) in a box. */
export const WrapSchema = base64(256).annotate({
  description: 'The project’s private key sealed to one reader’s public key, base64.',
});

/** Something the owner’s vault sealed: a wrapped data key, the account key, an endorsement, a pairing welcome. */
export const SealedSchema = base64(512).annotate({
  description:
    'Sealed by the owner’s vault or for one service account, base64. The store cannot open it.',
});

/** A project's public key, vouched for to one reader by a party that reader trusts. */
export const KeyProofSchema = base64(128).annotate({
  description:
    'The project’s public key as the owner, or the service account that made the reader, vouches for it to that reader, base64. The store cannot make one.',
});

export const VersionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const ReasonSchema = Schema.String.check(Schema.isMaxLength(500)).annotate({
  description: 'Why, for the owner to read.',
});

/**
 * Who did something: the owner, or a service account by its credential. The kind `'machine'` is
 * the wire and stored name of a service account (audit rows hold it), kept so they stay readable.
 */
export const ActorSchema = Schema.Struct({
  kind: Schema.Literals(['owner', 'machine', 'link']),
  id: Schema.String,
  name: Schema.String,
}).annotate({ identifier: 'Actor' });
export type Actor = typeof ActorSchema.Type;
