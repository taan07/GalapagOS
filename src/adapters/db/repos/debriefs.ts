import { randomUUID } from "node:crypto";
import type { GalapagosDb } from "../db";
import { nowIso } from "../db";

export const DEBRIEF_MAX_ATTEMPTS = 3;
export const DEBRIEF_RETRY_DELAYS_MS = [30_000, 120_000] as const;

export type DebriefFailureKind = "transient" | "non_retryable";
export type DebriefStatus = "pending" | "running" | "succeeded" | "failed";

export type CompletionDebriefRow = {
  digest_id: string;
  project_id: string;
  worker_id: string;
  status: DebriefStatus;
  attempts: number;
  due_at: string;
  last_failure_kind: DebriefFailureKind | null;
  last_error_code: string | null;
  last_error: string | null;
  last_attempt_at: string | null;
  narrated_at: string | null;
  attention_id: string | null;
  created_at: string;
  updated_at: string;
};

export type CompletionDebriefAttemptRow = {
  id: string;
  digest_id: string;
  attempt_number: number;
  status: "running" | "succeeded" | "failed";
  context: string;
  failure_kind: DebriefFailureKind | null;
  error_code: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

export function getCompletionDebrief(
  db: GalapagosDb,
  digestId: string,
): CompletionDebriefRow | undefined {
  return db.prepare("SELECT * FROM completion_debriefs WHERE digest_id = ?").get(digestId) as
    | CompletionDebriefRow
    | undefined;
}

export function ensureCompletionDebrief(
  db: GalapagosDb,
  input: { digestId: string; projectId: string; workerId: string; at?: string },
): CompletionDebriefRow {
  const at = input.at ?? nowIso();
  db.prepare(
    `INSERT OR IGNORE INTO completion_debriefs
       (digest_id, project_id, worker_id, status, attempts, due_at,
        last_failure_kind, last_error_code, last_error, last_attempt_at,
        narrated_at, attention_id, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(input.digestId, input.projectId, input.workerId, at, at, at);
  const row = getCompletionDebrief(db, input.digestId);
  if (!row) {
    throw new Error(`Could not create debrief state for digest ${input.digestId}.`);
  }
  return row;
}

/** Recover verified digests whose process died before it queued narration. */
export function ensureReviewedDebriefs(
  db: GalapagosDb,
  projectId: string,
  at = nowIso(),
): number {
  return db.prepare(
    `INSERT OR IGNORE INTO completion_debriefs
       (digest_id, project_id, worker_id, status, attempts, due_at,
        last_failure_kind, last_error_code, last_error, last_attempt_at,
        narrated_at, attention_id, created_at, updated_at)
     SELECT d.id, w.project_id, d.worker_id, 'pending', 0, ?,
            NULL, NULL, NULL, NULL, NULL, NULL, ?, ?
       FROM completion_digests d
       JOIN workers w ON w.id = d.worker_id
      WHERE w.project_id = ? AND d.status = 'manager_reviewed'
        AND d.rowid = (
          SELECT MAX(newest.rowid) FROM completion_digests newest
           WHERE newest.worker_id = d.worker_id
        )`,
  ).run(at, at, at, projectId).changes;
}

export function nextDueDebrief(
  db: GalapagosDb,
  projectId: string,
  at = nowIso(),
): CompletionDebriefRow | undefined {
  return db.prepare(
    `SELECT * FROM completion_debriefs
      WHERE project_id = ? AND due_at <= ?
        AND (status = 'pending'
          OR (status = 'failed' AND last_failure_kind = 'transient'
              AND attempts < ?))
      ORDER BY due_at, created_at, rowid LIMIT 1`,
  ).get(projectId, at, DEBRIEF_MAX_ATTEMPTS) as CompletionDebriefRow | undefined;
}

/** Claim immediately before runManagerTurn begins; queued/busy time is free. */
export function startDebriefAttempt(
  db: GalapagosDb,
  input: { digestId: string; context: unknown; at?: string },
): CompletionDebriefAttemptRow {
  const at = input.at ?? nowIso();
  return db.transaction(() => {
    const current = getCompletionDebrief(db, input.digestId);
    if (!current || current.status === "succeeded" || current.attempts >= DEBRIEF_MAX_ATTEMPTS) {
      throw new Error(`Debrief ${input.digestId} is not claimable.`);
    }
    const history = db.prepare(
      "SELECT MAX(attempt_number) AS max_attempt FROM completion_debrief_attempts WHERE digest_id = ?",
    ).get(current.digest_id) as { max_attempt: number | null };
    const attemptNumber = (history.max_attempt ?? 0) + 1;
    const cycleAttempts = current.attempts + 1;
    const attempt: CompletionDebriefAttemptRow = {
      id: randomUUID(),
      digest_id: current.digest_id,
      attempt_number: attemptNumber,
      status: "running",
      context: JSON.stringify(input.context),
      failure_kind: null,
      error_code: null,
      error: null,
      started_at: at,
      finished_at: null,
    };
    db.prepare(
      `UPDATE completion_debriefs
          SET status = 'running', attempts = ?, last_failure_kind = NULL,
              last_error_code = NULL, last_error = NULL,
              last_attempt_at = ?, updated_at = ?
        WHERE digest_id = ?`,
    ).run(cycleAttempts, at, at, current.digest_id);
    db.prepare(
      `INSERT INTO completion_debrief_attempts
         (id, digest_id, attempt_number, status, context, failure_kind,
          error_code, error, started_at, finished_at)
       VALUES (@id, @digest_id, @attempt_number, @status, @context,
               @failure_kind, @error_code, @error, @started_at, @finished_at)`,
    ).run(attempt);
    return attempt;
  })();
}

export function succeedDebriefAttempt(
  db: GalapagosDb,
  input: { digestId: string; attemptId: string; at?: string },
): void {
  const at = input.at ?? nowIso();
  db.transaction(() => {
    db.prepare(
      `UPDATE completion_debrief_attempts
          SET status = 'succeeded', finished_at = ? WHERE id = ?`,
    ).run(at, input.attemptId);
    db.prepare(
      `UPDATE completion_debriefs
          SET status = 'succeeded', due_at = ?, last_failure_kind = NULL,
              last_error_code = NULL, last_error = NULL,
              narrated_at = ?, updated_at = ? WHERE digest_id = ?`,
    ).run(at, at, at, input.digestId);
  })();
}

function nextDueAt(at: string, attempts: number, kind: DebriefFailureKind): string {
  if (kind === "non_retryable" || attempts >= DEBRIEF_MAX_ATTEMPTS) {
    return at;
  }
  const delay = DEBRIEF_RETRY_DELAYS_MS[attempts - 1] ?? 0;
  return new Date(Date.parse(at) + delay).toISOString();
}

export function failDebriefAttempt(
  db: GalapagosDb,
  input: {
    digestId: string;
    attemptId: string;
    kind: DebriefFailureKind;
    errorCode: string;
    error: string;
    at?: string;
  },
): CompletionDebriefRow {
  const at = input.at ?? nowIso();
  return db.transaction(() => {
    const current = getCompletionDebrief(db, input.digestId);
    if (!current) {
      throw new Error(`Unknown debrief ${input.digestId}.`);
    }
    db.prepare(
      `UPDATE completion_debrief_attempts
          SET status = 'failed', failure_kind = ?, error_code = ?, error = ?, finished_at = ?
        WHERE id = ?`,
    ).run(input.kind, input.errorCode, input.error, at, input.attemptId);
    db.prepare(
      `UPDATE completion_debriefs
          SET status = 'failed', due_at = ?, last_failure_kind = ?,
              last_error_code = ?, last_error = ?, updated_at = ?
        WHERE digest_id = ?`,
    ).run(
      nextDueAt(at, current.attempts, input.kind),
      input.kind,
      input.errorCode,
      input.error,
      at,
      input.digestId,
    );
    return getCompletionDebrief(db, input.digestId)!;
  })();
}

/** Preflight failed before a model call, so attempts intentionally stays put. */
export function failDebriefPreflight(
  db: GalapagosDb,
  input: {
    digestId: string;
    kind: DebriefFailureKind;
    errorCode: string;
    error: string;
    at?: string;
  },
): CompletionDebriefRow {
  const at = input.at ?? nowIso();
  const dueAt = input.kind === "transient"
    ? new Date(Date.parse(at) + 5_000).toISOString()
    : at;
  db.prepare(
    `UPDATE completion_debriefs
        SET status = 'failed', due_at = ?, last_failure_kind = ?,
            last_error_code = ?, last_error = ?, updated_at = ?
      WHERE digest_id = ?`,
  ).run(dueAt, input.kind, input.errorCode, input.error, at, input.digestId);
  const row = getCompletionDebrief(db, input.digestId);
  if (!row) {
    throw new Error(`Unknown debrief ${input.digestId}.`);
  }
  return row;
}

/** A dead process left a real model attempt running; consume it honestly. */
export function recoverRunningDebriefs(db: GalapagosDb, at = nowIso()): CompletionDebriefRow[] {
  const running = db.prepare(
    "SELECT * FROM completion_debriefs WHERE status = 'running' ORDER BY rowid",
  ).all() as CompletionDebriefRow[];
  return running.map((row) => {
    const attempt = db.prepare(
      `SELECT * FROM completion_debrief_attempts
        WHERE digest_id = ? AND status = 'running'
        ORDER BY attempt_number DESC LIMIT 1`,
    ).get(row.digest_id) as CompletionDebriefAttemptRow | undefined;
    if (!attempt) {
      // Defensive legacy/corruption recovery: synthesize the diagnostic row.
      const history = db.prepare(
        "SELECT MAX(attempt_number) AS max_attempt FROM completion_debrief_attempts WHERE digest_id = ?",
      ).get(row.digest_id) as { max_attempt: number | null };
      const synthetic: CompletionDebriefAttemptRow = {
        id: randomUUID(),
        digest_id: row.digest_id,
        attempt_number: (history.max_attempt ?? 0) + 1,
        status: "running",
        context: JSON.stringify({ recovery: "running debrief had no attempt row" }),
        failure_kind: null,
        error_code: null,
        error: null,
        started_at: row.last_attempt_at ?? at,
        finished_at: null,
      };
      db.prepare(
        `INSERT INTO completion_debrief_attempts
           (id, digest_id, attempt_number, status, context, failure_kind,
            error_code, error, started_at, finished_at)
         VALUES (@id, @digest_id, @attempt_number, @status, @context,
                 @failure_kind, @error_code, @error, @started_at, @finished_at)`,
      ).run(synthetic);
      return failDebriefAttempt(db, {
        digestId: row.digest_id,
        attemptId: synthetic.id,
        kind: "transient",
        errorCode: "daemon_restart",
        error: "Daemon restarted while the debrief attempt was running.",
        at,
      });
    }
    return failDebriefAttempt(db, {
      digestId: row.digest_id,
      attemptId: attempt.id,
      kind: "transient",
      errorCode: "daemon_restart",
      error: "Daemon restarted while the debrief attempt was running.",
      at,
    });
  });
}

export function listDebriefAttempts(
  db: GalapagosDb,
  digestId: string,
): CompletionDebriefAttemptRow[] {
  return db.prepare(
    "SELECT * FROM completion_debrief_attempts WHERE digest_id = ? ORDER BY attempt_number",
  ).all(digestId) as CompletionDebriefAttemptRow[];
}

export function linkDebriefAttention(
  db: GalapagosDb,
  digestId: string,
  attentionId: string | null,
): void {
  db.prepare(
    "UPDATE completion_debriefs SET attention_id = ?, updated_at = ? WHERE digest_id = ?",
  ).run(attentionId, nowIso(), digestId);
}

export function debriefForAttention(
  db: GalapagosDb,
  attentionId: string,
): CompletionDebriefRow | undefined {
  return db.prepare("SELECT * FROM completion_debriefs WHERE attention_id = ?").get(attentionId) as
    | CompletionDebriefRow
    | undefined;
}

export function rearmDebrief(
  db: GalapagosDb,
  digestId: string,
  at = nowIso(),
): CompletionDebriefRow {
  db.prepare(
    `UPDATE completion_debriefs
        SET status = 'pending', attempts = 0, due_at = ?,
            last_failure_kind = NULL, last_error_code = NULL, last_error = NULL,
            last_attempt_at = NULL, narrated_at = NULL, updated_at = ?
      WHERE digest_id = ? AND status = 'failed'`,
  ).run(at, at, digestId);
  const row = getCompletionDebrief(db, digestId);
  if (!row) {
    throw new Error(`Unknown debrief ${digestId}.`);
  }
  return row;
}
