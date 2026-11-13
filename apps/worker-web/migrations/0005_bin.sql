-- The bin. A deleted secret (`current_version` NULL) and a deleted project (`archived_at` set: the
-- column kept its first name) are kept until `purge_at`, then removed for good with everything
-- that hangs off them. Only columns are added, so the Worker that is live while this runs keeps
-- working: a row it deletes has no `purge_at`, and reads as deleted time + 30 days.
ALTER TABLE secret ADD COLUMN purge_at INTEGER;
ALTER TABLE project ADD COLUMN purge_at INTEGER;

-- What was deleted before the bin existed gets its 30 days from now, not from when it was deleted.
UPDATE secret SET purge_at = (CAST(strftime('%s', 'now') AS INTEGER) + 30 * 86400) * 1000
  WHERE current_version IS NULL;
UPDATE project SET purge_at = (CAST(strftime('%s', 'now') AS INTEGER) + 30 * 86400) * 1000
  WHERE archived_at IS NOT NULL;
