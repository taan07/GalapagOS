import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/adapters/db/db";
import { loadConfig } from "../src/config";
import { registerProject } from "../src/adapters/db/repos/projects";
import { latestRunsByKey, listEvidenceRuns } from "../src/adapters/db/repos/evidence";
import {
  configuredCheckKeys,
  renderRunChecksResult,
  runChecks,
} from "../src/adapters/checks/run-checks";
import { observeWorkspaceEvidence } from "../src/adapters/evidence/workspace";

function fixtureRepo(scripts: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glp-checks-"));
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Galapagos Tests", "-c", "user.email=tests@galapagos.local", ...args],
      { cwd: dir, encoding: "utf8" },
    );
  git(["init", "-b", "main"]);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts }, null, 2));
  git(["add", "-A"]);
  git(["commit", "-m", "fixture"]);
  return dir;
}

const SCRIPTS = {
  typecheck: 'node -e "process.exit(0)"',
  test: "node -e \"console.log('2 passing'); process.exit(0)\"",
  lint: "node -e \"console.error('lint exploded'); process.exit(1)\"",
};

async function fixture() {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-checks-state-"));
  const config = loadConfig({ ...process.env, GALAPAGOS_STATE_DIR: stateDir });
  const db = openDb(stateDir);
  const project = await registerProject(db, { rootPath: fixtureRepo(SCRIPTS) });
  return { db, config, project };
}

test("configuredCheckKeys reads the four known keys from package.json scripts", async () => {
  const { project } = await fixture();
  assert.deepEqual(configuredCheckKeys(project.root_path), ["typecheck", "lint", "test"]);
  assert.deepEqual(configuredCheckKeys(mkdtempSync(path.join(os.tmpdir(), "glp-empty-"))), []);
});

test("runChecks executes configured checks, writes keyed evidence rows, reports the rest honestly", async () => {
  const { db, config, project } = await fixture();
  const result = await runChecks({
    db,
    config,
    projectId: project.id,
    projectSlug: project.slug,
    cwd: project.root_path,
    keys: ["typecheck", "test", "lint", "build"],
  });

  const byKey = new Map(result.outcomes.map((outcome) => [outcome.key, outcome]));
  assert.equal(byKey.get("typecheck")?.status, "passed");
  assert.equal(byKey.get("test")?.status, "passed");
  assert.equal(byKey.get("lint")?.status, "failed");
  assert.match(byKey.get("lint")?.summary ?? "", /exit 1/);
  assert.match(byKey.get("lint")?.summary ?? "", /lint exploded/);
  assert.equal(byKey.get("build")?.status, "not_configured");

  // Three rows (build never ran), all keyed to the clean-tree evidence key.
  const rows = listEvidenceRuns(db, { projectId: project.id, workerId: null });
  assert.equal(rows.length, 3);
  const workspace = await observeWorkspaceEvidence(project.root_path);
  assert.equal(workspace.dirty, false);
  for (const row of rows) {
    assert.equal(row.head_sha, workspace.key);
    assert.equal(row.worker_id, null);
  }

  // The log file holds the full output, one click away from the summary.
  const lintRow = rows.find((row) => row.check_key === "lint");
  assert.ok(lintRow?.log_path && existsSync(lintRow.log_path));
  assert.match(readFileSync(lintRow.log_path, "utf8"), /lint exploded/);

  const rendered = renderRunChecksResult(result);
  assert.match(rendered, /typecheck: passed/);
  assert.match(rendered, /build: not_configured/);
});

test("dirtying the tree changes the evidence key — staleness becomes detectable", async () => {
  const { db, config, project } = await fixture();
  await runChecks({
    db,
    config,
    projectId: project.id,
    projectSlug: project.slug,
    cwd: project.root_path,
    keys: ["typecheck"],
  });
  const latest = latestRunsByKey(db, { projectId: project.id, workerId: null });
  const runKey = latest.get("typecheck")?.head_sha;
  assert.ok(runKey);

  const clean = await observeWorkspaceEvidence(project.root_path);
  assert.equal(clean.key, runKey, "evidence fresh while nothing changed");

  writeFileSync(path.join(project.root_path, "uncommitted.ts"), "drift\n");
  const dirty = await observeWorkspaceEvidence(project.root_path);
  assert.notEqual(dirty.key, runKey, "an uncommitted edit alone makes evidence stale");
  assert.match(dirty.key, /\+dirty\./);
});

test("worker-scoped and project-scoped evidence pools stay distinct", async () => {
  const { db, config, project } = await fixture();
  await runChecks({
    db,
    config,
    projectId: project.id,
    projectSlug: project.slug,
    cwd: project.root_path,
    keys: ["typecheck"],
  });
  const projectRuns = latestRunsByKey(db, { projectId: project.id, workerId: null });
  assert.ok(projectRuns.get("typecheck"));
  const workerRuns = latestRunsByKey(db, { projectId: project.id, workerId: "w-none" });
  assert.equal(workerRuns.size, 0, "a project run is not worker evidence");
});
