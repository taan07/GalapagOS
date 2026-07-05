// Attention items (architecture §3): the exception queue. Chunk 3 landed the
// table and the rows (lane_violation at worker stop, unstructured_completion
// for report-less workers); Chunk 4 adds the monitor's rows, the queue UI,
// and triage. Rows are append-only facts — the monitor deduplicates against
// identical OPEN facts so a 30s tick never floods the queue, but it never
// rewrites what was already recorded.
import { randomUUID } from "node:crypto";
import type { GalapagosDb } from "../db";
import { nowIso } from "../db";

export type AttentionKind =
  | "lane_violation"
  | "stale_worker"
  | "question_for_user"
  | "unsupported_claim"
  | "check_failed"
  | "decision_needed"
  | "unstructured_completion"
  // Chunk 4 (§3 comment updated in the same commit): a worker session that
  // died mid-run — nobody was watching a tool result, so the queue is the
  // only place this failure can surface.
  | "worker_failed";

export type AttentionStatus = "open" | "resolved" | "dismissed";

export type AttentionItemRow = {
  id: string;
  project_id: string;
  worker_id: string | null;
  kind: AttentionKind;
  title: string;
  detail: string;
  priority: "high" | "normal";
  status: AttentionStatus;
  record_id: string | null;
  created_at: string;
  resolved_at: string | null;
};

export function createAttentionItem(
  db: GalapagosDb,
  input: {
    projectId: string;
    workerId?: string | null;
    kind: AttentionKind;
    title: string;
    detail: string;
    priority?: "high" | "normal";
    recordId?: string | null;
  },
): AttentionItemRow {
  const row: AttentionItemRow = {
    id: randomUUID(),
    project_id: input.projectId,
    worker_id: input.workerId ?? null,
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    priority: input.priority ?? "normal",
    status: "open",
    record_id: input.recordId ?? null,
    created_at: nowIso(),
    resolved_at: null,
  };
  db.prepare(
    `INSERT INTO attention_items (id, project_id, worker_id, kind, title, detail, priority, status, record_id, created_at, resolved_at)
     VALUES (@id, @project_id, @worker_id, @kind, @title, @detail, @priority, @status, @record_id, @created_at, @resolved_at)`,
  ).run(row);
  return row;
}

export function listOpenAttentionItems(db: GalapagosDb, projectId: string): AttentionItemRow[] {
  return db
    .prepare(
      "SELECT * FROM attention_items WHERE project_id = ? AND status = 'open' ORDER BY rowid",
    )
    .all(projectId) as AttentionItemRow[];
}

export function listWorkerAttentionItems(db: GalapagosDb, workerId: string): AttentionItemRow[] {
  return db
    .prepare("SELECT * FROM attention_items WHERE worker_id = ? ORDER BY rowid")
    .all(workerId) as AttentionItemRow[];
}

export function getAttentionItem(db: GalapagosDb, id: string): AttentionItemRow | undefined {
  return db.prepare("SELECT * FROM attention_items WHERE id = ?").get(id) as
    | AttentionItemRow
    | undefined;
}

export function resolveAttentionItem(
  db: GalapagosDb,
  id: string,
  status: "resolved" | "dismissed",
  resolutionNote?: string,
): void {
  if (resolutionNote && resolutionNote.trim()) {
    // The note joins the detail as part of the recorded fact — there is no
    // separate resolution column in the §3 schema, and the queue must show
    // WHY an item closed, not just that it did.
    db.prepare(
      "UPDATE attention_items SET status = ?, resolved_at = ?, detail = detail || ? WHERE id = ?",
    ).run(status, nowIso(), `\n\n[${status}] ${resolutionNote.trim()}`, id);
    return;
  }
  db.prepare("UPDATE attention_items SET status = ?, resolved_at = ? WHERE id = ?").run(
    status,
    nowIso(),
    id,
  );
}

/**
 * Monitor-tick dedup: does an identical OPEN fact already exist? Identity is
 * (project, worker, kind, title, detail) — when the observed facts change
 * (a new violating file, a longer silence bucket), the detail changes and a
 * new row is honestly appended.
 */
export function openAttentionItemExists(
  db: GalapagosDb,
  input: {
    projectId: string;
    workerId?: string | null;
    kind: AttentionKind;
    title: string;
    detail?: string;
  },
): boolean {
  const workerId = input.workerId ?? null;
  const row = db
    .prepare(
      `SELECT id FROM attention_items
       WHERE project_id = ? AND kind = ? AND title = ? AND status = 'open'
         AND worker_id IS ?
         ${input.detail !== undefined ? "AND detail = ?" : ""}
       LIMIT 1`,
    )
    .get(
      ...(input.detail !== undefined
        ? [input.projectId, input.kind, input.title, workerId, input.detail]
        : [input.projectId, input.kind, input.title, workerId]),
    );
  return row !== undefined;
}

/** Open items raised for one worker by kind — the monitor's auto-resolve scope. */
export function listOpenWorkerAttentionByKind(
  db: GalapagosDb,
  workerId: string,
  kind: AttentionKind,
): AttentionItemRow[] {
  return db
    .prepare(
      "SELECT * FROM attention_items WHERE worker_id = ? AND kind = ? AND status = 'open' ORDER BY rowid",
    )
    .all(workerId, kind) as AttentionItemRow[];
}

/** All items for the queue UI: open first (high before normal), then closed, newest first within groups. */
export function listProjectAttentionItems(
  db: GalapagosDb,
  projectId: string,
  limit = 100,
): AttentionItemRow[] {
  return db
    .prepare(
      `SELECT * FROM attention_items WHERE project_id = ?
       ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,
                CASE priority WHEN 'high' THEN 0 ELSE 1 END,
                rowid DESC
       LIMIT ?`,
    )
    .all(projectId, limit) as AttentionItemRow[];
}

/** Open items created strictly after a cutoff — the triage trigger test. */
export function countOpenAttentionSince(
  db: GalapagosDb,
  projectId: string,
  cutoffIso: string | null,
): number {
  const row = (
    cutoffIso
      ? db
          .prepare(
            "SELECT COUNT(*) AS total FROM attention_items WHERE project_id = ? AND status = 'open' AND created_at > ?",
          )
          .get(projectId, cutoffIso)
      : db
          .prepare(
            "SELECT COUNT(*) AS total FROM attention_items WHERE project_id = ? AND status = 'open'",
          )
          .get(projectId)
  ) as { total: number };
  return row.total;
}
