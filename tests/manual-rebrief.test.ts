import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type GalapagosDb } from "../src/adapters/db/db";
import { registerProject, type ProjectRow } from "../src/adapters/db/repos/projects";
import { appendTurn, getOrCreateActiveSession, listTurns } from "../src/adapters/db/repos/manager";
import {
  ALREADY_FRESH_REBRIEF_NOTE,
  COMPACTED_NOTE,
  rebriefSessionNow,
} from "../src/daemon/manual-rebrief";

const TEST_GIT_IDENTITY = { name: "Galapagos Tests", email: "tests@galapagos.local" };

async function fixture(): Promise<{ db: GalapagosDb; project: ProjectRow }> {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-rebrief-state-"));
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "glp-rebrief-proj-"));
  writeFileSync(path.join(projectDir, "README.md"), "fixture\n");
  const db = openDb(stateDir);
  const project = await registerProject(db, {
    rootPath: projectDir,
    initGit: true,
    gitIdentity: TEST_GIT_IDENTITY,
  });
  return { db, project };
}

test("manual rebrief acknowledgement recovers canonical history without an SSE delivery", async () => {
  const { db, project } = await fixture();
  const old = getOrCreateActiveSession(db, project.id);
  appendTurn(db, { sessionId: old.id, role: "user", content: "Please make a plan." });

  // Simulates the initiating browser missing the manager_note broadcast. The
  // response still identifies the new session and its durable history, so an
  // immediate HTTP reconciliation has all the truth it needs.
  const acknowledgement = rebriefSessionNow(db, project.id);
  assert.deepEqual(acknowledgement.compacted, true);
  assert.equal(acknowledgement.note, COMPACTED_NOTE);
  assert.notEqual(acknowledgement.sessionId, old.id);
  assert.deepEqual(
    listTurns(db, acknowledgement.sessionId).map((turn) => ({ role: turn.role, content: turn.content })),
    [{ role: "system", content: JSON.stringify({ kind: "note", text: COMPACTED_NOTE }) }],
  );
});

test("manual rebrief acknowledges an already-fresh session without another compaction", async () => {
  const { db, project } = await fixture();
  const session = getOrCreateActiveSession(db, project.id);
  // A brand-new session is intentionally not records-seeded, so compact once
  // to create the virgin records-seeded state the route recognizes.
  const compacted = rebriefSessionNow(db, project.id);
  const acknowledgement = rebriefSessionNow(db, project.id);

  assert.equal(compacted.compacted, true);
  assert.equal(acknowledgement.compacted, false);
  assert.equal(acknowledgement.note, ALREADY_FRESH_REBRIEF_NOTE);
  assert.equal(acknowledgement.sessionId, compacted.sessionId);
  assert.notEqual(session.id, acknowledgement.sessionId);
});
