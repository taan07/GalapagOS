// Worker rows and their streamed event log (architecture §3/§6). Every
// message a worker session streams is persisted here as it lands — the event
// log IS progress reporting; nothing state-bearing lives in memory.
import { randomUUID } from "node:crypto";
import type { GalapagosDb } from "../db";
import { nowIso } from "../db";

export type WorkerStatus =
  | "spawning"
  | "running"
  | "awaiting_input"
  | "idle"
  | "stopped"
  | "failed";

/** Statuses that imply a live SDK session behind the row. */
export const LIVE_WORKER_STATUSES: readonly WorkerStatus[] = [
  "spawning",
  "running",
  "awaiting_input",
  "idle",
];

export type WorkerRow = {
  id: string;
  project_id: string;
  lane_id: string;
  sdk_session_id: string | null;
  worktree_path: string;
  branch: string;
  brief_record_id: string | null;
  status: WorkerStatus;
  last_heartbeat_at: string | null;
  last_message_at: string | null;
  last_summary: string | null;
  /** Predecessor worker id when this session continues stopped work. */
  resumed_from: string | null;
  created_at: string;
};

export type WorkerEventKind =
  | "assistant"
  | "tool_use"
  | "tool_result"
  | "result"
  | "error"
  | "steer";

export type WorkerEventRow = {
  id: string;
  worker_id: string;
  kind: WorkerEventKind;
  payload: string;
  created_at: string;
};

export function createWorker(
  db: GalapagosDb,
  input: {
    projectId: string;
    laneId: string;
    worktreePath: string;
    branch: string;
    briefRecordId?: string | null;
    resumedFrom?: string | null;
  },
): WorkerRow {
  const row: WorkerRow = {
    id: randomUUID(),
    project_id: input.projectId,
    lane_id: input.laneId,
    sdk_session_id: null,
    worktree_path: input.worktreePath,
    branch: input.branch,
    brief_record_id: input.briefRecordId ?? null,
    status: "spawning",
    last_heartbeat_at: null,
    last_message_at: null,
    last_summary: null,
    resumed_from: input.resumedFrom ?? null,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO workers (id, project_id, lane_id, sdk_session_id, worktree_path, branch,
                          brief_record_id, status, last_heartbeat_at, last_message_at,
                          last_summary, resumed_from, created_at)
     VALUES (@id, @project_id, @lane_id, @sdk_session_id, @worktree_path, @branch,
             @brief_record_id, @status, @last_heartbeat_at, @last_message_at,
             @last_summary, @resumed_from, @created_at)`,
  ).run(row);
  return row;
}

export function getWorker(db: GalapagosDb, id: string): WorkerRow | undefined {
  return db.prepare("SELECT * FROM workers WHERE id = ?").get(id) as WorkerRow | undefined;
}

export function listWorkers(db: GalapagosDb, projectId: string): WorkerRow[] {
  return db
    .prepare("SELECT * FROM workers WHERE project_id = ? ORDER BY rowid")
    .all(projectId) as WorkerRow[];
}

export function setWorkerStatus(db: GalapagosDb, id: string, status: WorkerStatus): void {
  db.prepare("UPDATE workers SET status = ? WHERE id = ?").run(status, id);
}

export function setWorkerSdkSessionId(db: GalapagosDb, id: string, sdkSessionId: string): void {
  db.prepare("UPDATE workers SET sdk_session_id = ? WHERE id = ?").run(sdkSessionId, id);
}

export function touchWorker(db: GalapagosDb, id: string, summary?: string): void {
  if (summary !== undefined) {
    db.prepare("UPDATE workers SET last_message_at = ?, last_summary = ? WHERE id = ?").run(
      nowIso(),
      summary,
      id,
    );
    return;
  }
  db.prepare("UPDATE workers SET last_message_at = ? WHERE id = ?").run(nowIso(), id);
}

export function appendWorkerEvent(
  db: GalapagosDb,
  input: { workerId: string; kind: WorkerEventKind; payload: unknown },
): WorkerEventRow {
  const row: WorkerEventRow = {
    id: randomUUID(),
    worker_id: input.workerId,
    kind: input.kind,
    payload: JSON.stringify(input.payload),
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO worker_events (id, worker_id, kind, payload, created_at)
     VALUES (@id, @worker_id, @kind, @payload, @created_at)`,
  ).run(row);
  return row;
}

export function setWorkerBriefRecord(db: GalapagosDb, id: string, recordId: string): void {
  db.prepare("UPDATE workers SET brief_record_id = ? WHERE id = ?").run(recordId, id);
}

/** Insertion order via rowid — the same convention as manager history. */
export function listWorkerEvents(db: GalapagosDb, workerId: string): WorkerEventRow[] {
  return db
    .prepare("SELECT * FROM worker_events WHERE worker_id = ? ORDER BY rowid")
    .all(workerId) as WorkerEventRow[];
}

/** The newest `limit` events in insertion order — status views never need the full log. */
export function listRecentWorkerEvents(
  db: GalapagosDb,
  workerId: string,
  limit: number,
): WorkerEventRow[] {
  return (
    db
      .prepare("SELECT * FROM worker_events WHERE worker_id = ? ORDER BY rowid DESC LIMIT ?")
      .all(workerId, limit) as WorkerEventRow[]
  ).reverse();
}

export function countWorkerEvents(db: GalapagosDb, workerId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM worker_events WHERE worker_id = ?")
    .get(workerId) as { total: number };
  return row.total;
}

/**
 * Workers whose status implies a live session — used at daemon boot to
 * reconcile rows that survived a restart their sessions did not.
 */
export function listLiveStatusWorkers(db: GalapagosDb): WorkerRow[] {
  const placeholders = LIVE_WORKER_STATUSES.map(() => "?").join(", ");
  return db
    .prepare(`SELECT * FROM workers WHERE status IN (${placeholders}) ORDER BY rowid`)
    .all(...LIVE_WORKER_STATUSES) as WorkerRow[];
}
