/**
 * The initial storage contract. JSON values remain TEXT here: repositories in
 * the workflow slice own parsing and domain validation.
 */
export interface SchemaMigrationsTable {
  id: number;
  name: string;
  checksum: string;
  applied_at: string;
}

export interface RunsTable {
  id: string;
  repository: string;
  project_item_id: string;
  issue_node_id: string;
  issue_number: number;
  intake_json: string | null;
  state: string;
  revision: number;
  rework_epoch: number;
  repair_round: number;
  owner_token: string | null;
  ownership_released_at: string | null;
  stop_requested_at: string | null;
  base_sha: string | null;
  head_sha: string | null;
  approved_head_sha: string | null;
  observed_base_sha: string | null;
  merge_sha: string | null;
  worktree_path: string | null;
  base_branch: string;
  branch: string | null;
  pull_request_number: number | null;
  pull_request_title: string | null;
  pull_request_url: string | null;
  required_action: string | null;
  last_failure_json: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  handed_off_at: string | null;
  terminal_at: string | null;
}

export interface StepsTable {
  id: string;
  run_id: string;
  rework_epoch: number;
  role: string;
  logical_step: string;
  attempt: number;
  status_sequence: number;
  status: string;
  prompt_hash: string;
  model: string;
  reasoning_effort: string;
  started_at: string;
  completed_at: string | null;
  exit_result_json: string | null;
  summary: string | null;
  raw_log_reference: string | null;
}

export interface EventsTable {
  id: string;
  run_id: string;
  sequence: number;
  run_revision: number;
  kind: string;
  summary: string;
  details_json: string | null;
  log_reference: string | null;
  created_at: string;
}

export interface FindingsTable {
  id: string;
  run_id: string;
  rework_epoch: number;
  review_step_id: string;
  stable_key: string;
  disposition_sequence: number;
  severity: string;
  evidence: string;
  disposition: string;
  resolving_step_id: string | null;
  created_at: string;
}

export interface ApprovalsTable {
  id: string;
  run_id: string;
  operator: string;
  approved_head_sha: string;
  observed_base_sha: string;
  decision: string;
  invalidation_reason: string | null;
  created_at: string;
}

export interface SideEffectsTable {
  key: string;
  run_id: string;
  rework_epoch: number;
  kind: string;
  target_revision: number;
  fingerprint: string;
  intent_json: string;
  receipt_json: string | null;
  status: string;
  executor_attempt: number;
  executor_owner_token: string | null;
  process_id: number | null;
  request_id: string | null;
  pr_number: number | null;
  pr_node_id: string | null;
  workflow_run_id: number | null;
  started_at: string | null;
  completed_at: string | null;
  failure: string | null;
  reconciliation_evidence: string | null;
  created_at: string;
  updated_at: string;
}

export interface DatabaseSchema {
  schema_migrations: SchemaMigrationsTable;
  runs: RunsTable;
  steps: StepsTable;
  events: EventsTable;
  findings: FindingsTable;
  approvals: ApprovalsTable;
  side_effects: SideEffectsTable;
}
