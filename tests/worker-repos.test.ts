import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type GalapagosDb } from "../src/adapters/db/db";
import { registerProject, type ProjectRow } from "../src/adapters/db/repos/projects";
import {
  createLane,
  getLane,
  laneGlobs,
  listActiveLanes,
  retireLane,
} from "../src/adapters/db/repos/lanes";
import {
  appendWorkerEvent,
  createWorker,
  getWorker,
  listLiveStatusWorkers,
  listWorkerEvents,
  listWorkers,
  setWorkerSdkSessionId,
  setWorkerStatus,
  touchWorker,
} from "../src/adapters/db/repos/workers";
import {
  createCompletionDigest,
  latestDigestForWorker,
} from "../src/adapters/db/repos/digests";
import {
  createAttentionItem,
  listOpenAttentionItems,
  listWorkerAttentionItems,
  resolveAttentionItem,
} from "../src/adapters/db/repos/attention";
import {
  applyStepUpdate,
  countStepsForWorker,
  getWorkerPlanGoal,
  listWorkerSteps,
  replacePlan,
} from "../src/adapters/db/repos/worker-steps";

async function fixture(): Promise<{ db: GalapagosDb; project: ProjectRow }> {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-state-"));
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "glp-proj-"));
  mkdirSync(path.join(projectDir, ".git"));
  const db = openDb(stateDir);
  const project = await registerProject(db, { rootPath: projectDir });
  return { db, project };
}

function fixtureLane(db: GalapagosDb, projectId: string, slug = "auth-ui") {
  return createLane(db, {
    projectId,
    name: slug,
    slug,
    allowedGlobs: [`src/${slug}/**`],
    forbiddenGlobs: ["**/*.env"],
    baseSha: "a".repeat(40),
  });
}

test("lanes round-trip globs and retire out of the active set", async () => {
  const { db, project } = await fixture();
  const lane = fixtureLane(db, project.id);

  assert.equal(getLane(db, lane.id)?.slug, "auth-ui");
  assert.deepEqual(laneGlobs(lane), {
    allowedGlobs: ["src/auth-ui/**"],
    forbiddenGlobs: ["**/*.env"],
  });
  assert.deepEqual(listActiveLanes(db, project.id).map((row) => row.id), [lane.id]);

  retireLane(db, lane.id);
  assert.deepEqual(listActiveLanes(db, project.id), []);
  assert.equal(getLane(db, lane.id)?.status, "retired");
});

test("workers track status, session id, and liveness fields", async () => {
  const { db, project } = await fixture();
  const lane = fixtureLane(db, project.id);
  const worker = createWorker(db, {
    projectId: project.id,
    laneId: lane.id,
    worktreePath: "/state/worktrees/proj/auth-ui",
    branch: "galapagos/worker/auth-ui",
    briefRecordId: "brief1",
  });

  assert.equal(worker.status, "spawning");
  assert.equal(getWorker(db, worker.id)?.brief_record_id, "brief1");

  setWorkerStatus(db, worker.id, "running");
  setWorkerSdkSessionId(db, worker.id, "sdk-w-1");
  touchWorker(db, worker.id, "reading the auth module");
  const updated = getWorker(db, worker.id);
  assert.equal(updated?.status, "running");
  assert.equal(updated?.sdk_session_id, "sdk-w-1");
  assert.equal(updated?.last_summary, "reading the auth module");
  assert.ok(updated?.last_message_at);

  touchWorker(db, worker.id);
  assert.equal(
    getWorker(db, worker.id)?.last_summary,
    "reading the auth module",
    "touch without summary keeps the last summary",
  );
  assert.deepEqual(listWorkers(db, project.id).map((row) => row.id), [worker.id]);
});

test("worker events persist in insertion order", async () => {
  const { db, project } = await fixture();
  const lane = fixtureLane(db, project.id);
  const worker = createWorker(db, {
    projectId: project.id,
    laneId: lane.id,
    worktreePath: "/w",
    branch: "b",
  });

  appendWorkerEvent(db, { workerId: worker.id, kind: "assistant", payload: { text: "hi" } });
  appendWorkerEvent(db, {
    workerId: worker.id,
    kind: "tool_use",
    payload: { tool: "Bash", input: { command: "ls" } },
  });
  appendWorkerEvent(db, { workerId: worker.id, kind: "steer", payload: { text: "focus" } });
  appendWorkerEvent(db, {
    workerId: worker.id,
    kind: "result",
    payload: { subtype: "success", isError: false },
  });

  const events = listWorkerEvents(db, worker.id);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["assistant", "tool_use", "steer", "result"],
  );
  assert.deepEqual(JSON.parse(events[0]?.payload ?? "{}"), { text: "hi" });
});

test("live-status listing finds exactly the workers a restart orphans", async () => {
  const { db, project } = await fixture();
  const lane = fixtureLane(db, project.id);
  const make = () =>
    createWorker(db, { projectId: project.id, laneId: lane.id, worktreePath: "/w", branch: "b" });

  const spawning = make();
  const running = make();
  setWorkerStatus(db, running.id, "running");
  const idle = make();
  setWorkerStatus(db, idle.id, "idle");
  const stopped = make();
  setWorkerStatus(db, stopped.id, "stopped");
  const failed = make();
  setWorkerStatus(db, failed.id, "failed");

  assert.deepEqual(
    listLiveStatusWorkers(db).map((row) => row.id),
    [spawning.id, running.id, idle.id],
  );
});

test("completion digests store parsed reports; the latest wins", async () => {
  const { db, project } = await fixture();
  const lane = fixtureLane(db, project.id);
  const worker = createWorker(db, {
    projectId: project.id,
    laneId: lane.id,
    worktreePath: "/w",
    branch: "b",
  });

  assert.equal(latestDigestForWorker(db, worker.id), undefined);
  createCompletionDigest(db, {
    workerId: worker.id,
    narrative: "First pass done.",
    beforeAfter: [{ before: "no tests", after: "3 tests" }],
    claims: [{ text: "tests pass", evidence_kind: "test", files: ["a.ts"] }],
    touchedAreas: ["src/auth-ui"],
  });
  const second = createCompletionDigest(db, {
    workerId: worker.id,
    narrative: "Follow-up fix done.",
    beforeAfter: [],
    claims: [],
    touchedAreas: [],
  });

  const latest = latestDigestForWorker(db, worker.id);
  assert.equal(latest?.id, second.id);
  assert.equal(latest?.status, "parsed");
  assert.deepEqual(JSON.parse(latest?.claims ?? "[]"), []);
});

test("attention items open, list by project and worker, and resolve", async () => {
  const { db, project } = await fixture();
  const lane = fixtureLane(db, project.id);
  const worker = createWorker(db, {
    projectId: project.id,
    laneId: lane.id,
    worktreePath: "/w",
    branch: "b",
  });

  const violation = createAttentionItem(db, {
    projectId: project.id,
    workerId: worker.id,
    kind: "lane_violation",
    title: "Out-of-lane change",
    detail: "src/other/file.ts is outside the lane",
    priority: "high",
  });
  const projectWide = createAttentionItem(db, {
    projectId: project.id,
    kind: "decision_needed",
    title: "Pick a database",
    detail: "…",
  });

  assert.deepEqual(
    listOpenAttentionItems(db, project.id).map((row) => row.id),
    [violation.id, projectWide.id],
  );
  assert.deepEqual(
    listWorkerAttentionItems(db, worker.id).map((row) => row.id),
    [violation.id],
  );
  assert.equal(listWorkerAttentionItems(db, worker.id)[0]?.priority, "high");

  resolveAttentionItem(db, violation.id, "resolved");
  const remaining = listOpenAttentionItems(db, project.id);
  assert.deepEqual(remaining.map((row) => row.id), [projectWide.id]);
  const resolved = listWorkerAttentionItems(db, worker.id)[0];
  assert.equal(resolved?.status, "resolved");
  assert.ok(resolved?.resolved_at);
});

test("replacePlan persists the goal beside the steps; a re-plan restates both", async () => {
  const { db, project } = await fixture();
  const lane = fixtureLane(db, project.id);
  const worker = createWorker(db, {
    projectId: project.id,
    laneId: lane.id,
    worktreePath: "/w",
    branch: "galapagos/worker/auth-ui",
    briefRecordId: "brief1",
  });

  // Pre-plan: the honest absence — no goal, no steps.
  assert.equal(getWorkerPlanGoal(db, worker.id), null);
  assert.deepEqual(countStepsForWorker(db, worker.id), { done: 0, total: 0 });

  replacePlan(db, worker.id, {
    goal: "Wire the auth UI to the session API",
    steps: [{ title: "Model the session" }, { title: "Render the login form" }],
  });
  assert.equal(getWorkerPlanGoal(db, worker.id), "Wire the auth UI to the session API");
  assert.deepEqual(countStepsForWorker(db, worker.id), { done: 0, total: 2 });

  // A re-plan updates the goal in place and keeps done steps by title.
  applyStepUpdate(db, worker.id, 1, "done");
  replacePlan(db, worker.id, {
    goal: "Wire the auth UI to the session API (with refresh tokens)",
    steps: [{ title: "Model the session" }, { title: "Handle refresh" }],
  });
  assert.equal(
    getWorkerPlanGoal(db, worker.id),
    "Wire the auth UI to the session API (with refresh tokens)",
  );
  const steps = listWorkerSteps(db, worker.id);
  assert.deepEqual(
    steps.map((step) => [step.title, step.status]),
    [
      ["Model the session", "done"],
      ["Handle refresh", "planned"],
    ],
  );
});
