-- 0.9.0: a CLI login asks to change what a key it asked for holds, instead of asking for another.
-- No existing row changes: two new tables, empty until a change is asked for.

-- What `baymutt ask change` makes: a change to the key `credential_id`, asked for by the CLI login
-- that is its parent, with a reason. `lifetime` is a new end asked for (milliseconds from the
-- approval, as on a first ask); NULL keeps the key's end. One that adds access or asks for a new
-- end waits for the owner (`pending`, then `approved`, `rejected` or `expired`); one that only
-- gives access back takes effect at once (`applied`). A pending one expires an hour after
-- `created_at`, worked out wherever it is read, as a request does. Neither holds a key, a wrap
-- or a proof: approving writes those to `environment_grant`, as approving a request does.
CREATE TABLE key_change (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES credential (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'applied', 'rejected', 'expired')),
  reason TEXT NOT NULL,
  lifetime INTEGER,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
) STRICT;

CREATE INDEX key_change_credential_idx ON key_change (credential_id, status);
CREATE INDEX key_change_status_idx ON key_change (status, created_at);

-- One environment a change names. `gives_back` 0: the access it asks to add there (read, write or
-- both, on top of what the key holds). `gives_back` 1: the key gives the environment back, and
-- `can_read` and `can_write` say what it held there when it asked.
CREATE TABLE key_change_item (
  change_id TEXT NOT NULL REFERENCES key_change (id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL,
  can_read INTEGER NOT NULL,
  can_write INTEGER NOT NULL,
  gives_back INTEGER NOT NULL CHECK (gives_back IN (0, 1)),
  PRIMARY KEY (change_id, environment_id)
) STRICT;
