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
  detectCheckRunner,
  renderRunChecksResult,
  runChecks,
} from "../src/adapters/checks/run-checks";
import { observeWorkspaceEvidence } from "../src/adapters/evidence/workspace";

function fixtureRepo(
  scripts: Record<string, string>,
  options: { packageManager?: string; lockfiles?: string[] } = {},
): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glp-checks-"));
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Galapagos Tests", "-c", "user.email=tests@galapagos.local", ...args],
      { cwd: dir, encoding: "utf8" },
    );
  git(["init", "-b", "main"]);
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture", scripts, ...(options.packageManager ? { packageManager: options.packageManager } : {}) }, null, 2),
  );
  for (const lockfile of options.lockfiles ?? []) {
    writeFileSync(path.join(dir, lockfile), `fixture ${lockfile}\n`);
  }
  git(["add", "-A"]);
  git(["commit", "-m", "fixture"]);
  return dir;
}

const SCRIPTS = {
  typecheck: 'node -e "process.exit(0)"',
  test: "node -e \"console.log('2 passing'); process.exit(0)\"",
  lint: "node -e \"console.error('lint exploded'); process.exit(1)\"",
};

async function fixture(options: { packageManager?: string; lockfiles?: string[] } = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-checks-state-"));
  const config = loadConfig({ ...process.env, GALAPAGOS_STATE_DIR: stateDir });
  const db = openDb(stateDir);
  const project = await registerProject(db, { rootPath: fixtureRepo(SCRIPTS, options) });
  return { db, config, project };
}

test("configuredCheckKeys reads the four known keys from package.json scripts", async () => {
  const { project } = await fixture();
  assert.deepEqual(configuredCheckKeys(project.root_path), ["typecheck", "lint", "test"]);
  assert.deepEqual(configuredCheckKeys(mkdtempSync(path.join(os.tmpdir(), "glp-empty-"))), []);
});

test("detectCheckRunner uses a valid packageManager declaration before lockfiles", () => {
  const repo = fixtureRepo(SCRIPTS, {
    packageManager: "bun@1.2.5",
    lockfiles: ["package-lock.json", "pnpm-lock.yaml"],
  });
  const result = detectCheckRunner(repo);
  assert.deepEqual(result, {
    status: "resolved",
    runner: {
      manager: "bun",
      command: "bun",
      argsBeforeKey: ["run"],
      declaredPackageManager: "bun@1.2.5",
      launcher: "direct",
    },
  });
});

test("detectCheckRunner keeps exact supported declarations and routes non-Bun managers through Corepack", () => {
  for (const [declaration, manager, command, argsBeforeKey, launcher] of [
    ["bun@1.2.5+sha256.fixture", "bun", "bun", ["run"], "direct"],
    ["pnpm@9.15.0+sha224.fixture", "pnpm", "corepack", ["pnpm", "run"], "corepack"],
    ["yarn@4.6.0+sha224.fixture", "yarn", "corepack", ["yarn", "run"], "corepack"],
    ["npm@10.9.2+sha512.fixture", "npm", "corepack", ["npm", "run"], "corepack"],
  ] as const) {
    const result = detectCheckRunner(fixtureRepo(SCRIPTS, { packageManager: declaration }));
    assert.equal(result.status, "resolved", declaration);
    if (result.status === "resolved") {
      assert.deepEqual(result.runner, {
        manager,
        command,
        argsBeforeKey,
        declaredPackageManager: declaration,
        launcher,
      });
    }
  }
});

test("detectCheckRunner recognizes each supported lockfile and rejects conflicting signals", () => {
  for (const [lockfile, manager] of [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ] as const) {
    const result = detectCheckRunner(fixtureRepo(SCRIPTS, { lockfiles: [lockfile] }));
    assert.equal(result.status, "resolved");
    if (result.status === "resolved") {
      assert.equal(result.runner.manager, manager);
    }
  }

  const conflict = detectCheckRunner(
    fixtureRepo(SCRIPTS, { lockfiles: ["bun.lock", "package-lock.json"] }),
  );
  assert.equal(conflict.status, "indeterminate");
  if (conflict.status === "indeterminate") {
    assert.match(conflict.reason, /Conflicting package-manager lockfiles/);
  }

  const fallback = detectCheckRunner(fixtureRepo(SCRIPTS));
  assert.equal(fallback.status, "resolved");
  if (fallback.status === "resolved") {
    assert.equal(fallback.runner.manager, "npm", "a bare package.json keeps the npm fallback");
  }
});

test("detectCheckRunner rejects an invalid explicit packageManager instead of falling back", async () => {
  const repo = fixtureRepo(SCRIPTS, {
    packageManager: "bnu@1.2.5",
    lockfiles: ["bun.lock"],
  });
  const detected = detectCheckRunner(repo);
  assert.equal(detected.status, "indeterminate");
  if (detected.status === "indeterminate") {
    assert.match(detected.reason, /bnu@1\.2\.5/);
    assert.match(detected.reason, /expected bun, pnpm, yarn, or npm/);
  }

  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-checks-state-"));
  const config = loadConfig({ ...process.env, GALAPAGOS_STATE_DIR: stateDir });
  const db = openDb(stateDir);
  const project = await registerProject(db, { rootPath: repo });
  const result = await runChecks({
    db,
    config,
    projectId: project.id,
    projectSlug: project.slug,
    cwd: repo,
    keys: ["test"],
  });
  assert.equal(result.outcomes[0]?.status, "error");
  assert.match(result.outcomes[0]?.summary ?? "", /bnu@1\.2\.5/);
  assert.equal(listEvidenceRuns(db, { projectId: project.id, workerId: null }).length, 0);
});

test("detectCheckRunner rejects incomplete, unversioned, and trailing packageManager declarations", () => {
  for (const declaration of [
    "bun",
    "bun@",
    "bun@garbage",
    "bun@1.2.5 trailing",
    "pnpm@9.15",
    "yarn@4.6.0+not-an-integrity-suffix",
  ]) {
    const result = detectCheckRunner(fixtureRepo(SCRIPTS, { packageManager: declaration }));
    assert.equal(result.status, "indeterminate", declaration);
    if (result.status === "indeterminate") {
      assert.match(result.reason, /exact x\.y\.z version/);
    }
  }
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

test("runChecks uses Bun when the target declares Bun and records the exact command", async () => {
  const { db, config, project } = await fixture({
    packageManager: "bun@1.2.5",
    lockfiles: ["package-lock.json"],
  });
  const result = await runChecks({
    db,
    config,
    projectId: project.id,
    projectSlug: project.slug,
    cwd: project.root_path,
    keys: ["test"],
  });
  assert.equal(result.outcomes[0]?.status, "passed");
  const run = listEvidenceRuns(db, { projectId: project.id, workerId: null })[0];
  assert.ok(run?.log_path);
  assert.match(readFileSync(run.log_path, "utf8"), /^command: bun run test$/m);
});

test("runChecks refuses declared Bun versions that do not match the available binary", async () => {
  const { db, config, project } = await fixture({ packageManager: "bun@0.0.0" });
  const result = await runChecks({
    db,
    config,
    projectId: project.id,
    projectSlug: project.slug,
    cwd: project.root_path,
    keys: ["test"],
  });
  assert.equal(result.outcomes[0]?.status, "error");
  assert.match(result.outcomes[0]?.summary ?? "", /Bun version mismatch/);
  assert.equal(listEvidenceRuns(db, { projectId: project.id, workerId: null }).length, 0);
});

test("conflicting lockfiles produce check errors without executing an arbitrary manager", async () => {
  const { db, config, project } = await fixture({ lockfiles: ["bun.lock", "package-lock.json"] });
  const result = await runChecks({
    db,
    config,
    projectId: project.id,
    projectSlug: project.slug,
    cwd: project.root_path,
    keys: ["test"],
  });
  assert.equal(result.outcomes[0]?.status, "error");
  assert.match(result.outcomes[0]?.summary ?? "", /Conflicting package-manager lockfiles/);
  assert.equal(listEvidenceRuns(db, { projectId: project.id, workerId: null }).length, 0);
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

test("changing a selected lockfile makes check evidence stale", async () => {
  const { db, config, project } = await fixture({ lockfiles: ["bun.lock"] });
  await runChecks({
    db,
    config,
    projectId: project.id,
    projectSlug: project.slug,
    cwd: project.root_path,
    keys: ["typecheck"],
  });
  const runKey = latestRunsByKey(db, { projectId: project.id, workerId: null }).get("typecheck")
    ?.head_sha;
  assert.ok(runKey);

  writeFileSync(path.join(project.root_path, "bun.lock"), "changed lockfile bytes\n");
  const workspace = await observeWorkspaceEvidence(project.root_path);
  assert.notEqual(workspace.key, runKey, "a lockfile change makes prior check evidence stale");
});

test("the evidence key is content-aware — same paths, same line counts, different bytes ≠ same key (adversarial review C1)", async () => {
  const { project } = await fixture();

  // A tracked file modified in place: one changed line vs base, both times.
  writeFileSync(path.join(project.root_path, "package.json").replace("package.json", "swap.ts"), "");
  const swapPath = path.join(project.root_path, "swap.ts");
  execFileSync("git", ["add", "swap.ts"], { cwd: project.root_path });
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "base swap"],
    { cwd: project.root_path },
  );
  writeFileSync(swapPath, "export const ok = true;\n");
  const honest = await observeWorkspaceEvidence(project.root_path);
  // Swap the CONTENT of the same single line — status lists and numstat
  // line counts are identical; only the bytes differ.
  writeFileSync(swapPath, "export const ok = !!0;\n");
  const swapped = await observeWorkspaceEvidence(project.root_path);
  assert.notEqual(
    swapped.key,
    honest.key,
    "swapping line content without changing counts must move the key",
  );

  // Untracked content: invisible to numstat entirely, must still move the key.
  const untrackedPath = path.join(project.root_path, "untracked.ts");
  writeFileSync(untrackedPath, "a\n");
  const before = await observeWorkspaceEvidence(project.root_path);
  writeFileSync(untrackedPath, "b\n");
  const after = await observeWorkspaceEvidence(project.root_path);
  assert.notEqual(after.key, before.key, "rewriting an untracked file must move the key");
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
