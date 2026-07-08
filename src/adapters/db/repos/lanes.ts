// Lane rows (architecture §7): a lane is an exclusive file-scope contract —
// allowed/forbidden picomatch globs plus the base sha work forks from. The
// pure overlap/violation logic lives in core/lanes/lane-check.ts; this repo
// only persists and queries the rows.
import { randomUUID } from "node:crypto";
import type { GalapagosDb } from "../db";
import { nowIso } from "../db";

export type LaneStatus = "active" | "retired";

export type LaneRow = {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  allowed_globs: string;
  forbidden_globs: string;
  base_sha: string;
  status: LaneStatus;
  created_at: string;
};

export function createLane(
  db: GalapagosDb,
  input: {
    projectId: string;
    name: string;
    slug: string;
    allowedGlobs: string[];
    forbiddenGlobs: string[];
    baseSha: string;
  },
): LaneRow {
  const row: LaneRow = {
    id: randomUUID(),
    project_id: input.projectId,
    name: input.name,
    slug: input.slug,
    allowed_globs: JSON.stringify(input.allowedGlobs),
    forbidden_globs: JSON.stringify(input.forbiddenGlobs),
    base_sha: input.baseSha,
    status: "active",
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO lanes (id, project_id, name, slug, allowed_globs, forbidden_globs, base_sha, status, created_at)
     VALUES (@id, @project_id, @name, @slug, @allowed_globs, @forbidden_globs, @base_sha, @status, @created_at)`,
  ).run(row);
  return row;
}

export function getLane(db: GalapagosDb, id: string): LaneRow | undefined {
  return db.prepare("SELECT * FROM lanes WHERE id = ?").get(id) as LaneRow | undefined;
}

export function listActiveLanes(db: GalapagosDb, projectId: string): LaneRow[] {
  return db
    .prepare("SELECT * FROM lanes WHERE project_id = ? AND status = 'active' ORDER BY rowid")
    .all(projectId) as LaneRow[];
}

export function retireLane(db: GalapagosDb, id: string): void {
  db.prepare("UPDATE lanes SET status = 'retired' WHERE id = ?").run(id);
}

/**
 * Re-activate a retired lane for a resumed worker (user-confirmed
 * continuation ruling). The caller MUST re-check glob overlap against
 * currently active lanes first — exclusivity holds across resume too.
 */
export function reactivateLane(db: GalapagosDb, id: string): void {
  db.prepare("UPDATE lanes SET status = 'active' WHERE id = ?").run(id);
}

/**
 * Replace a lane's allowed globs (user-approved amendment — the gate and the
 * overlap re-check live in the caller). The at-stop audit reads this row, so
 * the detective layer judges against the amended contract.
 */
export function amendLaneGlobs(db: GalapagosDb, id: string, allowedGlobs: string[]): void {
  db.prepare("UPDATE lanes SET allowed_globs = ? WHERE id = ?").run(
    JSON.stringify(allowedGlobs),
    id,
  );
}

export function laneGlobs(lane: LaneRow): { allowedGlobs: string[]; forbiddenGlobs: string[] } {
  return {
    allowedGlobs: JSON.parse(lane.allowed_globs) as string[],
    forbiddenGlobs: JSON.parse(lane.forbidden_globs) as string[],
  };
}
