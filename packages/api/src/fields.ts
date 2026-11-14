// The shapes more than one group's schemas are made of.

import * as Schema from 'effect/Schema';

/** Epoch milliseconds. */
export const TimestampSchema = Schema.Int.annotate({ description: 'Epoch milliseconds.' });

/** When a service account stops working, as a client may ask for it: a time a date can hold. */
export const ExpirySchema = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 253_402_300_799_999 }),
).annotate({ description: 'Epoch milliseconds, no later than the year 9999.' });

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

/** What a person calls a service account, a passkey, an account or an org. */
export const LabelSchema = Schema.String.check(Schema.isPattern(/^\S(.{0,58}\S)?$/u)).annotate({
  description: 'A name of 1 to 60 characters, with no space at either end.',
});

/** What a service account is for, in its maker's words. Stored as written: the store can read it, like a name. */
export const DescriptionSchema = Schema.String.check(
  Schema.isPattern(/^\S(.{0,138}\S)?$/u),
).annotate({
  description:
    'What it is for, 1 to 140 characters with no space at either end. Stored readable, like the name: never a secret.',
});

/** An org's handle, the first segment of every environment's address: `<slug>/<name>`. */
export const OrgSlugSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u),
).annotate({
  description:
    'Lower-case letters, digits and hyphens, 1 to 40 characters, starting and ending with a letter or digit, such as `fishball`.',
});

/** An environment's name within its org. */
export const EnvironmentNameSchema = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/u),
  Schema.isMaxLength(120),
).annotate({
  description:
    'Lower-case segments joined by `/`, such as `app/production`. Unique within its org.',
});

export const SecretNameSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u),
).annotate({
  description:
    'Letters, digits and underscores, not starting with a digit, such as `STRIPE_SECRET_KEY`.',
});

/** A value may be 64 KiB; a box adds 60 bytes, and base64 a third. */
export const MAX_VALUE_BYTES = 65_536;

const base64 = (maxBytes: number) =>
  Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/u),
    Schema.isMaxLength(Math.ceil(maxBytes / 3) * 4),
  );

export const CiphertextSchema = base64(MAX_VALUE_BYTES + 60).annotate({
  description: 'A value sealed to the environment’s public key, base64. The store cannot open it.',
});

/** An environment private key (PKCS #8, base64url) in a box. */
export const WrapSchema = base64(256).annotate({
  description: 'The environment’s private key sealed to one reader’s public key, base64.',
});

/** Something the owner’s vault sealed: a wrapped data key, the account key, an endorsement, a pairing welcome. */
export const SealedSchema = base64(512).annotate({
  description:
    'Sealed by the owner’s vault or for one credential, base64. The store cannot open it.',
});

/** An environment's public key, vouched for to one reader by a party that reader trusts. */
export const KeyProofSchema = base64(128).annotate({
  description:
    'The environment’s public key as the owner, or the CLI login that made the reader, vouches for it to that reader, base64. The store cannot make one.',
});

/** A public key one party vouches for to another: a service account's, or the account's. */
export const VoucherSchema = base64(128).annotate({
  description:
    'A public key the login that made a service account vouches for to one reader, base64. The store cannot make one.',
});

export const VersionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const ReasonSchema = Schema.String.check(Schema.isMaxLength(500)).annotate({
  description: 'Why, for the owner to read.',
});

/**
 * Who did something: the owner, a credential (a CLI login or a service account), a paste link, or
 * the store itself (`'system'`: the bin removing what was deleted 30 days ago).
 */
export const ActorSchema = Schema.Struct({
  kind: Schema.Literals(['owner', 'credential', 'link', 'system']),
  id: Schema.String,
  name: Schema.String,
}).annotate({ identifier: 'Actor' });
export type Actor = typeof ActorSchema.Type;
