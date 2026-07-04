import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/adapters/db/db";
import {
  getProject,
  listProjects,
  registerProject,
  slugify,
} from "../src/adapters/db/repos/projects";
import {
  appendTurn,
  compactSession,
  getOrCreateActiveSession,
  getTurn,
  latestSdkSessionId,
  listProjectTurns,
  listTurns,
  markTurnsDistilled,
  updateTurnContent,
  updateTurnSdkSessionId,
} from "../src/adapters/db/repos/manager";
import { createJob, failJob, finishJob, startJob } from "../src/adapters/db/repos/jobs";

const TEST_GIT_IDENTITY = { name: "Galapagos Tests", email: "tests@galapagos.local" };

function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("slugify produces stable kebab-case slugs", () => {
  assert.equal(slugify("MAKE IN THAILAND"), "make-in-thailand");
  assert.equal(slugify("  Weird---Name!! "), "weird-name");
  assert.equal(slugify("!!!"), "project");
});

test("registers a non-git project with initGit and creates real history", async () => {
  const stateDir = tmpDir("glp-state-");
  const projectDir = tmpDir("glp-proj-");
  writeFileSync(path.join(projectDir, "README.md"), "hello\n");
  const db = openDb(stateDir);

  await assert.rejects(
    () => registerProject(db, { rootPath: projectDir }),
    /never manages a project without history/,
  );

  const project = await registerProject(db, {
    rootPath: projectDir,
    initGit: true,
    gitIdentity: TEST_GIT_IDENTITY,
  });
  assert.equal(project.name, path.basename(projectDir));
  assert.ok(existsSync(path.join(projectDir, ".git")));

  assert.deepEqual(listProjects(db).map((row) => row.id), [project.id]);
  assert.equal(getProject(db, project.id)?.root_path, projectDir);
});

test("rejects duplicate registration and missing paths", async () => {
  const stateDir = tmpDir("glp-state-");
  const projectDir = tmpDir("glp-proj-");
  mkdirSync(path.join(projectDir, ".git"));
  const db = openDb(stateDir);

  await registerProject(db, { rootPath: projectDir });
  await assert.rejects(
    () => registerProject(db, { rootPath: projectDir }),
    /already registered/,
  );
  await assert.rejects(
    () => registerProject(db, { rootPath: path.join(projectDir, "missing") }),
    /does not exist/,
  );
});

test("manager turns round-trip with ordering and session-id pointer updates", async () => {
  const stateDir = tmpDir("glp-state-");
  const projectDir = tmpDir("glp-proj-");
  mkdirSync(path.join(projectDir, ".git"));
  const db = openDb(stateDir);
  const project = await registerProject(db, { rootPath: projectDir });

  const session = getOrCreateActiveSession(db, project.id);
  assert.equal(getOrCreateActiveSession(db, project.id).id, session.id, "session is reused");
  assert.equal(latestSdkSessionId(db, session.id), null);

  const userTurn = appendTurn(db, { sessionId: session.id, role: "user", content: "hello" });
  const assistantTurn = appendTurn(db, {
    sessionId: session.id,
    role: "assistant",
    content: "hi there",
    sdkSessionIdAfter: "sdk-1",
  });
  appendTurn(db, {
    sessionId: session.id,
    role: "tool",
    content: JSON.stringify({ tool: "git_truth", summary: "checked git status" }),
  });

  assert.equal(latestSdkSessionId(db, session.id), "sdk-1");
  updateTurnSdkSessionId(db, userTurn.id, "sdk-2");
  // Pointer follows the highest turn_index carrying a session id, not recency
  // of update — assistantTurn (index 1) still wins over userTurn (index 0).
  assert.equal(latestSdkSessionId(db, session.id), "sdk-1");
  updateTurnSdkSessionId(db, assistantTurn.id, "sdk-3");
  assert.equal(latestSdkSessionId(db, session.id), "sdk-3");

  const turns = listTurns(db, session.id);
  assert.deepEqual(
    turns.map((turn) => [turn.turn_index, turn.role]),
    [
      [0, "user"],
      [1, "assistant"],
      [2, "tool"],
    ],
  );
});

test("compaction swaps the active session and history spans both", async () => {
  const stateDir = tmpDir("glp-state-");
  const projectDir = tmpDir("glp-proj-");
  mkdirSync(path.join(projectDir, ".git"));
  const db = openDb(stateDir);
  const project = await registerProject(db, { rootPath: projectDir });

  const first = getOrCreateActiveSession(db, project.id);
  appendTurn(db, { sessionId: first.id, role: "user", content: "before compaction" });

  const second = compactSession(db, project.id, first.id);
  assert.notEqual(second.id, first.id);
  assert.ok(second.seeded_from_records_at, "fresh session records its records-seeding");
  assert.equal(getOrCreateActiveSession(db, project.id).id, second.id, "new session is active");

  appendTurn(db, { sessionId: second.id, role: "user", content: "after compaction" });
  assert.deepEqual(
    listProjectTurns(db, project.id).map((turn) => turn.content),
    ["before compaction", "after compaction"],
    "project history survives compaction",
  );
});

test("clearing a re-brief compacts to a truly blank session", async () => {
  const stateDir = tmpDir("glp-state-");
  const projectDir = tmpDir("glp-proj-");
  mkdirSync(path.join(projectDir, ".git"));
  const db = openDb(stateDir);
  const project = await registerProject(db, { rootPath: projectDir });

  const seeded = compactSession(db, project.id, getOrCreateActiveSession(db, project.id).id);
  const rebriefTurn = appendTurn(db, {
    sessionId: seeded.id,
    role: "system",
    content: JSON.stringify({ kind: "rebrief", reason: "r", preamble: "p", clearedAt: null }),
  });

  // The clear flow: stamp the re-brief turn, then blank-compact.
  updateTurnContent(
    db,
    rebriefTurn.id,
    JSON.stringify({ kind: "rebrief", reason: "r", preamble: "p", clearedAt: "2026-07-04T15:00:00Z" }),
  );
  const stamped = getTurn(db, rebriefTurn.id);
  assert.ok(stamped);
  assert.match(stamped.content, /clearedAt":"2026-07-04T15:00:00Z"/);

  const blank = compactSession(db, project.id, seeded.id, { seededFromRecords: false });
  assert.equal(blank.seeded_from_records_at, null, "a cleared session is NOT records-seeded");
  assert.equal(getOrCreateActiveSession(db, project.id).id, blank.id);
  assert.equal(listTurns(db, blank.id).length, 0, "the blank session starts with zero turns");
  assert.equal(
    latestSdkSessionId(db, blank.id),
    null,
    "no resume pointer — the next turn starts a fresh SDK session with no context",
  );
});

test("markTurnsDistilled stamps only the session's uncovered turns", async () => {
  const stateDir = tmpDir("glp-state-");
  const projectDir = tmpDir("glp-proj-");
  mkdirSync(path.join(projectDir, ".git"));
  const db = openDb(stateDir);
  const project = await registerProject(db, { rootPath: projectDir });
  const session = getOrCreateActiveSession(db, project.id);

  appendTurn(db, { sessionId: session.id, role: "user", content: "q" });
  appendTurn(db, { sessionId: session.id, role: "assistant", content: "a" });
  markTurnsDistilled(db, session.id);
  const stamped = listTurns(db, session.id);
  assert.ok(stamped.every((turn) => turn.distilled_at !== null));

  const firstStamp = stamped[0]?.distilled_at;
  appendTurn(db, { sessionId: session.id, role: "user", content: "later" });
  markTurnsDistilled(db, session.id);
  const after = listTurns(db, session.id);
  assert.equal(after[0]?.distilled_at, firstStamp, "already-covered turns keep their stamp");
  assert.ok(after[2]?.distilled_at, "the new turn is covered");
});

test("jobs move queued → running → done/failed with payload and result", () => {
  const stateDir = tmpDir("glp-state-");
  const db = openDb(stateDir);

  const job = createJob(db, "distill", { projectId: "p1" });
  assert.equal(job.status, "queued");
  startJob(db, job.id);
  finishJob(db, job.id, { recordsWritten: 2 });
  const done = db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id) as {
    status: string;
    result: string;
    started_at: string | null;
  };
  assert.equal(done.status, "done");
  assert.ok(done.started_at);
  assert.deepEqual(JSON.parse(done.result), { recordsWritten: 2 });

  const bad = createJob(db, "distill", null);
  startJob(db, bad.id);
  failJob(db, bad.id, "fork exploded");
  const failed = db.prepare("SELECT status, error FROM jobs WHERE id = ?").get(bad.id) as {
    status: string;
    error: string;
  };
  assert.deepEqual(failed, { status: "failed", error: "fork exploded" });
});

test("sessions and turns stay isolated between projects", async () => {
  const stateDir = tmpDir("glp-state-");
  const dirA = tmpDir("glp-proj-a-");
  const dirB = tmpDir("glp-proj-b-");
  mkdirSync(path.join(dirA, ".git"));
  mkdirSync(path.join(dirB, ".git"));
  const db = openDb(stateDir);

  const projectA = await registerProject(db, { rootPath: dirA, name: "Alpha" });
  const projectB = await registerProject(db, { rootPath: dirB, name: "Beta" });
  const sessionA = getOrCreateActiveSession(db, projectA.id);
  const sessionB = getOrCreateActiveSession(db, projectB.id);
  assert.notEqual(sessionA.id, sessionB.id);

  appendTurn(db, { sessionId: sessionA.id, role: "user", content: "only in A" });
  assert.equal(listTurns(db, sessionB.id).length, 0);
  assert.equal(listTurns(db, sessionA.id).length, 1);
});
