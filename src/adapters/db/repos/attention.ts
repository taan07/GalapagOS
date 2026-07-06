// Attention items (architecture §3): the exception queue. Chunk 3 lands the
// table and the rows (lane_violation at worker stop, unstructured_completion
// for report-less workers); the queue UI and triage arrive in Chunk 4.
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
  | "tool_denied";

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

export function resolveAttentionItem(
  db: GalapagosDb,
  id: string,
  status: "resolved" | "dismissed",
): void {
  db.prepare("UPDATE attention_items SET status = ?, resolved_at = ? WHERE id = ?").run(
    status,
    nowIso(),
    id,
  );
}
