// Architecture §3 schema, built up chunk by chunk in the same idempotent
// CREATE IF NOT EXISTS style. Chunk 1: projects, manager_sessions,
// manager_turns, jobs. Chunk 3: lanes, workers, worker_events,
// completion_digests, attention_items. Chunk 4: evidence_runs — the schema
// is complete against architecture §3.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS manager_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  sdk_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  seeded_from_records_at TEXT,
  created_at TEXT NOT NULL,
  last_resumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_manager_sessions_project
  ON manager_sessions(project_id, status);

CREATE TABLE IF NOT EXISTS manager_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES manager_sessions(id),
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  input_origin TEXT NOT NULL DEFAULT 'user' CHECK (input_origin IN ('user', 'daemon')),
  input_kind TEXT NOT NULL DEFAULT 'user_message',
  content TEXT NOT NULL,
  sdk_session_id_after TEXT,
  distilled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_manager_turns_session_order
  ON manager_turns(session_id, turn_index);

CREATE TABLE IF NOT EXISTS lanes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  allowed_globs TEXT NOT NULL,
  forbidden_globs TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lanes_project ON lanes(project_id, status);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  lane_id TEXT NOT NULL REFERENCES lanes(id),
  sdk_session_id TEXT,
  worktree_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  brief_record_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'spawning', 'running', 'awaiting_input', 'idle', 'stopped', 'failed'
  )),
  last_heartbeat_at TEXT,
  last_message_at TEXT,
  last_summary TEXT,
  resumed_from TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workers_project ON workers(project_id, status);

CREATE TABLE IF NOT EXISTS worker_events (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  kind TEXT NOT NULL CHECK (kind IN (
    'assistant', 'tool_use', 'tool_result', 'result', 'error', 'steer'
  )),
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worker_events_worker ON worker_events(worker_id);

CREATE TABLE IF NOT EXISTS completion_digests (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  narrative TEXT NOT NULL,
  before_after TEXT NOT NULL,
  claims TEXT NOT NULL,
  touched_areas TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'parsed' CHECK (status IN (
    'parsed', 'manager_reviewed', 'escalated'
  )),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_completion_digests_worker ON completion_digests(worker_id);

-- Verification, retirement, and narration are distinct facts. This table
-- records only the attempt to end the worker/lane after a digest is verified;
-- a failed stop never rewrites manager_reviewed back into an evidence state.
CREATE TABLE IF NOT EXISTS completion_retirements (
  digest_id TEXT PRIMARY KEY REFERENCES completion_digests(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  failure_kind TEXT CHECK (failure_kind IN ('transient', 'non_retryable')),
  last_error TEXT,
  last_attempt_at TEXT,
  retired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_completion_retirements_project
  ON completion_retirements(project_id, status);

-- One durable user-debrief obligation per verified digest. Attempts are a
-- separate append-only diagnostic trail: restarts can recover the queue and
-- explain exactly when/why delivery failed without replaying model calls.
CREATE TABLE IF NOT EXISTS completion_debriefs (
  digest_id TEXT PRIMARY KEY REFERENCES completion_digests(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at TEXT NOT NULL,
  last_failure_kind TEXT CHECK (last_failure_kind IN ('transient', 'non_retryable')),
  last_error_code TEXT,
  last_error TEXT,
  last_attempt_at TEXT,
  narrated_at TEXT,
  attention_id TEXT REFERENCES attention_items(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_completion_debriefs_project_due
  ON completion_debriefs(project_id, status, due_at);

CREATE TABLE IF NOT EXISTS completion_debrief_attempts (
  id TEXT PRIMARY KEY,
  digest_id TEXT NOT NULL REFERENCES completion_debriefs(digest_id),
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  context TEXT NOT NULL,
  failure_kind TEXT CHECK (failure_kind IN ('transient', 'non_retryable')),
  error_code TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(digest_id, attempt_number)
);

-- kind: lane_violation | stale_worker | question_for_user | unsupported_claim |
--       check_failed | decision_needed | unstructured_completion | worker_failed |
--       integrity_alert | tool_denied | worker_abandoned |
--       worker_retirement_failed | completion_debrief_failed
CREATE TABLE IF NOT EXISTS attention_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  worker_id TEXT REFERENCES workers(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  record_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_attention_items_project ON attention_items(project_id, status);

CREATE TABLE IF NOT EXISTS evidence_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  worker_id TEXT REFERENCES workers(id),
  check_key TEXT NOT NULL CHECK (check_key IN ('typecheck', 'lint', 'test', 'build')),
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
  summary TEXT NOT NULL,
  log_path TEXT,
  head_sha TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_runs_scope
  ON evidence_runs(project_id, worker_id, check_key);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT,
  result TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_steps (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN (
    'planned', 'active', 'done', 'abandoned'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_steps_worker_ordinal
  ON worker_steps(worker_id, ordinal);

CREATE TABLE IF NOT EXISTS worker_plans (
  worker_id TEXT PRIMARY KEY REFERENCES workers(id),
  goal TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
