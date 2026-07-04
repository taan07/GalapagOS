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

export function markSessionResumed(db: GalapagosDb, sessionId: string): void {
  db.prepare("UPDATE manager_sessions SET last_resumed_at = ? WHERE id = ?").run(
    nowIso(),
    sessionId,
  );
}
