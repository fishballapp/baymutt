-- 0.11.0: a key only reads, and a CLI login asks for everything with one plan. The asks a plan
-- replaced go with their tables, and a grant loses write. A read grant keeps its wrap, proof and
-- key version as they are, so a key that reads keeps reading. The activity log is not rewritten.

-- The keys this revokes. A key (not a CLI login) that held a grant without a read held write on
-- it, and is revoked if that leaves it nothing; a key whose request never became a key (pending,
-- rejected or expired, and not revoked yet) is revoked too. A key from an approved request, or one
-- that already held nothing, is untouched.
CREATE TABLE key_revoke_0007 (id TEXT PRIMARY KEY) STRICT;

INSERT INTO key_revoke_0007 (id)
SELECT c.id FROM credential c
WHERE c.parent_id IS NOT NULL AND c.revoked_at IS NULL
  AND EXISTS (SELECT 1 FROM environment_grant g
              WHERE g.credential_id = c.id AND g.read_wrap IS NULL)
  AND NOT EXISTS (SELECT 1 FROM environment_grant g
                  WHERE g.credential_id = c.id AND g.read_wrap IS NOT NULL);

INSERT OR IGNORE INTO key_revoke_0007 (id)
SELECT c.id FROM credential c JOIN access_request r ON r.credential_id = c.id
WHERE c.parent_id IS NOT NULL AND c.revoked_at IS NULL AND r.status <> 'approved';

-- Every key loses write: a grant without a read holds nothing now.
DELETE FROM environment_grant WHERE read_wrap IS NULL;

-- Revoked as the Worker revokes one: no bearer, no grants, no names key copies, and a plan's step
-- still waiting to change it rejected (expired, past its plan's hour). No key revoked here made a
-- plan: only a CLI login does.
UPDATE credential SET revoked_at = unixepoch() * 1000, bearer_hash = ''
WHERE id IN (SELECT id FROM key_revoke_0007);

DELETE FROM environment_grant WHERE credential_id IN (SELECT id FROM key_revoke_0007);

DELETE FROM names_key_wrap WHERE reader_id IN (SELECT id FROM key_revoke_0007);

UPDATE plan_step
SET status = CASE WHEN (SELECT created_at FROM plan WHERE id = plan_step.plan_id)
                    > unixepoch() * 1000 - 3600000 THEN 'rejected' ELSE 'expired' END,
  resolved_at = unixepoch() * 1000
WHERE key_id IN (SELECT id FROM key_revoke_0007) AND status = 'pending';

DROP TABLE key_revoke_0007;

-- What a plan replaced: requests, key changes, environment requests and paste links.
DROP TABLE access_request_item;
DROP TABLE access_request;
DROP TABLE key_change_item;
DROP TABLE key_change;
DROP TABLE environment_request;
DROP TABLE paste_link;

-- A grant is a read: the environment key wrapped to the key (`read_wrap`, required now) and the
-- granter's proof of it. Rebuilt without `can_write`, every row copied as it is. Nothing references
-- this table, so renaming the copy repoints nothing.
CREATE TABLE environment_grant_0007 (
  environment_id TEXT NOT NULL REFERENCES environment (id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES credential (id) ON DELETE CASCADE,
  read_wrap TEXT NOT NULL,
  key_proof TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, credential_id)
) STRICT;

INSERT INTO environment_grant_0007
  (environment_id, credential_id, read_wrap, key_proof, key_version, created_at)
SELECT environment_id, credential_id, read_wrap, key_proof, key_version, created_at
FROM environment_grant;

DROP TABLE environment_grant;

ALTER TABLE environment_grant_0007 RENAME TO environment_grant;

CREATE INDEX environment_grant_credential_idx ON environment_grant (credential_id);
