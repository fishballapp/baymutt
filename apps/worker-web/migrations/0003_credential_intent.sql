-- What a key is for, kept on the key: `service-account` for a key made for another system (the CLI
-- login that asked gave a command to pipe it into), `agent` for a key an agent asked for its own
-- work (kept in a file). NULL for a CLI login. The dashboard lists them apart.
ALTER TABLE credential ADD COLUMN intent TEXT CHECK (intent IN ('service-account', 'agent'));

-- A key from a request knows its intent from the request's command. One from before requests
-- (0.7) has no request row, so it falls back to its end: no end is a service account, an end an
-- agent's. Written once here, so a later change of its end does not move it.
UPDATE credential SET intent = CASE
  WHEN EXISTS (SELECT 1 FROM access_request r WHERE r.credential_id = credential.id)
    THEN CASE WHEN (SELECT r.command FROM access_request r WHERE r.credential_id = credential.id)
      IS NOT NULL THEN 'service-account' ELSE 'agent' END
  WHEN expires_at IS NULL THEN 'service-account'
  ELSE 'agent'
END
WHERE parent_id IS NOT NULL;
