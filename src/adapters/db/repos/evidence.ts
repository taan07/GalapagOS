// Evidence runs (architecture §3): one row per executed check, keyed to the
// exact workspace state it ran against. `head_sha` stores the full evidence
// key — the commit sha, suffixed with `+dirty.<fingerprint>` when the tree
// was dirty at run time — so freshness is a plain string comparison against
// the workspace's current key: any commit OR uncommitted edit since the run
// makes the evidence stale (architecture §9: evidence that predates a
// head/dirty-state change drains).
import { randomUUID } from "node:crypto";
import type { GalapagosDb } from "../db";
import { nowIso } from "../db";

export const CHECK_KEYS = ["typecheck", "lint", "test", "build"] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];

export type EvidenceRunStatus = "passed" | "failed";

export type EvidenceRunRow = {
  id: string;
  project_id: string;
  worker_id: string | null;
  check_key: CheckKey;
  status: EvidenceRunStatus;
  summary: string;
  log_path: string | null;
  head_sha: string;
  created_at: string;
};

export function createEvidenceRun(
  db: GalapagosDb,
  input: {
    projectId: string;
    workerId?: string | null;
    checkKey: CheckKey;
    status: EvidenceRunStatus;
    summary: string;
    logPath?: string | null;
    headSha: string;
  },
): EvidenceRunRow {
  const row: EvidenceRunRow = {
    id: randomUUID(),
    project_id: input.projectId,
    worker_id: input.workerId ?? null,
    check_key: input.checkKey,
    status: input.status,
    summary: input.summary,
    log_path: input.logPath ?? null,
    head_sha: input.headSha,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO evidence_runs (id, project_id, worker_id, check_key, status, summary, log_path, head_sha, created_at)
     VALUES (@id, @project_id, @worker_id, @check_key, @status, @summary, @log_path, @head_sha, @created_at)`,
  ).run(row);
  return row;
}

/**
 * The latest run per check key for one scope. Worker scope (workerId set)
 * and project scope (workerId null) are distinct evidence pools — a passing
 * project-level test run says nothing about a worker's diverged worktree.
 */
export function latestRunsByKey(
  db: GalapagosDb,
  scope: { projectId: string; workerId: string | null },
): Map<CheckKey, EvidenceRunRow> {
  const rows = (
    scope.workerId === null
      ? db
          .prepare(
            "SELECT * FROM evidence_runs WHERE project_id = ? AND worker_id IS NULL ORDER BY rowid",
          )
          .all(scope.projectId)
      : db
          .prepare("SELECT * FROM evidence_runs WHERE worker_id = ? ORDER BY rowid")
          .all(scope.workerId)
  ) as EvidenceRunRow[];
  const latest = new Map<CheckKey, EvidenceRunRow>();
  for (const row of rows) {
    latest.set(row.check_key, row); // rowid order — the last write wins
  }
  return latest;
}

/** Insertion order via rowid — the app-wide history convention. */
export function listEvidenceRuns(
  db: GalapagosDb,
  scope: { projectId: string; workerId?: string | null },
): EvidenceRunRow[] {
  if (scope.workerId === undefined) {
    return db
      .prepare("SELECT * FROM evidence_runs WHERE project_id = ? ORDER BY rowid")
      .all(scope.projectId) as EvidenceRunRow[];
  }
  if (scope.workerId === null) {
    return db
      .prepare(
        "SELECT * FROM evidence_runs WHERE project_id = ? AND worker_id IS NULL ORDER BY rowid",
      )
      .all(scope.projectId) as EvidenceRunRow[];
  }
  return db
    .prepare("SELECT * FROM evidence_runs WHERE worker_id = ? ORDER BY rowid")
    .all(scope.workerId) as EvidenceRunRow[];
}

export function getEvidenceRun(db: GalapagosDb, id: string): EvidenceRunRow | undefined {
  return db.prepare("SELECT * FROM evidence_runs WHERE id = ?").get(id) as
    | EvidenceRunRow
    | undefined;
}
