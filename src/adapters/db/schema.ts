// Chunk 1 subset of the architecture §3 schema. Later chunks append tables
// (lanes, workers, worker_events, completion_digests, attention_items,
// evidence_runs) with the same idempotent CREATE IF NOT EXISTS style.
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
  content TEXT NOT NULL,
  sdk_session_id_after TEXT,
  distilled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_manager_turns_session_order
  ON manager_turns(session_id, turn_index);

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
`;
