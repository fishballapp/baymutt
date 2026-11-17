-- 0.10.0: a key belongs to exactly one org. It holds environments of that org only, and keeps it
-- after it has given everything back. The request that made a key and every key change to it are
-- the key's, so they have its org through `credential_id`. A CLI login stays the account's: NULL.
-- Deleting the org takes its keys with it: an org is deleted only once it holds no environment.
-- A key whose org cannot be told is revoked below; a key that spans orgs stops the migration.
ALTER TABLE credential ADD COLUMN org_id TEXT REFERENCES organization (id) ON DELETE CASCADE;

CREATE INDEX credential_org_idx ON credential (org_id);

-- Each key's orgs, from everything that names an environment for it: its request, its grants and
-- its key changes.
CREATE TABLE key_org_backfill (
  credential_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  PRIMARY KEY (credential_id, org_id)
) STRICT;

INSERT OR IGNORE INTO key_org_backfill (credential_id, org_id)
SELECT i.credential_id, e.org_id FROM access_request_item i
JOIN environment e ON e.id = i.environment_id;

INSERT OR IGNORE INTO key_org_backfill (credential_id, org_id)
SELECT g.credential_id, e.org_id FROM environment_grant g
JOIN credential c ON c.id = g.credential_id
JOIN environment e ON e.id = g.environment_id
WHERE c.parent_id IS NOT NULL;

INSERT OR IGNORE INTO key_org_backfill (credential_id, org_id)
SELECT k.credential_id, e.org_id FROM key_change_item i
JOIN key_change k ON k.id = i.change_id
JOIN environment e ON e.id = i.environment_id;

-- Fails the migration, and so the deploy, rather than guess: a key that spans orgs.
CREATE TABLE key_org_check (
  credential_id TEXT PRIMARY KEY,
  orgs INTEGER NOT NULL CHECK (orgs = 1)
) STRICT;

INSERT INTO key_org_check (credential_id, orgs)
SELECT credential_id, COUNT(*) FROM key_org_backfill GROUP BY credential_id;

UPDATE credential
SET org_id = (SELECT b.org_id FROM key_org_backfill b WHERE b.credential_id = credential.id)
WHERE parent_id IS NOT NULL;

-- A key nothing names an environment for holds nothing and belongs nowhere: its org may have been
-- emptied and deleted, so no surviving org is guessed for it. It is revoked now, as revoking does
-- (no bearer, its asks closed), and keeps no org.
UPDATE access_request SET status = 'expired', resolved_at = unixepoch() * 1000
WHERE status = 'pending' AND credential_id IN (
  SELECT id FROM credential WHERE parent_id IS NOT NULL AND org_id IS NULL AND revoked_at IS NULL);

UPDATE key_change SET status = 'expired', resolved_at = unixepoch() * 1000
WHERE status = 'pending' AND credential_id IN (
  SELECT id FROM credential WHERE parent_id IS NOT NULL AND org_id IS NULL AND revoked_at IS NULL);

UPDATE credential SET revoked_at = unixepoch() * 1000, bearer_hash = ''
WHERE parent_id IS NOT NULL AND org_id IS NULL AND revoked_at IS NULL;

-- Sealing an org used to wrap its names key to every key of the account. A key keeps its own
-- org's copy alone; a CLI login and the owner's account keep theirs.
DELETE FROM names_key_wrap
WHERE reader_id IN (SELECT id FROM credential WHERE parent_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM credential c
                  WHERE c.id = names_key_wrap.reader_id AND c.org_id = names_key_wrap.org_id);

DROP TABLE key_org_check;
DROP TABLE key_org_backfill;
