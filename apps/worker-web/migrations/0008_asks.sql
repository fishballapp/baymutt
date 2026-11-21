-- 0.12.0: what `baymutt ask` sends is called an ask. The three tables 0006 made, their `plan_id`
-- columns and their indexes take the word; every row, id and sealed column stays as it is. The
-- activity log is not rewritten: its `plan.*` entries are read as they were written.

-- Renaming a table or a column repoints what references it: `ask_step`'s foreign key follows
-- `plan` to `ask`, and `ask_item`'s follows `plan_step` and its column to `ask_step (ask_id, …)`.
-- An index follows too, but cannot be renamed: each is made anew under its new name, over the same
-- columns.
ALTER TABLE plan RENAME TO ask;
ALTER TABLE plan_step RENAME TO ask_step;
ALTER TABLE plan_item RENAME TO ask_item;

ALTER TABLE ask_step RENAME COLUMN plan_id TO ask_id;
ALTER TABLE ask_item RENAME COLUMN plan_id TO ask_id;

DROP INDEX plan_org_idx;
DROP INDEX plan_credential_idx;
DROP INDEX plan_step_status_idx;
DROP INDEX plan_step_key_idx;
DROP INDEX plan_item_environment_idx;

CREATE INDEX ask_org_idx ON ask (org_id, created_at);
CREATE INDEX ask_credential_idx ON ask (credential_id, created_at);
CREATE INDEX ask_step_status_idx ON ask_step (status, ask_id);
CREATE INDEX ask_step_key_idx ON ask_step (key_id, status);
CREATE INDEX ask_item_environment_idx ON ask_item (environment_id);
