// Completion digests (architecture §3/§6): the parsed galapagos-completion
// report of a worker. A worker with no digest row is never rendered done —
// the honest absence is load-bearing.
import { randomUUID } from "node:crypto";
import type { GalapagosDb } from "../db";
import { nowIso } from "../db";

export type CompletionDigestStatus = "parsed" | "manager_reviewed" | "escalated";

export type CompletionDigestRow = {
  id: string;
  worker_id: string;
  narrative: string;
  before_after: string;
  claims: string;
  touched_areas: string;
  status: CompletionDigestStatus;
  created_at: string;
};

export function createCompletionDigest(
  db: GalapagosDb,
  input: {
    workerId: string;
    narrative: string;
    beforeAfter: unknown[];
    claims: unknown[];
    touchedAreas: string[];
  },
): CompletionDigestRow {
  const row: CompletionDigestRow = {
    id: randomUUID(),
    worker_id: input.workerId,
    narrative: input.narrative,
    before_after: JSON.stringify(input.beforeAfter),
    claims: JSON.stringify(input.claims),
    touched_areas: JSON.stringify(input.touchedAreas),
    status: "parsed",
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO completion_digests (id, worker_id, narrative, before_after, claims, touched_areas, status, created_at)
     VALUES (@id, @worker_id, @narrative, @before_after, @claims, @touched_areas, @status, @created_at)`,
  ).run(row);
  return row;
}

/** The latest digest wins — a steered worker may complete more than once. */
export function latestDigestForWorker(
  db: GalapagosDb,
  workerId: string,
): CompletionDigestRow | undefined {
  return db
    .prepare("SELECT * FROM completion_digests WHERE worker_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(workerId) as CompletionDigestRow | undefined;
}
