-- The whole schema, in one migration.
--
-- Better Auth's tables first: user / session / account / verification, the passkey plugin's, and
-- the organization plugin's (organization / member / invitation, and `session.activeOrganizationId`).
-- They are the shape better-auth 1.7.5 expects: its own getMigrations output for the plugins
-- src/platform/better-auth.ts installs. Invitations, and members other than an org's owner, are not
-- used yet.

create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade, "activeOrganizationId" text);

create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create table "passkey" ("id" text not null primary key, "name" text, "publicKey" text not null, "userId" text not null references "user" ("id") on delete cascade, "credentialID" text not null, "counter" integer not null, "deviceType" text not null, "backedUp" integer not null, "transports" text, "createdAt" date, "aaguid" text);

create table "organization" ("id" text not null primary key, "name" text not null, "slug" text not null unique, "logo" text, "createdAt" date not null, "metadata" text);

create table "member" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "role" text not null, "createdAt" date not null);

create table "invitation" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "email" text not null, "role" text, "status" text not null, "expiresAt" date not null, "createdAt" date not null, "inviterId" text not null references "user" ("id") on delete cascade);

create table "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

create index "passkey_userId_idx" on "passkey" ("userId");

create index "passkey_credentialID_idx" on "passkey" ("credentialID");

create index "member_organizationId_idx" on "member" ("organizationId");

create index "member_userId_idx" on "member" ("userId");

create index "invitation_organizationId_idx" on "invitation" ("organizationId");

create index "invitation_email_idx" on "invitation" ("email");

-- baymutt's own tables. Nothing here is plaintext the Worker could use to read a value: keys are
-- public halves, hashes, or sealed by a client. `*_by` and `actor` columns hold who acted as JSON
-- ({kind, id, name}), so history keeps a credential's name after it is gone.

-- A person's vault: one per Better Auth user.
CREATE TABLE store_account (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES "user" (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  encrypted_private_key TEXT NOT NULL,
  recovery_wrapped_dek TEXT NOT NULL,
  -- The data key wrapped to the password's key, when the account has a password.
  password_wrapped_dek TEXT,
  -- SHA-256 of a value only the open vault can compute: what a change must show.
  vault_proof_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- The vault's data key, wrapped once per passkey.
CREATE TABLE passkey_wrap (
  passkey_id TEXT PRIMARY KEY REFERENCES passkey (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES store_account (id) ON DELETE CASCADE,
  wrapped_dek TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- A CLI login (no parent) or a service account (its parent is the login that made it). Revoking
-- keeps the row for the activity log's sake and empties `bearer_hash`. The vouchers are what the
-- login that made a service account vouches for: its public key to the account
-- (`key_voucher_owner`) and to the login itself (`key_voucher_maker`), and the account's public key
-- to it (`account_voucher`). Null for a login.
CREATE TABLE credential (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES store_account (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  public_key TEXT NOT NULL,
  bearer_hash TEXT NOT NULL,
  parent_id TEXT REFERENCES credential (id) ON DELETE CASCADE,
  endorsement TEXT,
  welcome TEXT,
  key_voucher_owner TEXT,
  key_voucher_maker TEXT,
  account_voucher TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER
) STRICT;

CREATE INDEX credential_account_idx ON credential (account_id);

-- An environment belongs to one org. No cascade from the org: one that holds an environment, in
-- the bin or not, cannot be deleted. Deleting puts it in the bin (`deleted_at`) until `purge_at`.
CREATE TABLE environment (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organization (id),
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purge_at INTEGER,
  UNIQUE (org_id, name)
) STRICT;

-- A member's copy of an environment key: wrapped to the member's account key, with the creator's
-- proof of the environment's public key. One row per member, so a new member is a new row.
CREATE TABLE member_wrap (
  environment_id TEXT NOT NULL REFERENCES environment (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES store_account (id) ON DELETE CASCADE,
  wrap TEXT NOT NULL,
  proof TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, account_id)
) STRICT;

-- A credential's access to an environment. `read_wrap` is the environment key wrapped to the
-- credential: a grant without one cannot read. `key_proof` is the environment's public key as the
-- granter vouches for it to that credential.
CREATE TABLE environment_grant (
  environment_id TEXT NOT NULL REFERENCES environment (id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES credential (id) ON DELETE CASCADE,
  can_write INTEGER NOT NULL,
  read_wrap TEXT,
  key_proof TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, credential_id)
) STRICT;

CREATE INDEX environment_grant_credential_idx ON environment_grant (credential_id);

-- `current_version` is what a load answers with: NULL once deleted (in the bin until `purge_at`),
-- an earlier one after a rollback. `write_id` names the request that last moved the row, so the
-- rest of that request's batch can tell whether its compare-and-swap took.
CREATE TABLE secret (
  environment_id TEXT NOT NULL REFERENCES environment (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  current_version INTEGER,
  latest_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  write_id TEXT NOT NULL,
  purge_at INTEGER,
  PRIMARY KEY (environment_id, name)
) STRICT;

-- Never updated and never deleted by a write: a version is history.
CREATE TABLE secret_version (
  environment_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  key_version INTEGER NOT NULL,
  ciphertext TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, name, version),
  FOREIGN KEY (environment_id, name) REFERENCES secret (environment_id, name) ON DELETE CASCADE
) STRICT;

-- A single-use link to a page where the owner pastes one value. The store keeps the token's hash.
CREATE TABLE paste_link (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environment (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  reason TEXT NOT NULL,
  hint TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'fulfilled', 'cancelled')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  link_expires_at INTEGER NOT NULL,
  resolved_at INTEGER
) STRICT;

CREATE INDEX paste_link_environment_idx ON paste_link (environment_id, status);

-- The activity log. An entry about an org carries `org_id` alone and is read by the org's members,
-- so it outlives the account of whoever did it; one about a person's own vault or credentials
-- carries `account_id` alone. `id` is a ULID, so it orders by time.
CREATE TABLE activity_event (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organization (id) ON DELETE CASCADE,
  account_id TEXT REFERENCES store_account (id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  environment_id TEXT,
  environment_name TEXT,
  secret_name TEXT,
  version INTEGER,
  detail TEXT,
  CHECK ((org_id IS NULL) <> (account_id IS NULL))
) STRICT;

CREATE INDEX activity_event_org_idx ON activity_event (org_id, id);
CREATE INDEX activity_event_account_idx ON activity_event (account_id, id);
