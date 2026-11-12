-- A service account may expire, and may say what it is for. Both are optional and readable by the
-- store, like its name. Whether it is a login (full access) or a scoped service account is not a
-- column: a login is one with no parent.
ALTER TABLE credential ADD COLUMN expires_at INTEGER;
ALTER TABLE credential ADD COLUMN description TEXT;
