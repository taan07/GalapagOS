import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_WORKSPACE_EVIDENCE_LIMITS, inspectUntrackedEntries, observeWorkspaceEvidence } from "../src/adapters/evidence/workspace";

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glp-workspace-evidence-"));
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=Tests", "-c", "user.email=tests@example.test", ...args], { cwd: dir });
  git(["init", "-b", "main"]);
  writeFileSync(path.join(dir, "tracked.txt"), "base\n");
  git(["add", "."]); git(["commit", "-m", "base"]);
  return dir;
}

const withLimits = (overrides: Partial<typeof DEFAULT_WORKSPACE_EVIDENCE_LIMITS>) => ({ ...DEFAULT_WORKSPACE_EVIDENCE_LIMITS, ...overrides });

test("untracked symlinks hash link text and never follow their targets", async () => {
  const cwd = repo();
  const outside = path.join(os.tmpdir(), `glp-secret-${Date.now()}`);
  writeFileSync(outside, "outside one\n");
  symlinkSync(outside, path.join(cwd, "link"));
  const first = await observeWorkspaceEvidence(cwd);
  writeFileSync(outside, "outside two\n");
  const second = await observeWorkspaceEvidence(cwd);
  assert.ok(first.available);
  assert.equal(first.key, second.key, "target bytes are not followed into evidence");
  assert.equal(first.usage.untrackedBytes, Buffer.byteLength(outside));
});

test("entry, aggregate, and count limits return indeterminate rather than a partial key", async () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, "a.txt"), "1234");
  writeFileSync(path.join(cwd, "b.txt"), "5678");
  const file = await observeWorkspaceEvidence(cwd, withLimits({ maxUntrackedFileBytes: 3 }));
  assert.equal(file.available, false); assert.equal(file.key, "indeterminate"); assert.match(file.reason ?? "", /per-file/);
  const aggregate = await observeWorkspaceEvidence(cwd, withLimits({ maxUntrackedFileBytes: 8, maxAggregateUntrackedBytes: 6 }));
  assert.equal(aggregate.available, false); assert.match(aggregate.reason ?? "", /aggregate/);
  const count = await observeWorkspaceEvidence(cwd, withLimits({ maxUntrackedEntries: 1 }));
  assert.equal(count.available, false); assert.match(count.reason ?? "", /entry count/);
  const invalid = await inspectUntrackedEntries(cwd, ["a.txt"], withLimits({ maxConcurrentReads: 0 }));
  assert.equal(invalid.available, false); assert.match(invalid.reason ?? "", /maxConcurrentReads=0/);
});

test("a file replaced after opening makes workspace evidence indeterminate", async () => {
  const cwd = repo();
  const target = path.join(cwd, "race.txt");
  const replacement = path.join(os.tmpdir(), `glp-evidence-replacement-${Date.now()}.txt`);
  writeFileSync(target, "old\n");
  writeFileSync(replacement, "new\n");
  const observed = await observeWorkspaceEvidence(cwd, DEFAULT_WORKSPACE_EVIDENCE_LIMITS, {
    afterOpen(relative) {
      if (relative === "race.txt") renameSync(replacement, target);
    },
  });
  assert.equal(observed.available, false);
  assert.equal(observed.key, "indeterminate");
  assert.match(observed.reason ?? "", /replaced while observed/);
});

test("special untracked entries and over-cap patches are explicit indeterminate evidence", async () => {
  const cwd = repo();
  // A FIFO is an untracked special/non-regular evidence entry.
  execFileSync("mkfifo", [path.join(cwd, "odd")]);
  const special = await inspectUntrackedEntries(cwd, ["odd"]);
  assert.equal(special.available, false); assert.match(special.reason ?? "", /not a regular file/);
  execFileSync("rm", [path.join(cwd, "odd")]);
  writeFileSync(path.join(cwd, "tracked.txt"), "x".repeat(2048));
  const diff = await observeWorkspaceEvidence(cwd, withLimits({ maxGitOutputBytes: 128 }));
  assert.equal(diff.available, false); assert.equal(diff.key, "indeterminate"); assert.match(diff.reason ?? "", /per-stream limit 128/);
});

test("aggregate git cap identifies the aggregate limit", async () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, "tracked.txt"), "x".repeat(1024));
  const result = await observeWorkspaceEvidence(cwd, withLimits({ maxGitOutputBytes: 4096, maxAggregateGitOutputBytes: 200 }));
  assert.equal(result.available, false);
  assert.match(result.reason ?? "", /aggregate git limit 200/);
});
