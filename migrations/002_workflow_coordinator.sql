CREATE TABLE scheduler_control (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 0),
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  stop_after_current INTEGER NOT NULL CHECK (stop_after_current IN (0, 1)),
  updated_at TEXT NOT NULL
);

INSERT INTO scheduler_control (id, revision, paused, stop_after_current, updated_at)
VALUES (1, 0, 0, 0, CURRENT_TIMESTAMP);

CREATE TRIGGER scheduler_control_revision_monotonic
BEFORE UPDATE OF revision ON scheduler_control
WHEN NEW.revision < OLD.revision
BEGIN
  SELECT RAISE(ABORT, 'scheduler_control revision must be monotonic');
END;

CREATE TRIGGER scheduler_control_singleton_delete
BEFORE DELETE ON scheduler_control
BEGIN
  SELECT RAISE(ABORT, 'scheduler_control singleton cannot be deleted');
END;

CREATE TRIGGER runs_state_canonical_insert
BEFORE INSERT ON runs
WHEN NEW.state NOT IN (
  'claiming', 'preparing', 'rolling_back_claim', 'claim_failed',
  'intaking', 'building', 'verifying', 'reviewing', 'repairing',
  'publishing', 'waiting_for_ci', 'review', 'queued_rework',
  'returning_to_todo', 'merging', 'waiting_for_staging', 'smoking',
  'completing', 'done', 'stopped'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid run state');
END;

CREATE TRIGGER runs_state_canonical_update
BEFORE UPDATE OF state ON runs
WHEN NEW.state NOT IN (
  'claiming', 'preparing', 'rolling_back_claim', 'claim_failed',
  'intaking', 'building', 'verifying', 'reviewing', 'repairing',
  'publishing', 'waiting_for_ci', 'review', 'queued_rework',
  'returning_to_todo', 'merging', 'waiting_for_staging', 'smoking',
  'completing', 'done', 'stopped'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid run state');
END;

CREATE TRIGGER side_effects_status_canonical_insert
BEFORE INSERT ON side_effects
WHEN NEW.status NOT IN (
  'pending', 'in_flight', 'ambiguous', 'confirmed', 'failed', 'cancelled'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid side-effect status');
END;

CREATE TRIGGER side_effects_status_canonical_update
BEFORE UPDATE OF status ON side_effects
WHEN NEW.status NOT IN (
  'pending', 'in_flight', 'ambiguous', 'confirmed', 'failed', 'cancelled'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid side-effect status');
END;

UPDATE runs SET state = state;
UPDATE side_effects SET status = status;

CREATE UNIQUE INDEX runs_active_project_owner_index
ON runs (project_item_id)
WHERE owner_token IS NOT NULL AND ownership_released_at IS NULL;

CREATE UNIQUE INDEX runs_coding_slot_index
ON runs (1)
WHERE state IN (
  'claiming', 'preparing', 'rolling_back_claim', 'intaking', 'building',
  'verifying', 'reviewing', 'repairing', 'publishing', 'waiting_for_ci',
  'returning_to_todo'
);

CREATE INDEX side_effects_unresolved_index
ON side_effects (status, run_id, updated_at)
WHERE status IN ('pending', 'in_flight', 'ambiguous');

CREATE TRIGGER steps_append_only_update
BEFORE UPDATE ON steps
BEGIN
  SELECT RAISE(ABORT, 'append-only history: steps cannot be updated');
END;

CREATE TRIGGER steps_append_only_delete
BEFORE DELETE ON steps
BEGIN
  SELECT RAISE(ABORT, 'append-only history: steps cannot be deleted');
END;

CREATE TRIGGER events_append_only_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'append-only history: events cannot be updated');
END;

CREATE TRIGGER events_append_only_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'append-only history: events cannot be deleted');
END;

CREATE TRIGGER findings_append_only_update
BEFORE UPDATE ON findings
BEGIN
  SELECT RAISE(ABORT, 'append-only history: findings cannot be updated');
END;

CREATE TRIGGER findings_append_only_delete
BEFORE DELETE ON findings
BEGIN
  SELECT RAISE(ABORT, 'append-only history: findings cannot be deleted');
END;

CREATE TRIGGER approvals_append_only_update
BEFORE UPDATE ON approvals
BEGIN
  SELECT RAISE(ABORT, 'append-only history: approvals cannot be updated');
END;

CREATE TRIGGER approvals_append_only_delete
BEFORE DELETE ON approvals
BEGIN
  SELECT RAISE(ABORT, 'append-only history: approvals cannot be deleted');
END;
