// Monitor-tick unit tests against fixture state: staleness, abandoned
// questions, the mid-run detective lane audit, the completion-claims scan
// with auto-resolve and zero-LLM auto-review, the main-checkout watch, and
// the event-driven triage trigger. The tick itself never calls an LLM —
// triage is an injected function here, exactly as in the daemon.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type GalapagosDb } from "../src/adapters/db/db";
import { loadConfig, type GalapagosConfig } from "../src/config";
import { registerProject, type ProjectRow } from "../src/adapters/db/repos/projects";
import {
  createAttentionItem,
  listOpenAttentionItems,
  listWorkerAttentionItems,
} from "../src/adapters/db/repos/attention";
import { createCompletionDigest, latestDigestForWorker } from "../src/adapters/db/repos/digests";
import {
  createEvidenceRun,
  evidenceRunsKey,
  latestRunsByKey,
} from "../src/adapters/db/repos/evidence";
import { createJob, finishJob, startJob } from "../src/adapters/db/repos/jobs";
import { countWorkerEvents, getWorker } from "../src/adapters/db/repos/workers";
import { createWorkerRuntime } from "../src/adapters/agent/worker-runtime";
import type { WorkerSession } from "../src/adapters/agent/worker-session";
import { observeWorkspaceEvidence } from "../src/adapters/evidence/workspace";
import { createMonitor, type MonitorBroadcast } from "../src/daemon/monitor";

function fixtureRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glp-mon-repo-"));
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Galapagos Tests", "-c", "user.email=tests@galapagos.local", ...args],
      { cwd: dir, encoding: "utf8" },
    );
  git(["init", "-b", "main"]);
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { typecheck: "true", test: "true" } }, null, 2),
  );
  mkdirSync(path.join(dir, "src", "auth"), { recursive: true });
  writeFileSync(path.join(dir, "src", "auth", "login.ts"), "export const x = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-m", "initial"]);
  return dir;
}

function inertSession(): WorkerSession {
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>(() => {});
      },
    },
    send() {},
    async interrupt() {},
    async stop() {},
  };
}

/** What the fake judgment legs answer — mutable per test. */
type LegBehavior = {
  watchdog: { verdict: "clean" | "suspicious" | "gaming"; summary: string };
  critic: {
    verdict: "approve" | "needs_work" | "reject";
    summary: string;
    findings: { severity: "blocker" | "major" | "minor"; title: string; evidence: string }[];
  };
};

type Fixture = {
  db: GalapagosDb;
  config: GalapagosConfig;
  project: ProjectRow;
  workerId: string;
  worktree: string;
  triaged: ProjectRow[];
  events: MonitorBroadcast[];
  monitor: ReturnType<typeof createMonitor>;
  clock: { now: Date };
  legs: LegBehavior;
  legRuns: string[];
  retired: { workerId: string; reason: string }[];
};

async function fixture(): Promise<Fixture> {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-mon-state-"));
  const config = loadConfig({ ...process.env, GALAPAGOS_STATE_DIR: stateDir });
  const db = openDb(stateDir);
  const project = await registerProject(db, { rootPath: fixtureRepo() });
  const runtime = createWorkerRuntime({ db, config, sessionFactory: () => inertSession() });
  const spawned = await runtime.spawn({
    project,
    laneName: "auth ui",
    allowedGlobs: ["src/auth/**"],
    briefTitle: "t",
    brief: "b",
  });
  assert.ok(spawned.ok);
  if (!spawned.ok) {
    throw new Error("unreachable");
  }
  const triaged: ProjectRow[] = [];
  const events: MonitorBroadcast[] = [];
  const clock = { now: new Date() };
  const legs: LegBehavior = {
    watchdog: { verdict: "clean", summary: "honest run" },
    critic: { verdict: "approve", summary: "satisfies the brief", findings: [] },
  };
  const legRuns: string[] = [];
  // Fake judgment legs: persist a verdict job exactly like the real ones,
  // keyed to the live workspace state.
  const fakeLeg =
    (kind: "watchdog" | "critic") =>
    async (input: { worker: { id: string; worktree_path: string }; digestId: string }) => {
      legRuns.push(`${kind}:${input.digestId}`);
      const job = createJob(db, kind, {
        workerId: input.worker.id,
        digestId: input.digestId,
        projectId: project.id,
      });
      startJob(db, job.id);
      const workspace = await observeWorkspaceEvidence(input.worker.worktree_path);
      finishJob(db, job.id, {
        ...(kind === "watchdog"
          ? {
              ...legs.watchdog,
              evidence: [],
              eventCount: countWorkerEvents(db, input.worker.id),
            }
          : {
              ...legs.critic,
              runsKey: evidenceRunsKey(
                latestRunsByKey(db, { projectId: project.id, workerId: input.worker.id }),
              ),
            }),
        evidenceKey: workspace.key,
        digestId: input.digestId,
        workerId: input.worker.id,
      });
    };
  const retired: { workerId: string; reason: string }[] = [];
  const monitor = createMonitor({
    db,
    config,
    now: () => clock.now,
    broadcast: (event) => events.push(event),
    runWatchdog: fakeLeg("watchdog"),
    runCritic: fakeLeg("critic"),
    retireWorker: async (workerId, reason) => {
      retired.push({ workerId, reason });
    },
    runTriage: async (target) => {
      // The real triage records its job — the trigger cutoff depends on it.
      createJob(db, "triage", { projectId: target.id });
      triaged.push(target);
    },
  });
  return {
    db,
    config,
    project,
    workerId: spawned.workerId,
    worktree: spawned.worktreePath,
    triaged,
    events,
    monitor,
    clock,
    legs,
    legRuns,
    retired,
  };
}

/** Leg launches are fire-and-forget — give their promises a beat to land. */
async function settleLegs(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

function setStatus(db: GalapagosDb, workerId: string, status: string): void {
  db.prepare("UPDATE workers SET status = ? WHERE id = ?").run(status, workerId);
}

const TEN_MINUTES = 10 * 60 * 1000;

test("a silent running worker raises stale_worker once, not every tick", async () => {
  const { db, workerId, monitor, clock } = await fixture();
  setStatus(db, workerId, "running");

  await monitor.tick();
  assert.equal(listWorkerAttentionItems(db, workerId).length, 0, "fresh worker is not stale");

  clock.now = new Date(clock.now.getTime() + TEN_MINUTES);
  await monitor.tick();
  const items = listWorkerAttentionItems(db, workerId).filter((i) => i.kind === "stale_worker");
  assert.equal(items.length, 1);
  assert.equal(items[0]?.priority, "high");
  assert.match(items[0]?.detail ?? "", /threshold 300s/);

  await monitor.tick();
  assert.equal(
    listWorkerAttentionItems(db, workerId).filter((i) => i.kind === "stale_worker").length,
    1,
    "the same silence episode is never raised twice",
  );
});

test("a worker stuck awaiting input past the threshold raises question_for_user", async () => {
  const { db, workerId, monitor, clock } = await fixture();
  setStatus(db, workerId, "awaiting_input");
  db.prepare("UPDATE workers SET last_message_at = ?, last_summary = ? WHERE id = ?").run(
    clock.now.toISOString(),
    "Should I also cover SSO?",
    workerId,
  );

  await monitor.tick();
  assert.equal(
    listWorkerAttentionItems(db, workerId).length,
    0,
    "a fresh question is dialogue, not an exception (chunk 3 ruling)",
  );

  clock.now = new Date(clock.now.getTime() + TEN_MINUTES);
  await monitor.tick();
  const items = listWorkerAttentionItems(db, workerId).filter(
    (i) => i.kind === "question_for_user",
  );
  assert.equal(items.length, 1);
  assert.match(items[0]?.detail ?? "", /Should I also cover SSO\?/);

  await monitor.tick();
  assert.equal(
    listWorkerAttentionItems(db, workerId).filter((i) => i.kind === "question_for_user").length,
    1,
  );
});

test("the mid-run lane audit catches a Bash-bypass file within a tick", async () => {
  const { db, workerId, worktree, monitor } = await fixture();
  setStatus(db, workerId, "running");
  db.prepare("UPDATE workers SET last_message_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    workerId,
  );

  mkdirSync(path.join(worktree, "src", "billing"), { recursive: true });
  writeFileSync(path.join(worktree, "src", "billing", "sneaky.ts"), "// out of lane\n");

  await monitor.tick();
  const violations = listWorkerAttentionItems(db, workerId).filter(
    (i) => i.kind === "lane_violation",
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.priority, "high");
  assert.match(violations[0]?.detail ?? "", /src\/billing\/sneaky\.ts/);

  await monitor.tick();
  assert.equal(
    listWorkerAttentionItems(db, workerId).filter((i) => i.kind === "lane_violation").length,
    1,
    "the same violation set is not re-raised",
  );
});

test("claims without evidence raise unsupported_claim; new evidence auto-resolves it", async () => {
  const { db, workerId, worktree, monitor } = await fixture();
  setStatus(db, workerId, "idle");
  createCompletionDigest(db, {
    workerId,
    narrative: "done",
    beforeAfter: [],
    claims: [{ text: "full suite passes", evidence_kind: "test", files: [] }],
    touchedAreas: [],
  });

  await monitor.tick();
  const raised = listWorkerAttentionItems(db, workerId).filter(
    (i) => i.kind === "unsupported_claim",
  );
  assert.equal(raised.length, 1);
  assert.match(raised[0]?.title ?? "", /test evidence that does not exist/);
  assert.match(raised[0]?.detail ?? "", /full suite passes/);

  // Evidence arrives (fresh, passing) — the item resolves itself with a reason.
  const worker = getWorker(db, workerId);
  assert.ok(worker);
  const workspace = await observeWorkspaceEvidence(worktree);
  createEvidenceRun(db, {
    projectId: worker.project_id,
    workerId,
    checkKey: "test",
    status: "passed",
    summary: "passed",
    headSha: workspace.key,
  });
  await monitor.tick();
  const after = listWorkerAttentionItems(db, workerId).filter(
    (i) => i.kind === "unsupported_claim",
  );
  assert.equal(after[0]?.status, "resolved");
  assert.match(after[0]?.detail ?? "", /Fresh evidence now supports/);
});

test("a clean completion is auto-reviewed only after ALL legs return clean", async () => {
  const { db, workerId, worktree, monitor, events, legRuns } = await fixture();
  setStatus(db, workerId, "idle");
  const worker = getWorker(db, workerId);
  assert.ok(worker);
  createCompletionDigest(db, {
    workerId,
    narrative: "done",
    beforeAfter: [],
    claims: [{ text: "tests pass", evidence_kind: "test", files: [] }],
    touchedAreas: [],
  });
  const workspace = await observeWorkspaceEvidence(worktree);
  for (const key of ["typecheck", "test"] as const) {
    createEvidenceRun(db, {
      projectId: worker.project_id,
      workerId,
      checkKey: key,
      status: "passed",
      summary: "passed",
      headSha: workspace.key,
    });
  }

  // Tick 1: legs are pending, so NOTHING is rubber-stamped yet — the tick
  // launches the watchdog and critic instead.
  await monitor.tick();
  assert.equal(
    latestDigestForWorker(db, workerId)?.status,
    "parsed",
    "no auto-review before the judgment legs have reviewed",
  );
  assert.deepEqual(
    legRuns.map((entry) => entry.split(":")[0]).sort(),
    ["critic", "watchdog"],
    "both legs launched exactly once",
  );

  // Tick 2: verdicts are in and clean — reviewed, with zero interruptions.
  await settleLegs();
  await monitor.tick();
  assert.equal(latestDigestForWorker(db, workerId)?.status, "manager_reviewed");
  assert.equal(
    listWorkerAttentionItems(db, workerId).filter((i) => i.status === "open").length,
    0,
    "no user interruption for a clean completion",
  );
  assert.ok(
    events.some((event) => event.type === "digest_reviewed" && event.workerId === workerId),
  );
  await monitor.tick();
  assert.equal(legRuns.length, 2, "verdicts are not re-run while fresh");
});

test("an unevidenced completion is NOT auto-reviewed, even with clean legs", async () => {
  const { db, workerId, monitor } = await fixture();
  setStatus(db, workerId, "idle");
  createCompletionDigest(db, {
    workerId,
    narrative: "done",
    beforeAfter: [],
    claims: [{ text: "tests pass", evidence_kind: "test", files: [] }],
    touchedAreas: [],
  });
  await monitor.tick();
  await settleLegs();
  await monitor.tick();
  assert.equal(
    latestDigestForWorker(db, workerId)?.status,
    "parsed",
    "no evidence, no rubber stamp — this one goes to triage",
  );
});

test("a tripwire alert blocks the completion and lands on the queue", async () => {
  const { db, workerId, worktree, monitor } = await fixture();
  setStatus(db, workerId, "idle");
  createCompletionDigest(db, {
    workerId,
    narrative: "done",
    beforeAfter: [],
    claims: [],
    touchedAreas: [],
  });
  // The worker "fixes" the checks instead of the code: rewrite the test
  // script in ITS OWN worktree copy of package.json.
  const packageJsonPath = path.join(worktree, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    scripts: Record<string, string>;
  };
  packageJson.scripts.test = "echo all good";
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

  await monitor.tick();
  const alerts = listWorkerAttentionItems(db, workerId).filter(
    (item) => item.kind === "integrity_alert",
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.priority, "high");
  assert.match(alerts[0]?.title ?? "", /check-script-modified/);
  assert.match(alerts[0]?.detail ?? "", /package\.json/);

  await settleLegs();
  await monitor.tick();
  assert.equal(
    latestDigestForWorker(db, workerId)?.status,
    "parsed",
    "a tripwired completion is never auto-reviewed, whatever the legs say",
  );
  assert.equal(
    listWorkerAttentionItems(db, workerId).filter((i) => i.kind === "integrity_alert").length,
    1,
    "the same tripwire is not re-raised",
  );
});

test("a watchdog gaming verdict raises a high-priority integrity alert", async () => {
  const { db, workerId, monitor, legs } = await fixture();
  setStatus(db, workerId, "idle");
  legs.watchdog = {
    verdict: "gaming",
    summary: "the transcript shows the suite being weakened until it passed",
  };
  createCompletionDigest(db, {
    workerId,
    narrative: "done",
    beforeAfter: [],
    claims: [],
    touchedAreas: [],
  });
  await monitor.tick(); // launches the legs
  await settleLegs();
  await monitor.tick(); // reads the verdicts
  const alerts = listWorkerAttentionItems(db, workerId).filter(
    (item) => item.kind === "integrity_alert",
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.priority, "high");
  assert.match(alerts[0]?.title ?? "", /gamed/);
  assert.match(alerts[0]?.detail ?? "", /weakened until it passed/);
  assert.equal(latestDigestForWorker(db, workerId)?.status, "parsed");
});

test("a new evidence run stales the critic verdict and re-arms the review (found live 2026-07-05)", async () => {
  const { db, workerId, worktree, monitor, legs, legRuns } = await fixture();
  setStatus(db, workerId, "idle");
  const worker = getWorker(db, workerId);
  assert.ok(worker);
  // First critique lands while NO evidence exists — a skeptical reject.
  legs.critic = { verdict: "reject", summary: "no execution evidence", findings: [
    { severity: "blocker", title: "nothing proves the tests pass", evidence: "no check runs exist" },
  ] };
  createCompletionDigest(db, {
    workerId,
    narrative: "done",
    beforeAfter: [],
    claims: [],
    touchedAreas: [],
  });
  await monitor.tick();
  await settleLegs();
  const runsAfterFirst = legRuns.filter((entry) => entry.startsWith("critic")).length;
  assert.equal(runsAfterFirst, 1);

  // Evidence arrives (triage ran the checks). The tree did NOT change — but
  // the verdict judged a different evidence pool, so it must re-arm.
  const workspace = await observeWorkspaceEvidence(worktree);
  createEvidenceRun(db, {
    projectId: worker.project_id,
    workerId,
    checkKey: "test",
    status: "passed",
    summary: "passed",
    headSha: workspace.key,
  });
  legs.critic = { verdict: "approve", summary: "evidence now proves it", findings: [] };
  await monitor.tick();
  await settleLegs();
  assert.equal(
    legRuns.filter((entry) => entry.startsWith("critic")).length,
    2,
    "the critic re-ran after the evidence pool changed",
  );
});

test("a failed leg run re-arms on a new digest or a moved workspace (coverage audit: no permanent poisoning)", async () => {
  const { db, workerId, worktree, monitor, legRuns } = await fixture();
  setStatus(db, workerId, "idle");
  const worker = getWorker(db, workerId);
  assert.ok(worker);
  createCompletionDigest(db, {
    workerId,
    narrative: "done",
    beforeAfter: [],
    claims: [],
    touchedAreas: [],
  });

  // A FAILED watchdog job at the current workspace state (transient auth
  // blip). Payload carries what it failed against.
  const workspace = await observeWorkspaceEvidence(worktree);
  const failedJob = createJob(db, "watchdog", {
    workerId,
    digestId: latestDigestForWorker(db, workerId)?.id,
    projectId: worker.project_id,
    evidenceKey: workspace.key,
  });
  startJob(db, failedJob.id);
  db.prepare("UPDATE jobs SET status = 'failed', error = 'not logged in' WHERE id = ?").run(
    failedJob.id,
  );

  await monitor.tick();
  assert.equal(
    legRuns.filter((entry) => entry.startsWith("watchdog")).length,
    0,
    "same state: the failure is honored, not self-retried",
  );

  // The workspace moves — the failure must not outlive what it judged.
  writeFileSync(path.join(worktree, "src", "auth", "more.ts"), "// new work\n");
  await monitor.tick();
  await settleLegs();
  assert.equal(
    legRuns.filter((entry) => entry.startsWith("watchdog")).length,
    1,
    "moved workspace re-arms the failed leg",
  );
});

test("a completion claiming only soft evidence still surfaces its missing required checks (coverage audit)", async () => {
  const { db, workerId, worktree, monitor, triaged, clock } = await fixture();
  setStatus(db, workerId, "idle");
  const worker = getWorker(db, workerId);
  assert.ok(worker);
  createCompletionDigest(db, {
    workerId,
    narrative: "done, looks great",
    beforeAfter: [],
    claims: [{ text: "eyeballed it", evidence_kind: "manual", files: [] }],
    touchedAreas: [],
  });

  await monitor.tick();
  const items = listWorkerAttentionItems(db, workerId).filter((i) => i.kind === "check_failed");
  assert.equal(items.length, 1, "the blocked-but-silent completion reaches the queue");
  assert.equal(items[0]?.priority, "high");
  assert.match(items[0]?.detail ?? "", /typecheck, test|test, typecheck/);
  // …which is exactly what makes triage fire for it.
  clock.now = new Date(clock.now.getTime() + 1000);
  await monitor.tick();
  assert.ok(triaged.length >= 1, "triage now has a reason to run the checks");

  // Evidence arrives → the item resolves itself.
  const workspace = await observeWorkspaceEvidence(worktree);
  for (const key of ["typecheck", "test"] as const) {
    createEvidenceRun(db, {
      projectId: worker.project_id,
      workerId,
      checkKey: key,
      status: "passed",
      summary: "passed",
      headSha: workspace.key,
    });
  }
  await monitor.tick();
  const after = listWorkerAttentionItems(db, workerId).filter((i) => i.kind === "check_failed");
  assert.equal(after[0]?.status, "resolved");
  assert.match(after[0]?.detail ?? "", /Every required check now passes/);
});

test("a critic rejection raises a high-priority integrity alert naming the blocker", async () => {
  const { db, workerId, monitor, legs } = await fixture();
  setStatus(db, workerId, "idle");
  legs.critic = {
    verdict: "reject",
    summary: "the asked-for behavior is missing",
    findings: [
      {
        severity: "blocker",
        title: "the brief asked for validation",
        evidence: "the diff only renames a variable",
      },
    ],
  };
  createCompletionDigest(db, {
    workerId,
    narrative: "done",
    beforeAfter: [],
    claims: [],
    touchedAreas: [],
  });
  await monitor.tick();
  await settleLegs();
  await monitor.tick();
  const alerts = listWorkerAttentionItems(db, workerId).filter(
    (item) => item.kind === "integrity_alert",
  );
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]?.title ?? "", /does not hold against its brief/);
  assert.match(alerts[0]?.detail ?? "", /only renames a variable/);
});

test("main-checkout watch: a new lane-relevant file in the primary checkout raises attention once", async () => {
  const { db, project, workerId, monitor } = await fixture();
  setStatus(db, workerId, "running");
  db.prepare("UPDATE workers SET last_message_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    workerId,
  );

  await monitor.tick(); // baseline snapshot

  // An unrelated user edit outside every lane: watched, never raised.
  writeFileSync(path.join(project.root_path, "notes.md"), "my own notes\n");
  await monitor.tick();
  let checkoutItems = listOpenAttentionItems(db, project.id).filter((item) =>
    item.title.includes("Main checkout"),
  );
  assert.equal(checkoutItems.length, 0, "files no lane claims are the user's business");

  // A new file INSIDE a live lane's globs, in the MAIN checkout.
  writeFileSync(path.join(project.root_path, "src", "auth", "planted.ts"), "// suspicious\n");
  await monitor.tick();
  checkoutItems = listOpenAttentionItems(db, project.id).filter((item) =>
    item.title.includes("Main checkout"),
  );
  assert.equal(checkoutItems.length, 1);
  assert.equal(checkoutItems[0]?.priority, "normal");
  assert.match(checkoutItems[0]?.detail ?? "", /src\/auth\/planted\.ts/);
  assert.match(checkoutItems[0]?.detail ?? "", /your own edit/);

  await monitor.tick();
  assert.equal(
    listOpenAttentionItems(db, project.id).filter((item) => item.title.includes("Main checkout"))
      .length,
    1,
    "the same drift is not re-raised",
  );
});

test("triage triggers only on NEW open attention since the last attempt", async () => {
  const { db, project, workerId, monitor, triaged, clock } = await fixture();
  setStatus(db, workerId, "running");

  await monitor.tick();
  assert.equal(triaged.length, 0, "nothing open, no triage");

  clock.now = new Date(clock.now.getTime() + TEN_MINUTES);
  await monitor.tick(); // raises stale_worker → triage fires
  assert.equal(triaged.length, 1);

  await monitor.tick();
  assert.equal(triaged.length, 1, "the same open items do not re-trigger triage");

  createAttentionItem(db, {
    projectId: project.id,
    kind: "decision_needed",
    title: "Pick a payment provider",
    detail: "Stripe or PromptPay first?",
  });
  await monitor.tick();
  assert.equal(triaged.length, 2, "a new item after the last attempt re-triggers");
});
