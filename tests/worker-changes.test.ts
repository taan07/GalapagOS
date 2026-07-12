import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/adapters/db/db";
import {
  CHECK_KEYS,
  createEvidenceRun,
  latestRunsByKey,
} from "../src/adapters/db/repos/evidence";
import { checkViewsFrom, parseCommitLog, type CheckRunLike } from "../src/core/worker-changes";

const run = (overrides: Partial<CheckRunLike>): CheckRunLike => ({
  status: "passed",
  summary: "passed in 3s",
  head_sha: "abc123",
  created_at: "2026-07-13T00:00:00.000Z",
  ...overrides,
});

test("fresh is exact key equality — any drift flips a green check stale", () => {
  const latest = new Map<string, CheckRunLike>([
    ["test", run({ head_sha: "abc123" })],
    ["lint", run({ head_sha: "abc123+dirty.deadbeef" })],
  ]);
  const views = checkViewsFrom(["test", "lint"], latest, "abc123");
  assert.deepEqual(
    views.map((view) => [view.key, view.fresh]),
    [
      ["test", true],
      ["lint", false],
    ],
    "the run keyed to a dirty state that no longer exists is stale",
  );
  // The same runs against a NOW-dirty worktree: the clean-keyed run stales.
  const dirtyNow = checkViewsFrom(["test", "lint"], latest, "abc123+dirty.deadbeef");
  assert.deepEqual(
    dirtyNow.map((view) => [view.key, view.fresh]),
    [
      ["test", false],
      ["lint", true],
    ],
  );
});

test("keys that never ran render nothing — absence is not evidence either way", () => {
  const views = checkViewsFrom(
    ["typecheck", "lint", "test", "build"],
    new Map([["test", run({})]]),
    "abc123",
  );
  assert.deepEqual(
    views.map((view) => view.key),
    ["test"],
  );
});

test("a project-scoped run never surfaces as a worker's green check", () => {
  // The anti-false-green invariant, pinned at the repo layer: with a workerId
  // the query reads ONLY that worker's rows — a project-pool run (worker_id
  // null) must not leak in, however fresh or green it is.
  const db = openDb(mkdtempSync(path.join(os.tmpdir(), "glp-changes-")));
  db.prepare(
    "INSERT INTO projects (id, name, slug, root_path, created_at) VALUES ('p1','P','p','/tmp/p1','2026-07-13')",
  ).run();
  createEvidenceRun(db, {
    projectId: "p1",
    workerId: null,
    checkKey: "test",
    status: "passed",
    summary: "project-pool pass",
    headSha: "livekey",
  });
  const workerScoped = latestRunsByKey(db, { projectId: "p1", workerId: "w-none" });
  assert.equal(workerScoped.get("test"), undefined, "project run invisible to worker scope");
  const views = checkViewsFrom(CHECK_KEYS, workerScoped, "livekey");
  assert.deepEqual(views, [], "no run, no badge — never a borrowed green check");
});

test("parseCommitLog splits records by line and fields by NUL, tolerating noise", () => {
  const output = "abc1234\0Fix the thing\ndef5678\0Subject with \"quotes\" and: colons\n\n";
  assert.deepEqual(parseCommitLog(output), [
    { sha: "abc1234", subject: "Fix the thing" },
    { sha: "def5678", subject: 'Subject with "quotes" and: colons' },
  ]);
  assert.deepEqual(parseCommitLog(""), []);
});
