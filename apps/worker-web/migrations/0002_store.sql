-- baymutt's own tables. Every row carries its account. Nothing here is plaintext the Worker could
-- use to read a value: keys are public halves, hashes, or sealed by a client.
-- `*_by` and `actor` columns hold who acted as JSON ({kind, id, name}), so history keeps a machine's
-- name after the machine is gone.

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

-- A machine. Revoking keeps the row for the audit log's sake and empties `bearer_hash`.
CREATE TABLE credential (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES store_account (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  bearer_hash TEXT NOT NULL,
  parent_id TEXT REFERENCES credential (id) ON DELETE CASCADE,
  endorsement TEXT,
  welcome TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
) STRICT;

CREATE INDEX credential_account_idx ON credential (account_id);

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES store_account (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  owner_wrap TEXT NOT NULL,
  owner_proof TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  UNIQUE (account_id, name)
) STRICT;

-- `read_wrap` is the project key wrapped to the machine: a grant without one cannot read.
-- `key_proof` is the project's public key as the granter vouches for it to that machine.
CREATE TABLE project_grant (
  project_id TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES credential (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES store_account (id) ON DELETE CASCADE,
  can_write INTEGER NOT NULL,
  read_wrap TEXT,
  key_proof TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, credential_id)
) STRICT;

CREATE INDEX project_grant_credential_idx ON project_grant (credential_id);

-- `current_version` is what a load answers with: NULL once deleted, an earlier one after a rollback.
-- `write_id` names the request that last moved the row, so the rest of that request's batch can
-- tell whether its compare-and-swap took.
CREATE TABLE secret (
  project_id TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES store_account (id) ON DELETE CASCADE,
  current_version INTEGER,
  latest_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  write_id TEXT NOT NULL,
  PRIMARY KEY (project_id, name)
) STRICT;

-- Never updated and never deleted by a write: a version is history.
CREATE TABLE secret_version (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES store_account (id) ON DELETE CASCADE,
  key_version INTEGER NOT NULL,
  ciphertext TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, name, version),
  FOREIGN KEY (project_id, name) REFERENCES secret (project_id, name) ON DELETE CASCADE
) STRICT;

CREATE TABLE access_request (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES store_account (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES credential (id) ON DELETE CASCADE,
  wants_read INTEGER NOT NULL,
  wants_write INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
) STRICT;

CREATE INDEX access_request_account_idx ON access_request (account_id, status);

CREATE TABLE paste_request (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES store_account (id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
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

CREATE INDEX paste_request_account_idx ON paste_request (account_id, status);

-- `id` is a ULID, so it orders by time.
CREATE TABLE audit_event (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES store_account (id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  project_id TEXT,
  project_name TEXT,
  secret_name TEXT,
  version INTEGER,
  detail TEXT
) STRICT;

CREATE INDEX audit_event_account_idx ON audit_event (account_id, id);
