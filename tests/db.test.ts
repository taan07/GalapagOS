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
  getOrCreateActiveSession,
  latestSdkSessionId,
  listTurns,
  updateTurnSdkSessionId,
} from "../src/adapters/db/repos/manager";

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
