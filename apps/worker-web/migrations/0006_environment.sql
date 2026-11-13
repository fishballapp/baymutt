-- An environment was called a project; the schema now says environment everywhere. Renames keep
-- every row, and SQLite rewrites the foreign keys that point at a renamed table or column. The
-- Worker live while this runs reads the old names and fails until the deploy that follows replaces
-- it, which the release runs straight after this migration.

ALTER TABLE project RENAME TO environment;
ALTER TABLE environment RENAME COLUMN archived_at TO deleted_at;

ALTER TABLE project_grant RENAME TO environment_grant;
ALTER TABLE environment_grant RENAME COLUMN project_id TO environment_id;
DROP INDEX project_grant_credential_idx;
CREATE INDEX environment_grant_credential_idx ON environment_grant (credential_id);

ALTER TABLE secret RENAME COLUMN project_id TO environment_id;
ALTER TABLE secret_version RENAME COLUMN project_id TO environment_id;
ALTER TABLE paste_request RENAME COLUMN project_id TO environment_id;

ALTER TABLE audit_event RENAME COLUMN project_id TO environment_id;
ALTER TABLE audit_event RENAME COLUMN project_name TO environment_name;
UPDATE audit_event SET action = 'environment.' || substr(action, length('project.') + 1)
  WHERE action LIKE 'project.%';

-- Access requests were removed in 0.4.0, and nothing has read or written this table since.
DROP TABLE access_request;
