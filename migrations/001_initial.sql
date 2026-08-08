CREATE TABLE schema_migrations (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id > 0),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum GLOB '[0-9a-f]*' AND checksum NOT GLOB '*[^0-9a-f]*'),
  applied_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL,
  repository TEXT NOT NULL,
  project_item_id TEXT NOT NULL,
  issue_node_id TEXT NOT NULL,
  issue_number INTEGER NOT NULL CHECK (issue_number > 0),
  intake_json TEXT CHECK (intake_json IS NULL OR length(CAST(intake_json AS BLOB)) <= 1048576),
  state TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  rework_epoch INTEGER NOT NULL CHECK (rework_epoch >= 0),
  repair_round INTEGER NOT NULL CHECK (repair_round >= 0),
  owner_token TEXT,
  ownership_released_at TEXT,
  stop_requested_at TEXT,
  base_sha TEXT CHECK (base_sha IS NULL OR ((length(base_sha) = 40 OR length(base_sha) = 64) AND base_sha NOT GLOB '*[^0-9a-f]*')),
  head_sha TEXT CHECK (head_sha IS NULL OR ((length(head_sha) = 40 OR length(head_sha) = 64) AND head_sha NOT GLOB '*[^0-9a-f]*')),
  approved_head_sha TEXT CHECK (approved_head_sha IS NULL OR ((length(approved_head_sha) = 40 OR length(approved_head_sha) = 64) AND approved_head_sha NOT GLOB '*[^0-9a-f]*')),
  observed_base_sha TEXT CHECK (observed_base_sha IS NULL OR ((length(observed_base_sha) = 40 OR length(observed_base_sha) = 64) AND observed_base_sha NOT GLOB '*[^0-9a-f]*')),
  merge_sha TEXT CHECK (merge_sha IS NULL OR ((length(merge_sha) = 40 OR length(merge_sha) = 64) AND merge_sha NOT GLOB '*[^0-9a-f]*')),
  worktree_path TEXT,
  base_branch TEXT NOT NULL,
  branch TEXT,
  pull_request_number INTEGER,
  pull_request_title TEXT,
  pull_request_url TEXT,
  required_action TEXT,
  last_failure_json TEXT CHECK (last_failure_json IS NULL OR length(CAST(last_failure_json AS BLOB)) <= 1048576),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  handed_off_at TEXT,
  terminal_at TEXT
);
CREATE INDEX runs_project_item_id_index ON runs(project_item_id);
CREATE INDEX runs_issue_node_id_index ON runs(issue_node_id);

CREATE TABLE steps (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  rework_epoch INTEGER NOT NULL CHECK (rework_epoch >= 0),
  role TEXT NOT NULL,
  logical_step TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status_sequence INTEGER NOT NULL CHECK (status_sequence > 0),
  status TEXT NOT NULL,
  prompt_hash TEXT NOT NULL CHECK (length(prompt_hash) = 64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'),
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  exit_result_json TEXT CHECK (exit_result_json IS NULL OR length(CAST(exit_result_json AS BLOB)) <= 1048576),
  summary TEXT,
  raw_log_reference TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (id, run_id),
  UNIQUE (run_id, rework_epoch, logical_step, attempt, status_sequence)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  run_revision INTEGER NOT NULL CHECK (run_revision >= 0),
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  details_json TEXT CHECK (details_json IS NULL OR length(CAST(details_json AS BLOB)) <= 1048576),
  log_reference TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (run_id, sequence)
);

CREATE TABLE findings (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  rework_epoch INTEGER NOT NULL CHECK (rework_epoch >= 0),
  review_step_id TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  disposition_sequence INTEGER NOT NULL CHECK (disposition_sequence > 0),
  severity TEXT NOT NULL,
  evidence TEXT NOT NULL,
  disposition TEXT NOT NULL,
  resolving_step_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (review_step_id, run_id) REFERENCES steps(id, run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (resolving_step_id, run_id) REFERENCES steps(id, run_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (run_id, rework_epoch, stable_key, disposition_sequence)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  operator TEXT NOT NULL,
  approved_head_sha TEXT NOT NULL CHECK ((length(approved_head_sha) = 40 OR length(approved_head_sha) = 64) AND approved_head_sha NOT GLOB '*[^0-9a-f]*'),
  observed_base_sha TEXT NOT NULL CHECK ((length(observed_base_sha) = 40 OR length(observed_base_sha) = 64) AND observed_base_sha NOT GLOB '*[^0-9a-f]*'),
  decision TEXT NOT NULL,
  invalidation_reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX approvals_run_id_index ON approvals(run_id);

CREATE TABLE side_effects (
  key TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  rework_epoch INTEGER NOT NULL CHECK (rework_epoch >= 0),
  kind TEXT NOT NULL,
  target_revision INTEGER NOT NULL CHECK (target_revision >= 0),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  intent_json TEXT NOT NULL CHECK (length(CAST(intent_json AS BLOB)) <= 1048576),
  receipt_json TEXT CHECK (receipt_json IS NULL OR length(CAST(receipt_json AS BLOB)) <= 1048576),
  status TEXT NOT NULL,
  executor_attempt INTEGER NOT NULL CHECK (executor_attempt >= 0),
  executor_owner_token TEXT,
  process_id INTEGER,
  request_id TEXT,
  pr_number INTEGER,
  pr_node_id TEXT,
  workflow_run_id INTEGER,
  started_at TEXT,
  completed_at TEXT,
  failure TEXT,
  reconciliation_evidence TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX side_effects_run_id_index ON side_effects(run_id);
