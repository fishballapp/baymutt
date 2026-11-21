-- 0.11.0: a CLI login asks the owner for anything with one plan: a reason and ordered steps, in
-- one org. The owner decides each step whole. Three new tables, empty until a plan is made.

-- What `baymutt ask` makes. `credential_id` is the CLI login that asked. A step still pending an
-- hour after `created_at` has expired, worked out wherever a plan is read or answered; the daily
-- run writes it down. `cancelled_at` is when its maker withdrew it.
CREATE TABLE plan (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL REFERENCES credential (id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  cancelled_at INTEGER
) STRICT;

CREATE INDEX plan_org_idx ON plan (org_id, created_at);
CREATE INDEX plan_credential_idx ON plan (credential_id, created_at);

-- One step of a plan, at `position` from 0. `reason` is its own why, NULL when the plan's stands.
-- `applied`: a `change` step that only gives access back, which needs no approval. `note` is what
-- the owner told the agent when deciding it, sealed to the CLI login that asked.
-- An `access` step makes the key `key_id` (a credential that holds nothing until the step is
-- approved; its parent is the login that asked) and a `change` step changes it. `key_end` is when
-- that key is to end: `after` `lifetime` milliseconds from the approval, `never`, or, for a
-- change, `keep`. `command` is what a new key is piped into, as the terminal told it; NULL for a
-- key kept in a file. `answer_id` is a fresh id the write that takes a step out of `pending`
-- stamps on it, so every other statement of that write is conditioned on that write having taken.
CREATE TABLE plan_step (
  plan_id TEXT NOT NULL REFERENCES plan (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('environments', 'access', 'change', 'secrets')),
  reason TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'approved', 'applied', 'rejected', 'cancelled', 'expired')),
  note TEXT,
  key_id TEXT REFERENCES credential (id) ON DELETE CASCADE,
  key_end TEXT CHECK (key_end IN ('after', 'never', 'keep')),
  lifetime INTEGER,
  command TEXT,
  resolved_at INTEGER,
  answer_id TEXT,
  PRIMARY KEY (plan_id, position),
  CHECK ((type IN ('access', 'change')) = (key_id IS NOT NULL)),
  CHECK ((key_id IS NULL) = (key_end IS NULL)),
  CHECK ((key_end = 'after') = (lifetime IS NOT NULL))
) STRICT;

CREATE INDEX plan_step_status_idx ON plan_step (status, plan_id);
CREATE INDEX plan_step_key_idx ON plan_step (key_id, status);

-- One thing a step asks for, at `position` from 0: one line on the owner's page.
--   environments: `create`, `delete`, `restore`
--   access:       `read`
--   change:       `read`, `give-back`
--   secrets:      `set`, `paste`, `generate`, `delete`, `rollback`, `restore`
-- `environment_id` has no foreign key: a `create` names an environment that does not exist yet,
-- with the name it is to have (`environment_name` its index, `environment_sealed_name` the name
-- sealed), and a later step may name it before it does. An environment removed for good leaves
-- its items behind, and their step can only be rejected.
-- A secrets item names its secret by `secret_name` (its index) and, where the name may be new,
-- `secret_sealed_name`. `sealed_hint` is where the owner finds a value to paste and
-- `proposed_value` the value a `set` proposes, each sealed by the CLI login to the owner's account
-- key; both are cleared once the step is no longer pending. `version` is the one a `rollback`
-- makes current.
CREATE TABLE plan_item (
  plan_id TEXT NOT NULL,
  step_position INTEGER NOT NULL,
  position INTEGER NOT NULL,
  op TEXT NOT NULL CHECK (op IN (
    'create', 'delete', 'restore', 'read', 'give-back', 'set', 'paste', 'generate', 'rollback')),
  environment_id TEXT NOT NULL,
  environment_name TEXT,
  environment_sealed_name TEXT,
  secret_name TEXT,
  secret_sealed_name TEXT,
  sealed_hint TEXT,
  version INTEGER,
  proposed_value TEXT,
  PRIMARY KEY (plan_id, step_position, position),
  FOREIGN KEY (plan_id, step_position) REFERENCES plan_step (plan_id, position) ON DELETE CASCADE
) STRICT;

CREATE INDEX plan_item_environment_idx ON plan_item (environment_id);
