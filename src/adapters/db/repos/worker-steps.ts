// Worker plan steps (the goal-progress checklist): the ordered breakdown a
// worker derives from its brief and marks off as it goes. One row per step;
// exactly one may be 'active' at a time. A worker with no rows simply has no
// plan yet — the honest absence is load-bearing, same as the digest.
import { randomUUID } from "node:crypto";
import type { GalapagosDb } from "../db";
import { nowIso } from "../db";

export type WorkerStepStatus = "planned" | "active" | "done" | "abandoned";

export type WorkerStepRow = {
  id: string;
  worker_id: string;
  ordinal: number;
  title: string;
  detail: string | null;
  status: WorkerStepStatus;
  created_at: string;
  updated_at: string;
};

export type PlanStepInput = { title: string; detail?: string };

/** Steps in plan order — the checklist the UI renders top to bottom. */
export function listWorkerSteps(db: GalapagosDb, workerId: string): WorkerStepRow[] {
  return db
    .prepare("SELECT * FROM worker_steps WHERE worker_id = ? ORDER BY ordinal")
    .all(workerId) as WorkerStepRow[];
}

/** Done-count / total for the compact list badge and the progress bar. */
export function countStepsForWorker(
  db: GalapagosDb,
  workerId: string,
): { done: number; total: number } {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done
       FROM worker_steps WHERE worker_id = ?`,
    )
    .get(workerId) as { total: number; done: number };
  return { done: row.done, total: row.total };
}

function insertStep(
  db: GalapagosDb,
  workerId: string,
  ordinal: number,
  step: PlanStepInput,
  status: WorkerStepStatus,
  now: string,
): void {
  db.prepare(
    `INSERT INTO worker_steps (id, worker_id, ordinal, title, detail, status, created_at, updated_at)
     VALUES (@id, @worker_id, @ordinal, @title, @detail, @status, @created_at, @updated_at)`,
  ).run({
    id: randomUUID(),
    worker_id: workerId,
    ordinal,
    title: step.title,
    detail: step.detail ?? null,
    status,
    created_at: now,
    updated_at: now,
  });
}

/**
 * Replace a worker's plan with a fresh set (a re-plan). Completed steps are
 * preserved by title — a mid-task re-plan must not erase the history of what
 * was already finished — everything else is rewritten as 'planned'. Runs in a
 * transaction so the checklist is never observed half-swapped.
 */
export function replacePlanSteps(
  db: GalapagosDb,
  workerId: string,
  steps: PlanStepInput[],
): void {
  const now = nowIso();
  const doneTitles = new Set(
    listWorkerSteps(db, workerId)
      .filter((row) => row.status === "done")
      .map((row) => row.title),
  );
  const swap = db.transaction((next: PlanStepInput[]) => {
    db.prepare("DELETE FROM worker_steps WHERE worker_id = ?").run(workerId);
    next.forEach((step, index) => {
      insertStep(
        db,
        workerId,
        index + 1,
        step,
        doneTitles.has(step.title) ? "done" : "planned",
        now,
      );
    });
  });
  swap(steps);
}

/** Append net-new steps after the current last ordinal, as 'planned'. */
export function appendPlanSteps(db: GalapagosDb, workerId: string, steps: PlanStepInput[]): void {
  if (steps.length === 0) {
    return;
  }
  const now = nowIso();
  const maxRow = db
    .prepare("SELECT COALESCE(MAX(ordinal), 0) AS max FROM worker_steps WHERE worker_id = ?")
    .get(workerId) as { max: number };
  const append = db.transaction((next: PlanStepInput[]) => {
    next.forEach((step, index) => {
      insertStep(db, workerId, maxRow.max + index + 1, step, "planned", now);
    });
  });
  append(steps);
}

/**
 * Mark step `ordinal` active or done. Activating a step demotes any OTHER
 * active step back to 'planned' in the same transaction — exactly one step is
 * ever active. A 'done' step is never disturbed by an activation elsewhere.
 * Returns false (a tolerated no-op) when the ordinal does not exist — a worker
 * that miscounts its own steps must not crash its event loop.
 */
export function applyStepUpdate(
  db: GalapagosDb,
  workerId: string,
  ordinal: number,
  status: "active" | "done",
): boolean {
  const now = nowIso();
  const apply = db.transaction(() => {
    const target = db
      .prepare("SELECT id FROM worker_steps WHERE worker_id = ? AND ordinal = ?")
      .get(workerId, ordinal) as { id: string } | undefined;
    if (!target) {
      return false;
    }
    if (status === "active") {
      db.prepare(
        `UPDATE worker_steps SET status = 'planned', updated_at = @now
         WHERE worker_id = @workerId AND status = 'active' AND ordinal != @ordinal`,
      ).run({ now, workerId, ordinal });
    }
    db.prepare("UPDATE worker_steps SET status = ?, updated_at = ? WHERE id = ?").run(
      status,
      now,
      target.id,
    );
    return true;
  });
  return apply();
}
