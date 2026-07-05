import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitRecords } from "../src/adapters/git/mutating-runner";

function fixtureRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glp-commit-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Galapagos Tests"]);
  git(["config", "user.email", "tests@galapagos.local"]);
  writeFileSync(path.join(dir, "README.md"), "fixture\n");
  git(["add", "-A"]);
  git(["commit", "-m", "initial"]);
  return dir;
}

function writeRecordFile(root: string, name: string): void {
  const dir = path.join(root, "docs", "galapagos", "goals");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), "---\nid: x\n---\n\nbody\n");
}

test("commits new record files with the given message", async () => {
  const repo = fixtureRepo();
  writeRecordFile(repo, "2026-07-04-goal-aaaa1111.md");

  const result = await commitRecords(repo, "galapagos(records): distill 1 record");
  assert.equal(result.status, "committed");

  const log = execFileSync("git", ["log", "--oneline", "--", "docs/galapagos"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.match(log, /galapagos\(records\): distill 1 record/);
});

test("never commits user changes staged outside docs/galapagos", async () => {
  const repo = fixtureRepo();
  writeFileSync(path.join(repo, "user-file.txt"), "user work in flight\n");
  execFileSync("git", ["add", "user-file.txt"], { cwd: repo });
  writeRecordFile(repo, "2026-07-04-goal-bbbb2222.md");

  const result = await commitRecords(repo, "galapagos(records): records only");
  assert.equal(result.status, "committed");

  // The user's staged file is untouched: still staged, still uncommitted.
  const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.match(staged, /user-file\.txt/);
  const committed = execFileSync("git", ["show", "--stat", "--name-only", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.doesNotMatch(committed, /user-file\.txt/);
  assert.match(committed, /docs\/galapagos\/goals/);
});

test("reports nothing_to_commit when the records dir is clean", async () => {
  const repo = fixtureRepo();
  const result = await commitRecords(repo, "galapagos(records): noop");
  assert.deepEqual(result, { status: "nothing_to_commit" });
});

test("skips and surfaces when the repo is mid-merge", async () => {
  const repo = fixtureRepo();
  writeRecordFile(repo, "2026-07-04-goal-cccc3333.md");
  writeFileSync(path.join(repo, ".git", "MERGE_HEAD"), "deadbeef\n");

  const result = await commitRecords(repo, "galapagos(records): should skip");
  assert.equal(result.status, "skipped");
  assert.match((result as { reason: string }).reason, /merge in progress/);
});

test("skips with a reason instead of throwing on git failure", async () => {
  const noRepo = mkdtempSync(path.join(os.tmpdir(), "glp-commit-norepo-"));
  writeRecordFile(noRepo, "2026-07-04-goal-dddd4444.md");
  const result = await commitRecords(noRepo, "galapagos(records): no repo");
  assert.equal(result.status, "skipped");
  assert.ok((result as { reason: string }).reason.length > 0);
});
