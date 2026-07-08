// Evidence adapter: SQLite rows + git observations → engine signals, and
// digest claims → verified/unverified/unsupported/contradicted links.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/adapters/db/db";
import { loadConfig } from "../src/config";
import { registerProject } from "../src/adapters/db/repos/projects";
import { createEvidenceRun, type EvidenceRunRow, type CheckKey } from "../src/adapters/db/repos/evidence";
import { createCompletionDigest } from "../src/adapters/db/repos/digests";
import { createWorkerRuntime } from "../src/adapters/agent/worker-runtime";
import type { WorkerSession } from "../src/adapters/agent/worker-session";
import { getWorker } from "../src/adapters/db/repos/workers";
import { getLane } from "../src/adapters/db/repos/lanes";
import { buildWorkerEvidence, linkClaims, REQUIRED_ON_COMPLETION } from "../src/adapters/evidence/adapter";
import { computeProjectConfidence } from "../src/adapters/evidence/confidence";
import { observeWorkspaceEvidence } from "../src/adapters/evidence/workspace";
import type { CompletionClaim } from "../src/core/digests/completion";

function fixtureRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glp-ev-repo-"));
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

/** An inert session — these tests exercise evidence, not streaming. */
function inertSession(): WorkerSession {
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>(() => {}); // never yields, never ends
      },
    },
    send() {},
    async stop() {},
  };
}

async function fixture() {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-ev-state-"));
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
  const worker = getWorker(db, spawned.workerId);
  assert.ok(worker);
  if (!worker) {
    throw new Error("unreachable");
  }
  const lane = getLane(db, worker.lane_id) ?? null;
  return { db, config, project, worker, lane, worktree: spawned.worktreePath };
}

function fakeRun(key: CheckKey, status: "passed" | "failed", headSha: string): EvidenceRunRow {
  return {
    id: `run-${key}-${status}`,
    project_id: "p",
    worker_id: "w",
    check_key: key,
    status,
    summary: `${status} fixture`,
    log_path: null,
    head_sha: headSha,
    created_at: new Date().toISOString(),
  };
}

const KEY = "sha-current";

test("linkClaims: the full verification matrix", () => {
  const claims: CompletionClaim[] = [
    { text: "types check", evidence_kind: "typecheck", files: [] },
    { text: "tests pass", evidence_kind: "test", files: [] },
    { text: "lint clean", evidence_kind: "lint", files: [] },
    { text: "builds fine", evidence_kind: "build", files: [] },
    { text: "eyeballed it", evidence_kind: "manual", files: [] },
    { text: "changed login", evidence_kind: "diff", files: ["src/auth/login.ts"] },
    { text: "changed billing", evidence_kind: "diff", files: ["src/billing/x.ts"] },
  ];
  const latestRuns = new Map<CheckKey, EvidenceRunRow>([
    ["typecheck", fakeRun("typecheck", "passed", KEY)], // fresh pass → verified
    ["test", fakeRun("test", "failed", KEY)], // fresh fail → contradicted
    ["lint", fakeRun("lint", "passed", "sha-old")], // stale → unverified
    // build: no run → unsupported
  ]);
  const linked = linkClaims({
    claims,
    latestRuns,
    workspaceKey: KEY,
    changedFiles: ["src/auth/login.ts"],
  });

  const byText = new Map(linked.map((claim) => [claim.text, claim]));
  assert.equal(byText.get("types check")?.verification, "verified");
  assert.equal(byText.get("types check")?.evidenceRunId, "run-typecheck-passed");
  assert.equal(byText.get("tests pass")?.verification, "contradicted");
  assert.match(byText.get("tests pass")?.reason ?? "", /FAILED/);
  assert.equal(byText.get("lint clean")?.verification, "unverified");
  assert.match(byText.get("lint clean")?.reason ?? "", /predates/);
  assert.equal(byText.get("builds fine")?.verification, "unsupported");
  assert.equal(byText.get("eyeballed it")?.verification, "unverified");
  assert.equal(byText.get("changed login")?.verification, "verified");
  assert.equal(byText.get("changed billing")?.verification, "contradicted");
  assert.match(byText.get("changed billing")?.reason ?? "", /src\/billing\/x\.ts/);
});

test("linkClaims degrades honestly when the workspace or audit is unobservable", () => {
  const claims: CompletionClaim[] = [
    { text: "tests pass", evidence_kind: "test", files: [] },
    { text: "changed login", evidence_kind: "diff", files: ["src/auth/login.ts"] },
  ];
  const linked = linkClaims({
    claims,
    latestRuns: new Map([["test", fakeRun("test", "passed", KEY)]]),
    workspaceKey: null,
    changedFiles: null,
  });
  assert.equal(linked[0]?.verification, "unverified");
  assert.match(linked[0]?.reason ?? "", /unobservable/);
  assert.equal(linked[1]?.verification, "unverified");
  assert.match(linked[1]?.reason ?? "", /unavailable/);
});

test("buildWorkerEvidence: an in-progress worker demands nothing; completion demands the configured required checks", async () => {
  const { db, worker, lane, config } = await fixture();

  const before = await buildWorkerEvidence(db, {
    worker,
    lane,
    staleWorkerSeconds: config.staleWorkerSeconds,
  });
  assert.deepEqual(before.input.checks.requiredKeys, [], "no digest, nothing demanded");
  assert.equal(before.input.hasDigest, false);
  assert.ok(before.input.laneAudit.ran);

  createCompletionDigest(db, {
    workerId: worker.id,
    narrative: "done",
    beforeAfter: [],
    claims: [{ text: "tests pass", evidence_kind: "test", files: [] }],
    touchedAreas: [],
  });
  const after = await buildWorkerEvidence(db, {
    worker,
    lane,
    staleWorkerSeconds: config.staleWorkerSeconds,
  });
  // The fixture repo configures typecheck+test but no build — only what
  // exists can be demanded.
  assert.deepEqual(after.input.checks.requiredKeys, ["typecheck", "test"]);
  assert.ok(REQUIRED_ON_COMPLETION.includes("build"), "build is policy, just not configured here");
  assert.equal(after.linkedClaims[0]?.verification, "unsupported");
});

test("buildWorkerEvidence: silence counts only against running workers, and freshness follows the worktree", async () => {
  const { db, worker, lane, config } = await fixture();
  const past = new Date(Date.now() + 10 * 60 * 1000); // 10min after spawn

  // spawning + silent beyond threshold → stale
  const spawning = await buildWorkerEvidence(db, { worker, lane, staleWorkerSeconds: 300, now: past });
  assert.equal(spawning.input.liveness.kind, "live");
  assert.ok(spawning.input.liveness.kind === "live" && spawning.input.liveness.stale);

  // awaiting_input is silent by design — never stale
  db.prepare("UPDATE workers SET status = 'awaiting_input' WHERE id = ?").run(worker.id);
  const waiting = await buildWorkerEvidence(db, {
    worker: { ...worker, status: "awaiting_input" },
    lane,
    staleWorkerSeconds: 300,
    now: past,
  });
  assert.ok(waiting.input.liveness.kind === "live" && !waiting.input.liveness.stale);

  // Evidence keyed to the worktree state is fresh until the worktree changes.
  const workspace = await observeWorkspaceEvidence(worker.worktree_path);
  createEvidenceRun(db, {
    projectId: worker.project_id,
    workerId: worker.id,
    checkKey: "test",
    status: "passed",
    summary: "passed",
    headSha: workspace.key,
  });
  const fresh = await buildWorkerEvidence(db, { worker, lane, staleWorkerSeconds: 300 });
  assert.deepEqual(fresh.input.checks.runs, [{ key: "test", status: "passed", fresh: true }]);

  writeFileSync(path.join(worker.worktree_path, "src", "auth", "drift.ts"), "// drift\n");
  const stale = await buildWorkerEvidence(db, { worker, lane, staleWorkerSeconds: 300 });
  assert.deepEqual(stale.input.checks.runs, [{ key: "test", status: "passed", fresh: false }]);
});

test("computeProjectConfidence: worker evidence reaches the project gauge; closed quiet workers drop out", async () => {
  const { db, project, worker, config } = await fixture();

  const first = await computeProjectConfidence(db, {
    project,
    staleWorkerSeconds: config.staleWorkerSeconds,
  });
  assert.equal(first.workers.length, 1);
  assert.ok(first.workers[0]?.countsTowardProject, "a live worker counts");
  assert.ok(
    first.project.caps.some((cap) => cap.id === "evidence.records-alone"),
    "no evidence anywhere → records-alone cap",
  );

  // Fresh passing worker evidence lifts the records-alone cap.
  const workspace = await observeWorkspaceEvidence(worker.worktree_path);
  createEvidenceRun(db, {
    projectId: project.id,
    workerId: worker.id,
    checkKey: "test",
    status: "passed",
    summary: "passed",
    headSha: workspace.key,
  });
  const second = await computeProjectConfidence(db, {
    project,
    staleWorkerSeconds: config.staleWorkerSeconds,
  });
  assert.ok(
    !second.project.caps.some((cap) => cap.id === "evidence.records-alone"),
    "fresh worker evidence counts as real evidence",
  );

  // A stopped worker with nothing open and no unreviewed digest is history.
  db.prepare("UPDATE workers SET status = 'stopped' WHERE id = ?").run(worker.id);
  const third = await computeProjectConfidence(db, {
    project,
    staleWorkerSeconds: config.staleWorkerSeconds,
  });
  assert.equal(third.workers[0]?.countsTowardProject, false);
});
