import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type GalapagosDb } from "../src/adapters/db/db";
import { createAttentionItem, listWorkerAttentionItems } from "../src/adapters/db/repos/attention";
import { createCompletionDigest } from "../src/adapters/db/repos/digests";
import {
  ensureCompletionDebrief,
  getCompletionDebrief,
  listDebriefAttempts,
  startDebriefAttempt,
} from "../src/adapters/db/repos/debriefs";
import { createCompletionDebriefScheduler } from "../src/daemon/completion-debrief-scheduler";

function fixture(): {
  db: GalapagosDb;
  projectId: string;
  workerId: string;
  digestId: string;
} {
  const db = openDb(mkdtempSync(path.join(os.tmpdir(), "glp-debrief-")));
  const projectId = "project";
  const laneId = "lane";
  const workerId = "worker";
  const at = "2026-07-14T00:00:00.000Z";
  db.prepare(
    `INSERT INTO projects (id, name, slug, root_path, created_at)
     VALUES (?, 'P', 'p', '/tmp/p', ?)`,
  ).run(projectId, at);
  db.prepare(
    `INSERT INTO lanes
       (id, project_id, name, slug, allowed_globs, forbidden_globs, base_sha, status, created_at)
     VALUES (?, ?, 'lane', 'lane', '[]', '[]', 'abc', 'retired', ?)`,
  ).run(laneId, projectId, at);
  db.prepare(
    `INSERT INTO workers
       (id, project_id, lane_id, sdk_session_id, worktree_path, branch,
        brief_record_id, status, last_heartbeat_at, last_message_at,
        last_summary, resumed_from, created_at)
     VALUES (?, ?, ?, NULL, '/tmp/w', 'feat/w', NULL, 'stopped',
             NULL, NULL, NULL, NULL, ?)`,
  ).run(workerId, projectId, laneId, at);
  const digest = createCompletionDigest(db, {
    workerId,
    narrative: "done",
    beforeAfter: [],
    claims: [],
    touchedAreas: [],
  });
  db.prepare("UPDATE completion_digests SET status = 'manager_reviewed' WHERE id = ?").run(
    digest.id,
  );
  ensureCompletionDebrief(db, { digestId: digest.id, projectId, workerId, at });
  return { db, projectId, workerId, digestId: digest.id };
}

test("busy time consumes no attempt; retries run at 30s then 2m and exhaust visibly", async () => {
  const { db, projectId, workerId, digestId } = fixture();
  const clock = { now: new Date("2026-07-14T00:00:00.000Z") };
  let busy = true;
  let contextVersion = 0;
  const scheduler = createCompletionDebriefScheduler({
    db,
    now: () => clock.now,
    isProjectBusy: () => busy,
    buildContext: (row) => ({
      digestId: row.digest_id,
      workerId: row.worker_id,
      laneName: "lane",
      retirementStatus: `version-${++contextVersion}`,
      retirementFailureKind: null,
      retirementError: null,
      model: "fable",
      seed: "seed",
      noteText: "note",
    }),
    runAttempt: async (_row, context, begin) => {
      begin(context);
      return {
        ok: false,
        failureKind: "transient",
        errorCode: "usage_limit",
        error: "limit reached",
      };
    },
  });

  await scheduler.drain(projectId);
  assert.equal(getCompletionDebrief(db, digestId)?.attempts, 0);
  assert.equal(listDebriefAttempts(db, digestId).length, 0);

  busy = false;
  await scheduler.drain(projectId);
  let row = getCompletionDebrief(db, digestId);
  assert.equal(row?.attempts, 1);
  assert.equal(row?.due_at, "2026-07-14T00:00:30.000Z");
  assert.equal(listWorkerAttentionItems(db, workerId).length, 0, "scheduled retry is not terminal");

  clock.now = new Date("2026-07-14T00:00:29.999Z");
  await scheduler.drain(projectId);
  assert.equal(getCompletionDebrief(db, digestId)?.attempts, 1);
  clock.now = new Date("2026-07-14T00:00:30.000Z");
  await scheduler.drain(projectId);
  row = getCompletionDebrief(db, digestId);
  assert.equal(row?.attempts, 2);
  assert.equal(row?.due_at, "2026-07-14T00:02:30.000Z");

  clock.now = new Date("2026-07-14T00:02:30.000Z");
  await scheduler.drain(projectId);
  row = getCompletionDebrief(db, digestId);
  assert.equal(row?.attempts, 3);
  assert.equal(row?.status, "failed");
  const attempts = listDebriefAttempts(db, digestId);
  assert.equal(attempts.length, 3);
  assert.deepEqual(
    attempts.map((attempt) => JSON.parse(attempt.context) as { retirementStatus: string })
      .map((context) => context.retirementStatus),
    ["version-1", "version-2", "version-3"],
    "digest-bound context is rebuilt at each actual attempt",
  );
  const attention = listWorkerAttentionItems(db, workerId).find(
    (item) => item.kind === "completion_debrief_failed",
  );
  assert.equal(attention?.priority, "high");
  assert.match(attention?.detail ?? "", /All 3 automatic attempts/);
  assert.match(attention?.detail ?? "", /usage_limit/);
});

test("restart recovery records the interrupted real attempt and preserves its due time", () => {
  const { db, projectId, workerId, digestId } = fixture();
  startDebriefAttempt(db, {
    digestId,
    context: { retirementStatus: "succeeded" },
    at: "2026-07-14T00:00:00.000Z",
  });
  const scheduler = createCompletionDebriefScheduler({
    db,
    now: () => new Date("2026-07-14T00:00:10.000Z"),
    isProjectBusy: () => false,
    buildContext: () => null,
    runAttempt: async (_row, context, begin) => {
      begin(context);
      return { ok: true };
    },
  });
  const recovered = scheduler.recover();
  assert.equal(recovered.length, 1);
  const row = getCompletionDebrief(db, digestId);
  assert.equal(row?.status, "failed");
  assert.equal(row?.attempts, 1);
  assert.equal(row?.last_error_code, "daemon_restart");
  assert.equal(row?.due_at, "2026-07-14T00:00:40.000Z");
  assert.equal(listWorkerAttentionItems(db, workerId).length, 0);
  assert.equal(row?.project_id, projectId);
});

test("a failure before runManagerTurn begins is recorded without consuming an attempt", async () => {
  const { db, projectId, digestId } = fixture();
  const scheduler = createCompletionDebriefScheduler({
    db,
    now: () => new Date("2026-07-14T00:00:00.000Z"),
    isProjectBusy: () => false,
    buildContext: (row) => ({
      digestId: row.digest_id,
      workerId: row.worker_id,
      laneName: "lane",
      retirementStatus: "pending",
      retirementFailureKind: null,
      retirementError: null,
      model: "fable",
      seed: "seed",
      noteText: "note",
    }),
    runAttempt: async () => ({
      ok: false,
      failureKind: "transient",
      errorCode: "distill_gate",
      error: "prior distillation gate failed before the manager call",
    }),
  });
  await scheduler.drain(projectId);
  const row = getCompletionDebrief(db, digestId);
  assert.equal(row?.attempts, 0);
  assert.equal(row?.last_error_code, "distill_gate");
  assert.equal(row?.due_at, "2026-07-14T00:00:05.000Z");
  assert.equal(listDebriefAttempts(db, digestId).length, 0);
});

test("non-retryable failure waits for explicit re-arm without deleting attempt history", async () => {
  const { db, projectId, workerId, digestId } = fixture();
  let calls = 0;
  const scheduler = createCompletionDebriefScheduler({
    db,
    now: () => new Date("2026-07-14T00:00:00.000Z"),
    isProjectBusy: () => false,
    buildContext: (row) => ({
      digestId: row.digest_id,
      workerId: row.worker_id,
      laneName: "lane",
      retirementStatus: "succeeded",
      retirementFailureKind: null,
      retirementError: null,
      model: "fable",
      seed: "seed",
      noteText: "note",
    }),
    runAttempt: async (_row, context, begin) => {
      begin(context);
      calls += 1;
      return calls === 1
        ? { ok: false, failureKind: "non_retryable", errorCode: "auth", error: "not logged in" }
        : { ok: true };
    },
  });
  await scheduler.drain(projectId);
  const attention = listWorkerAttentionItems(db, workerId).find(
    (item) => item.kind === "completion_debrief_failed",
  );
  assert.ok(attention);
  await scheduler.drain(projectId);
  assert.equal(calls, 1, "non-retryable does not spin");

  const rearmed = scheduler.rearmByAttention(attention.id);
  assert.equal(rearmed?.attempts, 0);
  await scheduler.drain(projectId);
  assert.equal(getCompletionDebrief(db, digestId)?.status, "succeeded");
  assert.equal(getCompletionDebrief(db, digestId)?.attempts, 1, "re-arm starts a fresh retry budget");
  assert.equal(listDebriefAttempts(db, digestId).length, 2, "audit history survives re-arm");
});
