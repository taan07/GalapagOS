import { randomUUID } from "node:crypto";
import type { GalapagosDb } from "../db";
import { nowIso } from "../db";

export type JobRow = {
  id: string;
  kind: string;
  status: string;
  payload: string | null;
  result: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

export function createJob(db: GalapagosDb, kind: string, payload: unknown): JobRow {
  const row: JobRow = {
    id: randomUUID(),
    kind,
    status: "queued",
    payload: payload === undefined ? null : JSON.stringify(payload),
    result: null,
    error: null,
    started_at: null,
    finished_at: null,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO jobs (id, kind, status, payload, result, error, started_at, finished_at, created_at)
     VALUES (@id, @kind, @status, @payload, @result, @error, @started_at, @finished_at, @created_at)`,
  ).run(row);
  return row;
}

export function startJob(db: GalapagosDb, jobId: string): void {
  db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?").run(
    nowIso(),
    jobId,
  );
}

export function finishJob(db: GalapagosDb, jobId: string, result: unknown): void {
  db.prepare("UPDATE jobs SET status = 'done', result = ?, finished_at = ? WHERE id = ?").run(
    JSON.stringify(result ?? null),
    nowIso(),
    jobId,
  );
}

/** Newest first — for "when did this last run for project X" questions. */
export function listRecentJobsByKind(db: GalapagosDb, kind: string, limit = 100): JobRow[] {
  return db
    .prepare("SELECT * FROM jobs WHERE kind = ? ORDER BY rowid DESC LIMIT ?")
    .all(kind, limit) as JobRow[];
}

/**
 * The newest job of a kind whose payload carries the given key/value —
 * how leg verdicts (watchdog/critic reviews) are found for a worker without
 * a dedicated table (jobs IS the §3 job log). SQL-filtered rather than a
 * bounded scan (coverage audit 2026-07-05): a busy multi-project db must
 * not scroll this worker's verdict past a fixed window. Values are UUIDs —
 * the JSON.stringify key:value substring is exact and wildcard-free.
 */
export function latestJobByPayload(
  db: GalapagosDb,
  kind: string,
  key: string,
  value: string,
): JobRow | undefined {
  const candidates = db
    .prepare(
      "SELECT * FROM jobs WHERE kind = ? AND payload LIKE ? ORDER BY rowid DESC LIMIT 10",
    )
    .all(kind, `%"${key}":"${value}"%`) as JobRow[];
  for (const job of candidates) {
    try {
      const payload = JSON.parse(job.payload ?? "{}") as Record<string, unknown>;
      if (payload[key] === value) {
        return job;
      }
    } catch {
      // Unparseable payload — not a match.
    }
  }
  return undefined;
}

export function failJob(db: GalapagosDb, jobId: string, error: string): void {
  db.prepare("UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(
    error,
    nowIso(),
    jobId,
  );
}
