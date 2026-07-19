import { randomUUID } from "node:crypto";
import type { GalapagosDb } from "../db";
import { nowIso } from "../db";

export type ManagerSessionRow = {
  id: string;
  project_id: string;
  sdk_session_id: string | null;
  status: string;
  seeded_from_records_at: string | null;
  created_at: string;
  last_resumed_at: string | null;
};

export type ManagerTurnRole = "user" | "assistant" | "tool" | "system";

export type ManagerTurnRow = {
  id: string;
  session_id: string;
  turn_index: number;
  role: ManagerTurnRole;
  content: string;
  sdk_session_id_after: string | null;
  distilled_at: string | null;
  created_at: string;
};

export function getOrCreateActiveSession(db: GalapagosDb, projectId: string): ManagerSessionRow {
  const existing = db
    .prepare(
      "SELECT * FROM manager_sessions WHERE project_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    )
    .get(projectId) as ManagerSessionRow | undefined;
  if (existing) {
    return existing;
  }

  const row: ManagerSessionRow = {
    id: randomUUID(),
    project_id: projectId,
    sdk_session_id: null,
    status: "active",
    seeded_from_records_at: null,
    created_at: nowIso(),
    last_resumed_at: null,
  };
  db.prepare(
    `INSERT INTO manager_sessions (id, project_id, sdk_session_id, status, seeded_from_records_at, created_at, last_resumed_at)
     VALUES (@id, @project_id, @sdk_session_id, @status, @seeded_from_records_at, @created_at, @last_resumed_at)`,
  ).run(row);
  return row;
}

export function latestSdkSessionId(db: GalapagosDb, sessionId: string): string | null {
  const turn = db
    .prepare(
      "SELECT sdk_session_id_after FROM manager_turns WHERE session_id = ? AND sdk_session_id_after IS NOT NULL ORDER BY turn_index DESC LIMIT 1",
    )
    .get(sessionId) as { sdk_session_id_after: string | null } | undefined;
  return turn?.sdk_session_id_after ?? null;
}

export function appendTurn(
  db: GalapagosDb,
  input: {
    sessionId: string;
    role: ManagerTurnRole;
    content: string;
    sdkSessionIdAfter?: string | null;
  },
): ManagerTurnRow {
  const insert = db.transaction((): ManagerTurnRow => {
    const last = db
      .prepare("SELECT MAX(turn_index) AS max_index FROM manager_turns WHERE session_id = ?")
      .get(input.sessionId) as { max_index: number | null };
    const row: ManagerTurnRow = {
      id: randomUUID(),
      session_id: input.sessionId,
      turn_index: (last.max_index ?? -1) + 1,
      role: input.role,
      content: input.content,
      sdk_session_id_after: input.sdkSessionIdAfter ?? null,
      distilled_at: null,
      created_at: nowIso(),
    };
    db.prepare(
      `INSERT INTO manager_turns (id, session_id, turn_index, role, content, sdk_session_id_after, distilled_at, created_at)
       VALUES (@id, @session_id, @turn_index, @role, @content, @sdk_session_id_after, @distilled_at, @created_at)`,
    ).run(row);
    return row;
  });
  return insert();
}

export function updateTurnSdkSessionId(
  db: GalapagosDb,
  turnId: string,
  sdkSessionId: string,
): void {
  db.prepare("UPDATE manager_turns SET sdk_session_id_after = ? WHERE id = ?").run(
    sdkSessionId,
    turnId,
  );
}

export function listTurns(db: GalapagosDb, sessionId: string): ManagerTurnRow[] {
  return db
    .prepare("SELECT * FROM manager_turns WHERE session_id = ? ORDER BY turn_index")
    .all(sessionId) as ManagerTurnRow[];
}

export function deleteTurns(db: GalapagosDb, turnIds: string[]): void {
  const remove = db.prepare("DELETE FROM manager_turns WHERE id = ?");
  const removeAll = db.transaction((ids: string[]) => {
    for (const id of ids) {
      remove.run(id);
    }
  });
  removeAll(turnIds);
}

export function markSessionResumed(db: GalapagosDb, sessionId: string): void {
  db.prepare("UPDATE manager_sessions SET last_resumed_at = ? WHERE id = ?").run(
    nowIso(),
    sessionId,
  );
}

/**
 * Compact-by-re-brief: retire the unresumable session and open a fresh one.
 * By default the fresh session is seeded from records; pass
 * `seededFromRecords: false` for a deliberate blank restart (the user cleared
 * a re-brief). One transaction — there is never a moment with two active
 * sessions for a project.
 */
export function compactSession(
  db: GalapagosDb,
  projectId: string,
  oldSessionId: string,
  options: { seededFromRecords?: boolean } = {},
): ManagerSessionRow {
  const swap = db.transaction((): ManagerSessionRow => {
    db.prepare("UPDATE manager_sessions SET status = 'compacted' WHERE id = ?").run(oldSessionId);
    const row: ManagerSessionRow = {
      id: randomUUID(),
      project_id: projectId,
      sdk_session_id: null,
      status: "active",
      seeded_from_records_at: options.seededFromRecords === false ? null : nowIso(),
      created_at: nowIso(),
      last_resumed_at: null,
    };
    db.prepare(
      `INSERT INTO manager_sessions (id, project_id, sdk_session_id, status, seeded_from_records_at, created_at, last_resumed_at)
       VALUES (@id, @project_id, @sdk_session_id, @status, @seeded_from_records_at, @created_at, @last_resumed_at)`,
    ).run(row);
    return row;
  });
  return swap();
}

/**
 * The session most recently compacted for a project — where a proactive
 * re-brief finds the conversational tail the compaction left undistilled.
 */
export function latestCompactedSessionId(db: GalapagosDb, projectId: string): string | null {
  const row = db
    .prepare(
      `SELECT id FROM manager_sessions
       WHERE project_id = ? AND status = 'compacted'
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(projectId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * A session's conversational turns no distill pass ever covered — the live
 * delta the record store does not hold. System turns carry no context.
 */
export function listUndistilledTurns(db: GalapagosDb, sessionId: string): ManagerTurnRow[] {
  return db
    .prepare(
      `SELECT * FROM manager_turns
       WHERE session_id = ? AND distilled_at IS NULL AND role != 'system'
       ORDER BY turn_index`,
    )
    .all(sessionId) as ManagerTurnRow[];
}

/** Chat history for a project spans compacted sessions — memory survives. */
export function listProjectTurns(db: GalapagosDb, projectId: string): ManagerTurnRow[] {
  // rowid = insertion order: same-millisecond turns across a compaction
  // boundary would tie on created_at.
  return db
    .prepare(
      `SELECT manager_turns.* FROM manager_turns
       JOIN manager_sessions ON manager_sessions.id = manager_turns.session_id
       WHERE manager_sessions.project_id = ?
       ORDER BY manager_turns.rowid`,
    )
    .all(projectId) as ManagerTurnRow[];
}

export function getTurn(db: GalapagosDb, turnId: string): ManagerTurnRow | undefined {
  return db.prepare("SELECT * FROM manager_turns WHERE id = ?").get(turnId) as
    | ManagerTurnRow
    | undefined;
}

/** Replace a turn's content payload (used to stamp a re-brief as cleared). */
export function updateTurnContent(db: GalapagosDb, turnId: string, content: string): void {
  db.prepare("UPDATE manager_turns SET content = ? WHERE id = ?").run(content, turnId);
}

/** Pending triage cards are linked to their durable attention item in the
 * persisted payload. Resolution scans this small system-turn set so a stale
 * card cannot outlive the question it represented. */
export function pendingDecisionIdsForAttention(db: GalapagosDb, attentionId: string): string[] {
  const rows = db
    .prepare(
      `SELECT content FROM manager_turns
       WHERE role = 'system' AND content LIKE '%"kind":"decision"%' AND content LIKE '%"status":"pending"%'`,
    )
    .all() as { content: string }[];
  const ids: string[] = [];
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.content) as {
        kind?: string;
        status?: string;
        decisionId?: string;
        attentionId?: string;
      };
      if (
        payload.kind === "decision" &&
        payload.status === "pending" &&
        payload.attentionId === attentionId &&
        payload.decisionId
      ) {
        ids.push(payload.decisionId);
      }
    } catch {
      // Not a decision payload.
    }
  }
  return ids;
}

/**
 * Boot hygiene for the chat decision channel: a decision pending when the
 * daemon died has lost its in-memory owner (and its promise died with the
 * process) — stamp it expired so the UI never offers dead buttons. This is
 * restart recovery, never a decision timeout.
 */
export function sweepPendingDecisionTurns(db: GalapagosDb): number {
  const rows = db
    .prepare(
      `SELECT id, content FROM manager_turns
       WHERE role = 'system' AND content LIKE '%"kind":"decision"%' AND content LIKE '%"status":"pending"%'`,
    )
    .all() as { id: string; content: string }[];
  let swept = 0;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.content) as { kind?: string; status?: string };
      if (payload.kind === "decision" && payload.status === "pending") {
        updateTurnContent(db, row.id, JSON.stringify({ ...payload, status: "expired" }));
        swept += 1;
      }
    } catch {
      // not JSON — not a decision turn
    }
  }
  return swept;
}

/**
 * Stamp every not-yet-distilled turn of a session as covered. `before` bounds
 * the claim to turns that existed when the distill pass forked: a user turn
 * persisted while the pass was still running was never in its fork, and a
 * blanket stamp would silently exclude it from distillation forever.
 */
export function markTurnsDistilled(db: GalapagosDb, sessionId: string, before?: string): void {
  if (before) {
    db.prepare(
      "UPDATE manager_turns SET distilled_at = ? WHERE session_id = ? AND distilled_at IS NULL AND created_at < ?",
    ).run(nowIso(), sessionId, before);
    return;
  }
  db.prepare(
    "UPDATE manager_turns SET distilled_at = ? WHERE session_id = ? AND distilled_at IS NULL",
  ).run(nowIso(), sessionId);
}
