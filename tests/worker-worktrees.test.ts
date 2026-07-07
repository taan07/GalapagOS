import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addWorktree,
  removeWorktree,
  workerWorktreePath,
} from "../src/adapters/git/mutating-runner";

function fixtureRepo(): { dir: string; headSha: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glp-wt-repo-"));
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
  return { dir, headSha: git(["rev-parse", "HEAD"]).trim() };
}

test("workerWorktreePath places lanes under <stateDir>/worktrees/<project>/<lane>", () => {
  assert.equal(
    workerWorktreePath("/state", "my-app", "auth-ui"),
    path.join(path.resolve("/state"), "worktrees", "my-app", "auth-ui"),
  );
});

test("addWorktree creates a real worktree on its own branch at the base sha", async () => {
  const { dir, headSha } = fixtureRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-wt-state-"));
  const worktreePath = workerWorktreePath(stateDir, "proj", "auth-ui");

  const result = await addWorktree({
    projectRoot: dir,
    worktreePath,
    branch: "galapagos/worker/auth-ui",
    baseSha: headSha,
    stateDir,
  });
  assert.equal(result.status, "created");
  assert.ok(existsSync(path.join(worktreePath, "README.md")));

  const branch = execFileSync("git", ["branch", "--show-current"], {
    cwd: worktreePath,
    encoding: "utf8",
  }).trim();
  assert.equal(branch, "galapagos/worker/auth-ui");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
  }).trim();
  assert.equal(sha, headSha);

  // The target repo's own worktree stays clean of orchestration artifacts.
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(status.trim(), "");
});

test("a leftover directory fails the add with a pick-a-different-name reason", async () => {
  const { dir, headSha } = fixtureRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-wt-state-"));
  const worktreePath = workerWorktreePath(stateDir, "proj", "auth-ui");

  const first = await addWorktree({
    projectRoot: dir,
    worktreePath,
    branch: "galapagos/worker/auth-ui",
    baseSha: headSha,
    stateDir,
  });
  assert.equal(first.status, "created");

  const second = await addWorktree({
    projectRoot: dir,
    worktreePath,
    branch: "galapagos/worker/auth-ui-2",
    baseSha: headSha,
    stateDir,
  });
  assert.equal(second.status, "failed");
  if (second.status === "failed") {
    assert.match(second.reason, /already exists/);
    assert.match(second.reason, /different lane name/);
  }
});

test("placement guards throw: inside the target repo, outside the worktrees root", async () => {
  const { dir, headSha } = fixtureRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-wt-state-"));

  await assert.rejects(
    () =>
      addWorktree({
        projectRoot: dir,
        worktreePath: path.join(dir, "worktrees", "lane"),
        branch: "b",
        baseSha: headSha,
        stateDir: dir, // even a stateDir aimed at the repo must not allow this
      }),
    /inside the target repo/,
  );

  await assert.rejects(
    () =>
      addWorktree({
        projectRoot: dir,
        worktreePath: path.join(stateDir, "elsewhere", "lane"),
        branch: "b",
        baseSha: headSha,
        stateDir,
      }),
    /Refusing worktree outside/,
  );

  await assert.rejects(
    () =>
      removeWorktree({
        projectRoot: dir,
        worktreePath: path.join(stateDir, "elsewhere", "lane"),
        stateDir,
      }),
    /Refusing worktree outside/,
  );
});

test("removeWorktree cleans up a created worktree, dirty or not", async () => {
  const { dir, headSha } = fixtureRepo();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-wt-state-"));
  const worktreePath = workerWorktreePath(stateDir, "proj", "doomed");

  await addWorktree({
    projectRoot: dir,
    worktreePath,
    branch: "galapagos/worker/doomed",
    baseSha: headSha,
    stateDir,
  });
  writeFileSync(path.join(worktreePath, "half-done.ts"), "// abandoned\n");

  const result = await removeWorktree({
    projectRoot: dir,
    worktreePath,
    stateDir,
    branch: "galapagos/worker/doomed",
  });
  assert.equal(result.status, "removed");
  assert.equal(existsSync(worktreePath), false);

  // The branch is gone too, so the lane name is reusable — a leftover branch
  // would fail every future `worktree add -b` under this name.
  const retry = await addWorktree({
    projectRoot: dir,
    worktreePath,
    branch: "galapagos/worker/doomed",
    baseSha: headSha,
    stateDir,
  });
  assert.equal(retry.status, "created");
});
