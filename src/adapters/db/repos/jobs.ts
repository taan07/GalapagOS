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

export function failJob(db: GalapagosDb, jobId: string, error: string): void {
  db.prepare("UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(
    error,
    nowIso(),
    jobId,
  );
}
