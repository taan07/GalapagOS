import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGitTruth } from "../src/adapters/agent/manager-tools";

function fixtureRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glp-fixture-"));
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Galapagos Tests", "-c", "user.email=tests@galapagos.local", ...args],
      { cwd: dir, encoding: "utf8" },
    );
  git(["init", "-b", "main"]);
  writeFileSync(path.join(dir, "README.md"), "fixture\n");
  git(["add", "-A"]);
  git(["commit", "-m", "initial fixture commit"]);
  writeFileSync(path.join(dir, "README.md"), "fixture changed\n");
  writeFileSync(path.join(dir, "untracked.txt"), "new\n");
  return dir;
}

test("git_truth status reports real dirty and untracked files", async () => {
  const repo = fixtureRepo();
  const result = JSON.parse(await runGitTruth(repo, "status"));
  assert.equal(result.activeBranch, "main");
  assert.deepEqual(
    result.status.dirtyFiles.map((file: { path: string }) => file.path),
    ["README.md"],
  );
  assert.deepEqual(
    result.status.untrackedFiles.map((file: { path: string }) => file.path),
    ["untracked.txt"],
  );
  assert.match(result.dirtyFingerprint, /^[0-9a-f]{64}$/);
});

test("git_truth branches and log observe the fixture history", async () => {
  const repo = fixtureRepo();
  const branches = JSON.parse(await runGitTruth(repo, "branches"));
  assert.equal(branches.activeBranch, "main");
  assert.equal(branches.branches.length, 1);
  assert.equal(branches.branches[0].name, "main");

  const log = await runGitTruth(repo, "log");
  assert.match(log, /initial fixture commit/);
});

test("git_truth worktrees lists the main worktree", async () => {
  const repo = fixtureRepo();
  const worktrees = JSON.parse(await runGitTruth(repo, "worktrees"));
  assert.equal(worktrees.length, 1);
  assert.equal(worktrees[0].isMainWorktree, true);
  assert.equal(worktrees[0].status, "main");
});
