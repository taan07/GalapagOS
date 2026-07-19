import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type GalapagosDb } from "../src/adapters/db/db";
import { registerProject, type ProjectRow } from "../src/adapters/db/repos/projects";
import {
  appendTurn,
  compactSession,
  getOrCreateActiveSession,
  latestCompactedSessionId,
  listUndistilledTurns,
  markTurnsDistilled,
} from "../src/adapters/db/repos/manager";
import { findUnclearedRebriefMarker, rebriefPrompt } from "../src/adapters/agent/manager-session";

const TEST_GIT_IDENTITY = { name: "Galapagos Tests", email: "tests@galapagos.local" };

async function fixture(): Promise<{ db: GalapagosDb; project: ProjectRow }> {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-ctx-state-"));
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "glp-ctx-proj-"));
  writeFileSync(path.join(projectDir, "README.md"), "fixture\n");
  const db = openDb(stateDir);
  const project = await registerProject(db, {
    rootPath: projectDir,
    initGit: true,
    gitIdentity: TEST_GIT_IDENTITY,
  });
  return { db, project };
}

test("latestCompactedSessionId returns the just-compacted session, project-scoped", async () => {
  const { db, project } = await fixture();
  const other = await fixture();

  const s1 = getOrCreateActiveSession(db, project.id);
  assert.equal(latestCompactedSessionId(db, project.id), null, "nothing compacted yet");

  // Another project's compaction must never leak in (also exercises the
  // second db handle staying separate — projects are scoped per query).
  const otherSession = getOrCreateActiveSession(other.db, other.project.id);
  compactSession(other.db, other.project.id, otherSession.id);
  assert.equal(latestCompactedSessionId(db, project.id), null);

  compactSession(db, project.id, s1.id);
  assert.equal(latestCompactedSessionId(db, project.id), s1.id);

  // A second compaction supersedes the first as "latest".
  const s2 = getOrCreateActiveSession(db, project.id);
  compactSession(db, project.id, s2.id);
  assert.equal(latestCompactedSessionId(db, project.id), s2.id);
});

test("listUndistilledTurns: system turns and distilled turns carry no thread state", async () => {
  const { db, project } = await fixture();
  const session = getOrCreateActiveSession(db, project.id);

  appendTurn(db, { sessionId: session.id, role: "user", content: "old, distilled" });
  appendTurn(db, { sessionId: session.id, role: "assistant", content: "old reply" });
  markTurnsDistilled(db, session.id);
  appendTurn(db, { sessionId: session.id, role: "user", content: "fresh question" });
  appendTurn(db, { sessionId: session.id, role: "system", content: "{\"kind\":\"rebrief\"}" });
  appendTurn(db, { sessionId: session.id, role: "assistant", content: "fresh reply" });

  const tail = listUndistilledTurns(db, session.id).map((turn) => turn.content);
  assert.deepEqual(tail, ["fresh question", "fresh reply"]);
});

test("daemon-authored inputs stay auditable but never read as user thread state", async () => {
  const { db, project } = await fixture();
  const session = getOrCreateActiveSession(db, project.id);
  const synthetic = appendTurn(db, {
    sessionId: session.id,
    role: "system",
    content: JSON.stringify({ kind: "synthetic_input", inputKind: "lane_guard", text: "SYSTEM — automatic lane guard" }),
    inputOrigin: "daemon",
    inputKind: "lane_guard",
  });
  appendTurn(db, { sessionId: session.id, role: "assistant", content: "I held the worker." });
  appendTurn(db, { sessionId: session.id, role: "user", content: "Please keep me posted." });
  assert.equal(synthetic.input_origin, "daemon");
  assert.equal(synthetic.input_kind, "lane_guard");
  assert.equal(synthetic.role, "system", "daemon input never masquerades as a user turn");
  assert.deepEqual(
    listUndistilledTurns(db, session.id).map((turn) => turn.content),
    ["I held the worker.", "Please keep me posted."],
    "synthetic prompt text is not re-brief/user-intent material; resulting assistant output remains",
  );
});

test("re-brief labels daemon audit input truthfully while preserving its raw SDK prompt", () => {
  const prompt = rebriefPrompt("# records", "SYSTEM — hold the lane", "daemon");
  assert.match(prompt, /autonomous system input/);
  assert.match(prompt, /SYSTEM — hold the lane$/);
  assert.doesNotMatch(prompt, /user's message/);
});

test("findUnclearedRebriefMarker: the failed-first-attempt sequence reuses, never re-compacts", async () => {
  const { db, project } = await fixture();
  const session = getOrCreateActiveSession(db, project.id);

  assert.equal(findUnclearedRebriefMarker(db, session.id), null, "no marker on a fresh session");

  // The proactive path persisted its marker, then the first turn FAILED,
  // leaving the (unanswered) user turn behind — the exact sequence that made
  // hasHistory true and double-compacted before the fix.
  appendTurn(db, { sessionId: session.id, role: "user", content: "the message that failed" });
  appendTurn(db, {
    sessionId: session.id,
    role: "system",
    content: JSON.stringify({
      kind: "rebrief",
      reason: "compacted at a boundary",
      preamble: "# Re-brief\n\nground truth",
      clearedAt: null,
    }),
  });

  const marker = findUnclearedRebriefMarker(db, session.id);
  assert.ok(marker, "the marker survives the failed attempt");
  assert.equal(marker.preamble, "# Re-brief\n\nground truth");

  // Other system turns (decision cards, notes) never read as markers.
  appendTurn(db, {
    sessionId: session.id,
    role: "system",
    content: JSON.stringify({ kind: "decision", decisionId: "d1" }),
  });
  assert.equal(findUnclearedRebriefMarker(db, session.id)?.preamble, "# Re-brief\n\nground truth");

  // A CLEARED marker is not a brief — clearing means the user chose blank.
  appendTurn(db, {
    sessionId: session.id,
    role: "system",
    content: JSON.stringify({
      kind: "rebrief",
      reason: "older",
      preamble: "stale",
      clearedAt: "2026-07-13T00:00:00.000Z",
    }),
  });
  assert.equal(
    findUnclearedRebriefMarker(db, session.id)?.preamble,
    "# Re-brief\n\nground truth",
    "the newest UNCLEARED marker wins; cleared ones are skipped",
  );
});
