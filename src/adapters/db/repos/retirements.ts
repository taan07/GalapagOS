import type { GalapagosDb } from "../db";
import { nowIso } from "../db";

export type RetirementStatus = "pending" | "running" | "succeeded" | "failed";
export type RetirementFailureKind = "transient" | "non_retryable";

export type CompletionRetirementRow = {
  digest_id: string;
  project_id: string;
  worker_id: string;
  status: RetirementStatus;
  attempts: number;
  failure_kind: RetirementFailureKind | null;
  last_error: string | null;
  last_attempt_at: string | null;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Create the retirement obligation without confusing it with verification. */
export function ensureCompletionRetirement(
  db: GalapagosDb,
  input: { digestId: string; projectId: string; workerId: string; at?: string },
): CompletionRetirementRow {
  const at = input.at ?? nowIso();
  db.prepare(
    `INSERT OR IGNORE INTO completion_retirements
       (digest_id, project_id, worker_id, status, attempts, failure_kind,
        last_error, last_attempt_at, retired_at, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(input.digestId, input.projectId, input.workerId, at, at);
  const row = getCompletionRetirement(db, input.digestId);
  if (!row) {
    throw new Error(`Could not create retirement state for digest ${input.digestId}.`);
  }
  return row;
}

export function getCompletionRetirement(
  db: GalapagosDb,
  digestId: string,
): CompletionRetirementRow | undefined {
  return db.prepare("SELECT * FROM completion_retirements WHERE digest_id = ?").get(digestId) as
    | CompletionRetirementRow
    | undefined;
}

/**
 * Reconstruct obligations after a deploy that died between verification and
 * the stop. Existing reviewed digests are never reinterpreted; only a missing
 * retirement fact is added.
 */
export function ensureReviewedRetirements(
  db: GalapagosDb,
  projectId: string,
  at = nowIso(),
): number {
  const result = db.prepare(
    `INSERT OR IGNORE INTO completion_retirements
       (digest_id, project_id, worker_id, status, attempts, failure_kind,
        last_error, last_attempt_at, retired_at, created_at, updated_at)
     SELECT d.id, w.project_id, d.worker_id, 'pending', 0, NULL,
            NULL, NULL, NULL, ?, ?
      FROM completion_digests d
      JOIN workers w ON w.id = d.worker_id
      WHERE w.project_id = ? AND d.status = 'manager_reviewed'
        AND d.rowid = (
          SELECT MAX(newest.rowid) FROM completion_digests newest
           WHERE newest.worker_id = d.worker_id
        )`,
  ).run(at, at, projectId);
  return result.changes;
}

/** Pending, interrupted-running, and transient failures are safe to retry. */
export function listRetryableRetirements(
  db: GalapagosDb,
  projectId: string,
): CompletionRetirementRow[] {
  return db.prepare(
    `SELECT * FROM completion_retirements
      WHERE project_id = ?
        AND (status IN ('pending', 'running')
          OR (status = 'failed' AND failure_kind = 'transient'))
      ORDER BY created_at, rowid`,
  ).all(projectId) as CompletionRetirementRow[];
}

export function startRetirementAttempt(
  db: GalapagosDb,
  digestId: string,
  at = nowIso(),
): CompletionRetirementRow {
  db.prepare(
    `UPDATE completion_retirements
        SET status = 'running', attempts = attempts + 1, failure_kind = NULL,
            last_error = NULL, last_attempt_at = ?, updated_at = ?
      WHERE digest_id = ? AND status != 'succeeded'`,
  ).run(at, at, digestId);
  const row = getCompletionRetirement(db, digestId);
  if (!row) {
    throw new Error(`Unknown retirement state for digest ${digestId}.`);
  }
  return row;
}

export function succeedRetirement(
  db: GalapagosDb,
  digestId: string,
  at = nowIso(),
): void {
  db.prepare(
    `UPDATE completion_retirements
        SET status = 'succeeded', failure_kind = NULL, last_error = NULL,
            retired_at = ?, updated_at = ?
      WHERE digest_id = ?`,
  ).run(at, at, digestId);
}

export function failRetirement(
  db: GalapagosDb,
  input: {
    digestId: string;
    kind: RetirementFailureKind;
    error: string;
    at?: string;
  },
): void {
  const at = input.at ?? nowIso();
  db.prepare(
    `UPDATE completion_retirements
        SET status = 'failed', failure_kind = ?, last_error = ?, updated_at = ?
      WHERE digest_id = ?`,
  ).run(input.kind, input.error, at, input.digestId);
}
