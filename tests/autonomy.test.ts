import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTONOMY_MODES,
  cycleAutonomyMode,
  deniedToolsForMode,
  isAutonomyMode,
} from "../src/core/autonomy";
import { autonomyDoctrine, buildManagerDoctrine } from "../src/daemon/doctrine";
import { openDb } from "../src/adapters/db/db";
import {
  flipInterviewToDefault,
  projectAutonomyMode,
  registerProject,
  setProjectAutonomyMode,
  getProject,
} from "../src/adapters/db/repos/projects";

test("the ladder cycles interview → default → auto → interview", () => {
  assert.equal(cycleAutonomyMode("interview"), "default");
  assert.equal(cycleAutonomyMode("default"), "auto");
  assert.equal(cycleAutonomyMode("auto"), "interview");
  assert.ok(isAutonomyMode("auto"));
  assert.ok(!isAutonomyMode("yolo"));
});

test("interview structurally removes start-new-work tools; other stops remove nothing", () => {
  const denied = deniedToolsForMode("interview");
  assert.ok(denied.includes("mcp__galapagos__spawn_worker"));
  assert.ok(denied.includes("mcp__galapagos__resume_worker"));
  assert.ok(denied.includes("mcp__galapagos__merge_worker"));
  assert.ok(!denied.includes("mcp__galapagos__steer_worker"), "tending the fleet stays possible");
  assert.deepEqual(deniedToolsForMode("default"), []);
  assert.deepEqual(deniedToolsForMode("auto"), []);
});

test("every mode's doctrine carries the non-overridable invariants", () => {
  for (const mode of AUTONOMY_MODES) {
    const text = autonomyDoctrine(mode);
    assert.match(text, /AMBIGUITY ALWAYS INTERRUPTS/, mode);
    assert.match(text, /explicit yes/, mode);
  }
  assert.match(autonomyDoctrine("interview"), /formal sign-off/i);
  assert.match(autonomyDoctrine("interview"), /"approved"/);
  assert.match(autonomyDoctrine("auto"), /leash is longer, not gone/i);
});

test("buildManagerDoctrine embeds the mode section and the narrator debrief shape", () => {
  const doctrine = buildManagerDoctrine({
    projectName: "P",
    projectRoot: "/tmp/p",
    projectSlug: "p",
    mode: "auto",
  });
  assert.match(doctrine, /## Autonomy mode: AUTO/);
  assert.match(doctrine, /## Narrating worker events — the debrief/);
  // Omitted mode = the middle stop.
  assert.match(
    buildManagerDoctrine({ projectName: "P", projectRoot: "/tmp/p", projectSlug: "p" }),
    /## Autonomy mode: DEFAULT/,
  );
});

test("the mode persists on the project row and defaults defensively", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-mode-state-"));
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "glp-mode-proj-"));
  writeFileSync(path.join(projectDir, "README.md"), "fixture\n");
  const db = openDb(stateDir);
  const project = await registerProject(db, {
    rootPath: projectDir,
    initGit: true,
    gitIdentity: { name: "Galapagos Tests", email: "tests@galapagos.local" },
  });
  // The additive migration default: existing and new rows start at the
  // middle stop.
  assert.equal(projectAutonomyMode(project), "default");

  setProjectAutonomyMode(db, project.id, "interview");
  const reloaded = getProject(db, project.id);
  assert.ok(reloaded);
  assert.equal(projectAutonomyMode(reloaded), "interview");

  // A corrupted/unknown stored value never crashes a turn — it reads as the
  // middle stop.
  assert.equal(projectAutonomyMode({ autonomy_mode: "banana" }), "default");
});

test("the sign-off flip fires only from interview, and says so honestly", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-flip-state-"));
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "glp-flip-proj-"));
  writeFileSync(path.join(projectDir, "README.md"), "fixture\n");
  const db = openDb(stateDir);
  const project = await registerProject(db, {
    rootPath: projectDir,
    initGit: true,
    gitIdentity: { name: "Galapagos Tests", email: "tests@galapagos.local" },
  });

  // Approving a plan in Default mode is a plain record update — no flip, and
  // the caller's reply must not claim one (the review's "lie" finding).
  assert.equal(flipInterviewToDefault(db, project.id), false);
  assert.equal(projectAutonomyMode(getProject(db, project.id) ?? {}), "default");

  setProjectAutonomyMode(db, project.id, "interview");
  assert.equal(flipInterviewToDefault(db, project.id), true, "the signature ends the interview");
  assert.equal(projectAutonomyMode(getProject(db, project.id) ?? {}), "default");

  // Idempotent: a second approval cannot double-flip or lie.
  assert.equal(flipInterviewToDefault(db, project.id), false);

  // Auto is never touched by a sign-off.
  setProjectAutonomyMode(db, project.id, "auto");
  assert.equal(flipInterviewToDefault(db, project.id), false);
  assert.equal(projectAutonomyMode(getProject(db, project.id) ?? {}), "auto");
});
