-- 0.8.0: a CLI login holds no environment, a service account comes from a request the owner
-- approved, and the store stops keeping names it can read.

-- A CLI login lists names and holds no environment. Its service accounts keep theirs.
DELETE FROM environment_grant
WHERE credential_id IN (SELECT id FROM credential WHERE parent_id IS NULL);

-- An org's names key, wrapped by its owner to each reader: the owner's account (`reader_id` its
-- account id), a CLI login or a service account (its credential id). An org with no row here has
-- not sealed its names yet: they are stored as written until the owner's dashboard seals them, and
-- nothing with a new name can be made in it.
CREATE TABLE names_key_wrap (
  org_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  reader_id TEXT NOT NULL,
  wrap TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, reader_id)
) STRICT;

CREATE INDEX names_key_wrap_reader_idx ON names_key_wrap (reader_id);

-- In an org whose names are sealed, every `name` below is the name's index under the names key
-- (what makes it unique and findable) and `sealed_name` is the name itself, sealed. Until then
-- `name` is the name as written and `sealed_name` is NULL. The activity log keeps both as they
-- were when the entry was written, and sealing an org's names rewrites its entries too.
ALTER TABLE environment ADD COLUMN sealed_name TEXT;
ALTER TABLE secret ADD COLUMN sealed_name TEXT;
ALTER TABLE paste_link ADD COLUMN sealed_name TEXT;
ALTER TABLE activity_event ADD COLUMN environment_sealed_name TEXT;
ALTER TABLE activity_event ADD COLUMN secret_sealed_name TEXT;

-- A paste link is answered by the signed-in owner alone, so it carries no token. It expires an
-- hour after `created_at`, which needs no column.
-- One still waiting was made under the old rules, with a name the store can read and a token its
-- maker holds: it is cancelled, and whoever needs the value makes a new one.
UPDATE paste_link SET status = 'cancelled', resolved_at = unixepoch() * 1000
WHERE status = 'pending';
ALTER TABLE paste_link DROP COLUMN token_hash;
ALTER TABLE paste_link DROP COLUMN link_expires_at;

-- What `baymutt ask` makes: a credential that holds nothing (its parent the CLI login that asked,
-- its `description` the reason) and this row. Approving writes the grants and `expires_at` on the
-- credential, `lifetime` (milliseconds, NULL for no end) being what was asked for; rejecting
-- revokes the credential. `command` is what the key is piped into, as the terminal told it; NULL
-- for a key kept in a file.
CREATE TABLE access_request (
  credential_id TEXT PRIMARY KEY REFERENCES credential (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  command TEXT,
  lifetime INTEGER,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
) STRICT;

CREATE INDEX access_request_status_idx ON access_request (status, created_at);

-- One environment a request names, which exists when it is asked for.
CREATE TABLE access_request_item (
  credential_id TEXT NOT NULL REFERENCES access_request (credential_id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL,
  can_read INTEGER NOT NULL,
  can_write INTEGER NOT NULL,
  PRIMARY KEY (credential_id, environment_id)
) STRICT;

-- What `baymutt ask create-environment` makes: a CLI login asking for a new environment, by the id
-- and the sealed name it is to have, and why. The owner approves by creating that environment,
-- or rejects it. It expires an hour after `created_at`, which needs no column or status.
-- `created_by` is the CLI login, as an actor's JSON.
CREATE TABLE environment_request (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sealed_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
) STRICT;

CREATE INDEX environment_request_org_idx ON environment_request (org_id, status, created_at);
