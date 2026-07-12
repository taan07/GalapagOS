import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type GalapagosDb } from "../src/adapters/db/db";
import { loadConfig, type GalapagosConfig } from "../src/config";
import { registerProject, type ProjectRow } from "../src/adapters/db/repos/projects";
import { getLane, listActiveLanes, retireLane } from "../src/adapters/db/repos/lanes";
import { getWorker, listWorkerEvents, listWorkers } from "../src/adapters/db/repos/workers";
import { buildWorkerEvidence } from "../src/adapters/evidence/adapter";
import { scoreWorker } from "../src/core/confidence/engine";
import { latestDigestForWorker } from "../src/adapters/db/repos/digests";
import { listWorkerAttentionItems } from "../src/adapters/db/repos/attention";
import {
  collectAuditFiles,
  createWorkerRuntime,
  type LaneViolationNotice,
  type WorkerBroadcast,
  type WorkerRuntime,
} from "../src/adapters/agent/worker-runtime";
import { listWorkerSteps } from "../src/adapters/db/repos/worker-steps";
import type {
  SpawnWorkerSessionInput,
  WorkerSession,
  WorkerStreamEvent,
} from "../src/adapters/agent/worker-session";

function fixtureRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glp-rt-repo-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Galapagos Tests"]);
  git(["config", "user.email", "tests@galapagos.local"]);
  writeFileSync(path.join(dir, "README.md"), "fixture\n");
  mkdirSync(path.join(dir, "src", "auth"), { recursive: true });
  writeFileSync(path.join(dir, "src", "auth", "login.ts"), "export const x = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-m", "initial fixture commit"]);
  return dir;
}

/** A controllable stand-in for the SDK-backed session. */
function fakeSession() {
  const pending: WorkerStreamEvent[] = [];
  const sent: string[] = [];
  let interrupts = 0;
  let ended = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const session: WorkerSession = {
    events: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = pending.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (ended) {
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
    send(text: string) {
      sent.push(text);
    },
    async interrupt() {
      interrupts += 1;
    },
    async stop() {
      ended = true;
      notify();
    },
  };
  return {
    session,
    sent,
    interruptCount: () => interrupts,
    emit(event: WorkerStreamEvent) {
      pending.push(event);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
  };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

type Fixture = {
  db: GalapagosDb;
  config: GalapagosConfig;
  project: ProjectRow;
  runtime: WorkerRuntime;
  sessions: ReturnType<typeof fakeSession>[];
  spawnInputs: SpawnWorkerSessionInput[];
  broadcasts: WorkerBroadcast[];
};

async function fixture(opts?: {
  onLaneViolation?: (notice: LaneViolationNotice) => void;
  reapTimeoutMs?: number;
}): Promise<Fixture> {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-rt-state-"));
  const config = loadConfig({ ...process.env, GALAPAGOS_STATE_DIR: stateDir });
  const db = openDb(stateDir);
  const project = await registerProject(db, { rootPath: fixtureRepo() });
  const sessions: ReturnType<typeof fakeSession>[] = [];
  const spawnInputs: SpawnWorkerSessionInput[] = [];
  const broadcasts: WorkerBroadcast[] = [];
  const runtime = createWorkerRuntime({
    db,
    config,
    onLaneViolation: opts?.onLaneViolation,
    reapTimeoutMs: opts?.reapTimeoutMs,
    broadcast: (event) => broadcasts.push(event),
    sessionFactory: (input) => {
      spawnInputs.push(input);
      const fake = fakeSession();
      sessions.push(fake);
      return fake.session;
    },
  });
  return { db, config, project, runtime, sessions, spawnInputs, broadcasts };
}

/**
 * A new runtime over the same db = the restarted daemon (empty live map),
 * with its own fake-session capture arrays so re-attach spawns are observable
 * and never hit the real SDK.
 */
function restartedRuntime(db: GalapagosDb, config: GalapagosConfig) {
  const sessions: ReturnType<typeof fakeSession>[] = [];
  const spawnInputs: SpawnWorkerSessionInput[] = [];
  const runtime = createWorkerRuntime({
    db,
    config,
    sessionFactory: (input) => {
      spawnInputs.push(input);
      const fake = fakeSession();
      sessions.push(fake);
      return fake.session;
    },
  });
  return { runtime, sessions, spawnInputs };
}

const SPAWN_INPUT = {
  laneName: "auth ui",
  allowedGlobs: ["src/auth/**"],
  forbiddenGlobs: ["**/*.env"],
  briefTitle: "Harden the login form",
  brief: "Add validation to the login form. Verify with unit tests.",
};

const VALID_COMPLETION =
  "Done.\n```galapagos-completion\n" +
  JSON.stringify({
    narrative: "Login form validates input.",
    before_after: [{ before: "any input accepted", after: "invalid input rejected" }],
    claims: [{ text: "tests pass", evidence_kind: "test", files: ["src/auth/login.ts"] }],
    touched_areas: ["src/auth"],
  }) +
  "\n```";

test("spawn creates the lane, worktree, committed brief record, and running worker", async () => {
  const { db, project, runtime, sessions, spawnInputs } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok, JSON.stringify(outcome));
  if (!outcome.ok) {
    return;
  }

  assert.equal(outcome.laneSlug, "auth-ui");
  assert.equal(outcome.branch, "galapagos/worker/auth-ui");
  assert.ok(existsSync(path.join(outcome.worktreePath, "README.md")), "worktree materialized");
  assert.ok(
    !outcome.worktreePath.startsWith(project.root_path),
    "worktree lives outside the target repo",
  );

  // The brief record is on disk under briefs/ and committed to the repo.
  const briefsDir = path.join(project.root_path, "docs", "galapagos", "briefs");
  const briefFiles = readdirSync(briefsDir);
  assert.equal(briefFiles.length, 1);
  const briefBody = readFileSync(path.join(briefsDir, briefFiles[0] ?? ""), "utf8");
  assert.match(briefBody, /glp_type: "worker_brief"/);
  assert.match(briefBody, /src\/auth\/\*\*/);
  const log = execFileSync("git", ["log", "--oneline", "-1"], {
    cwd: project.root_path,
    encoding: "utf8",
  });
  assert.match(log, /worker brief for lane auth-ui/);

  // The session got the worktree cwd, the brief as first message, the lane
  // contract, and a doctrine that echoes the globs and the report contract.
  const spawnInput = spawnInputs[0];
  assert.ok(spawnInput);
  assert.equal(spawnInput.worktreePath, outcome.worktreePath);
  assert.equal(spawnInput.briefText, SPAWN_INPUT.brief);
  assert.deepEqual(spawnInput.lane, {
    allowedGlobs: ["src/auth/**"],
    forbiddenGlobs: ["**/*.env"],
  });
  assert.match(spawnInput.systemPrompt, /src\/auth\/\*\*/);
  assert.match(spawnInput.systemPrompt, /galapagos-completion/);

  sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(
    () => getWorker(db, outcome.workerId)?.status === "running",
    "worker running after init",
  );
  assert.equal(getWorker(db, outcome.workerId)?.sdk_session_id, "sdk-w1");
});

test("spawn rejects allowed-glob overlap with any active lane, naming the collision", async () => {
  const { db, project, runtime } = await fixture();
  const first = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(first.ok);

  const second = await runtime.spawn({
    project,
    laneName: "auth backend",
    allowedGlobs: ["src/**"],
    briefTitle: "t",
    brief: "b",
  });
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.match(second.reason, /overlaps "src\/auth\/\*\*"/);
    assert.match(second.reason, /auth ui/);
  }
  assert.equal(listActiveLanes(db, project.id).length, 1, "no lane row leaked");

  const sameName = await runtime.spawn({
    project,
    laneName: "auth-ui",
    allowedGlobs: ["docs/**"],
    briefTitle: "t",
    brief: "b",
  });
  assert.equal(sameName.ok, false);
  if (!sameName.ok) {
    assert.match(sameName.reason, /already named/);
  }
});

test("a worker without a lane contract is refused", async () => {
  const { project, runtime } = await fixture();
  const outcome = await runtime.spawn({
    project,
    laneName: "lawless",
    allowedGlobs: [],
    briefTitle: "t",
    brief: "b",
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(outcome.reason, /no worker runs without a lane contract/);
  }
});

test("leftover worktree dirs and branches reject cleanly — no rows, no failed workers", async () => {
  const { db, config, project, runtime } = await fixture();
  // A directory left behind by a previous lane of the same name…
  const leftover = path.join(config.stateDir, "worktrees", project.slug, "auth-ui");
  mkdirSync(leftover, { recursive: true });
  const dirCase = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.equal(dirCase.ok, false);
  if (!dirCase.ok) {
    assert.match(dirCase.reason, /left its worktree/);
    assert.match(dirCase.reason, /Pick a NEW lane name/);
  }

  // …and a leftover branch without a directory are both clean rejections.
  rmSync(leftover, { recursive: true });
  execFileSync("git", ["branch", "galapagos/worker/auth-ui", "HEAD"], {
    cwd: project.root_path,
  });
  const branchCase = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.equal(branchCase.ok, false);
  if (!branchCase.ok) {
    assert.match(branchCase.reason, /branch galapagos\/worker\/auth-ui already exists/);
  }

  assert.equal(listActiveLanes(db, project.id).length, 0, "no lane row leaked");
  assert.equal(runtime.list(project.id).length, 0, "no worker row leaked");
});

test("streamed events persist; a valid completion result becomes a digest and idle", async () => {
  const { db, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  const fake = sessions[0];
  assert.ok(fake);

  fake.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  fake.emit({ kind: "assistant", payload: { text: "Reading the form code." } });
  fake.emit({ kind: "tool_use", payload: { tool: "Read", input: { file_path: "src/auth/login.ts" } } });
  fake.emit({ kind: "tool_result", payload: { content: "export const x = 1;", isError: false } });
  fake.emit({
    kind: "result",
    payload: { subtype: "success", isError: false, resultText: VALID_COMPLETION },
  });

  await waitFor(
    () => getWorker(db, outcome.workerId)?.status === "idle",
    "worker idle after success result",
  );
  const kinds = listWorkerEvents(db, outcome.workerId).map((event) => event.kind);
  assert.deepEqual(kinds, ["assistant", "tool_use", "tool_result", "result"]);

  const digest = latestDigestForWorker(db, outcome.workerId);
  assert.equal(digest?.narrative, "Login form validates input.");
  assert.equal(digest?.status, "parsed");
  assert.deepEqual(JSON.parse(digest?.touched_areas ?? "[]"), ["src/auth"]);
  assert.equal(
    getWorker(db, outcome.workerId)?.last_summary,
    "Login form validates input.",
    "the digest narrative becomes the liveness summary",
  );
  assert.equal(listWorkerAttentionItems(db, outcome.workerId).length, 0);
});

test("a malformed completion block raises attention immediately; a block-less turn does not", async () => {
  const { db, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  const fake = sessions[0];
  assert.ok(fake);

  // Mid-task question turn — no block, no attention; the worker is waiting
  // on its manager, so the honest status is awaiting_input, not idle.
  fake.emit({
    kind: "result",
    payload: { subtype: "success", isError: false, resultText: "Should I also cover SSO?" },
  });
  await waitFor(
    () => getWorker(db, outcome.workerId)?.status === "awaiting_input",
    "awaiting_input after question",
  );
  assert.equal(listWorkerAttentionItems(db, outcome.workerId).length, 0);

  // Botched completion claim — malformed block, immediate attention.
  fake.emit({
    kind: "result",
    payload: {
      subtype: "success",
      isError: false,
      resultText: "Done!\n```galapagos-completion\n{ not json }\n```",
    },
  });
  await waitFor(
    () => listWorkerAttentionItems(db, outcome.workerId).length === 1,
    "attention after malformed block",
  );
  const item = listWorkerAttentionItems(db, outcome.workerId)[0];
  assert.equal(item?.kind, "unstructured_completion");
  assert.match(item?.detail ?? "", /not valid JSON/);
  assert.equal(latestDigestForWorker(db, outcome.workerId), undefined);
});

test("steer injects into the live session and records a steer event", async () => {
  const { db, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }

  const steered = await runtime.steer(outcome.workerId, "Focus on the email field first.");
  assert.deepEqual(steered, { ok: true, response: null });
  assert.deepEqual(sessions[0]?.sent, ["Focus on the email field first."]);
  const events = listWorkerEvents(db, outcome.workerId);
  assert.equal(events.at(-1)?.kind, "steer");
  assert.equal(getWorker(db, outcome.workerId)?.status, "running");

  const missing = await runtime.steer("nope", "hello");
  assert.equal(missing.ok, false);
});

test("stop audits the lane: an out-of-lane Bash-style edit raises a high-priority violation", async () => {
  const { db, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });

  // Simulate the documented Bash bypass: files changed outside the lane,
  // one dirty and one committed, plus a legitimate in-lane change.
  writeFileSync(path.join(outcome.worktreePath, "src", "auth", "login.ts"), "// in lane\n");
  mkdirSync(path.join(outcome.worktreePath, "src", "billing"), { recursive: true });
  writeFileSync(path.join(outcome.worktreePath, "src", "billing", "sneaky.ts"), "// out\n");
  writeFileSync(path.join(outcome.worktreePath, "README.md"), "tampered\n");
  execFileSync("git", ["add", "README.md"], { cwd: outcome.worktreePath });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Galapagos Tests",
      "-c",
      "user.email=tests@galapagos.local",
      "commit",
      "-m",
      "tamper",
    ],
    { cwd: outcome.worktreePath },
  );

  const stopped = await runtime.stop(outcome.workerId);
  assert.ok(stopped.ok);
  if (!stopped.ok) {
    return;
  }
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(
    stopped.violations.map((entry) => entry.path).sort(),
    ["README.md", "src/billing/sneaky.ts"],
    "committed and dirty out-of-lane files are both caught; the in-lane edit is not",
  );
  assert.equal(stopped.hasDigest, false);

  const attention = listWorkerAttentionItems(db, outcome.workerId);
  const violation = attention.find((item) => item.kind === "lane_violation");
  assert.ok(violation, "lane_violation attention row exists");
  assert.equal(violation?.priority, "high");
  assert.match(violation?.detail ?? "", /README\.md/);
  assert.ok(
    attention.some((item) => item.kind === "unstructured_completion"),
    "stopping without a digest raises unstructured_completion",
  );

  assert.equal(runtime.list(project.id)[0]?.lane?.status, "retired");
  assert.ok(existsSync(outcome.worktreePath), "the worktree survives stop for review");
});

test("a Bash-written out-of-lane file freezes the worker, raises the violation, and wakes Darwin once", async () => {
  const notices: LaneViolationNotice[] = [];
  const { db, project, runtime, sessions } = await fixture({
    onLaneViolation: (notice) => notices.push(notice),
  });
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });

  // The Bash bypass: a file appears outside the lane with no Edit/Write the
  // canUseTool gate could catch. The guard fires when the Bash result lands.
  mkdirSync(path.join(outcome.worktreePath, "src", "billing"), { recursive: true });
  writeFileSync(path.join(outcome.worktreePath, "src", "billing", "sneaky.ts"), "// out\n");
  sessions[0]?.emit({ kind: "tool_use", payload: { tool: "Bash", input: { command: "echo x" } } });
  sessions[0]?.emit({ kind: "tool_result", payload: { content: "x", isError: false } });

  await waitFor(() => notices.length === 1, "Darwin woken by the lane violation");
  const notice = notices[0];
  assert.equal(notice?.workerId, outcome.workerId);
  assert.equal(notice?.laneName, "auth ui");
  assert.deepEqual(
    notice?.violations.map((v) => v.path),
    ["src/billing/sneaky.ts"],
  );

  // The worker was frozen: a HOLD steer was enqueued to its session.
  assert.equal(
    sessions[0]?.sent.filter((m) => m.startsWith("HOLD")).length,
    1,
    "the worker is held exactly once",
  );
  const violation = listWorkerAttentionItems(db, outcome.workerId).find(
    (item) => item.kind === "lane_violation",
  );
  assert.ok(violation, "a high-priority lane_violation item was raised");
  assert.equal(violation?.priority, "high");

  // Debounce: another Bash over the SAME stray set must not re-fire.
  sessions[0]?.emit({ kind: "tool_use", payload: { tool: "Bash", input: { command: "ls" } } });
  sessions[0]?.emit({ kind: "tool_result", payload: { content: "", isError: false } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(notices.length, 1, "the same violation set does not wake Darwin twice");
  assert.equal(
    sessions[0]?.sent.filter((m) => m.startsWith("HOLD")).length,
    1,
    "the worker is not held again for the same stray",
  );
});

test("Bash-written build artifacts never trip the lane guard", async () => {
  const notices: LaneViolationNotice[] = [];
  const { db, project, runtime, sessions } = await fixture({
    onLaneViolation: (notice) => notices.push(notice),
  });
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });

  // `npm install` / a build leaves untracked node_modules + dist. In this
  // fixture repo they are NOT gitignored — the exact flood scenario.
  mkdirSync(path.join(outcome.worktreePath, "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(outcome.worktreePath, "node_modules", "dep", "index.js"), "x\n");
  mkdirSync(path.join(outcome.worktreePath, "dist"), { recursive: true });
  writeFileSync(path.join(outcome.worktreePath, "dist", "bundle.js"), "x\n");
  sessions[0]?.emit({
    kind: "tool_use",
    payload: { tool: "Bash", input: { command: "npm install" } },
  });
  sessions[0]?.emit({ kind: "tool_result", payload: { content: "added 1 package", isError: false } });

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(notices.length, 0, "generated output is not a lane violation");
  assert.equal(
    sessions[0]?.sent.filter((m) => m.startsWith("HOLD")).length,
    0,
    "the worker is not frozen for build output",
  );
  assert.equal(
    listWorkerAttentionItems(db, outcome.workerId).filter((i) => i.kind === "lane_violation")
      .length,
    0,
    "no lane_violation item is raised for build output",
  );
});

test("stop on a clean, reported worker: no violations, digest acknowledged, lane retired", async () => {
  const { db, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  const fake = sessions[0];
  assert.ok(fake);
  fake.emit({
    kind: "result",
    payload: { subtype: "success", isError: false, resultText: VALID_COMPLETION },
  });
  await waitFor(() => latestDigestForWorker(db, outcome.workerId) !== undefined, "digest parsed");

  const stopped = await runtime.stop(outcome.workerId);
  assert.ok(stopped.ok);
  if (!stopped.ok) {
    return;
  }
  assert.deepEqual(stopped.violations, []);
  assert.equal(stopped.hasDigest, true);
  assert.equal(listWorkerAttentionItems(db, outcome.workerId).length, 0);
  assert.equal(listActiveLanes(db, project.id).length, 0);

  const again = await runtime.stop(outcome.workerId);
  assert.equal(again.ok, false);
});

test("an error result marks the worker failed and is never retried", async () => {
  const { db, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  sessions[0]?.emit({
    kind: "result",
    payload: { subtype: "error_during_execution", isError: true, resultText: null },
  });
  sessions[0]?.end();
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "failed", "worker failed");
  assert.equal(runtime.list(project.id).length, 1, "no fresh-session retry spawned");

  // A mid-run death reaches the QUEUE, not just the gauge — one open
  // worker_failed item carrying the worktree path (chunk 4 decision 6).
  const failures = listWorkerAttentionItems(db, outcome.workerId).filter(
    (item) => item.kind === "worker_failed",
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.priority, "high");
  assert.ok(failures[0]?.detail.includes(outcome.worktreePath), "detail names the worktree");

  // A failed worker cannot be steered back to life…
  const steered = await runtime.steer(outcome.workerId, "keep going");
  assert.equal(steered.ok, false);
  assert.equal(getWorker(db, outcome.workerId)?.status, "failed");

  // …its first stop runs the audit and keeps it failed…
  const stopped = await runtime.stop(outcome.workerId);
  assert.ok(stopped.ok);
  if (stopped.ok) {
    assert.equal(stopped.status, "failed");
  }
  const attentionAfterFirstStop = listWorkerAttentionItems(db, outcome.workerId).length;

  // …and a second stop is refused instead of duplicating attention items.
  const again = await runtime.stop(outcome.workerId);
  assert.equal(again.ok, false);
  if (!again.ok) {
    assert.match(again.reason, /already failed/);
  }
  assert.equal(listWorkerAttentionItems(db, outcome.workerId).length, attentionAfterFirstStop);
});

test("a fatal turn error kills the session — failed workers never linger as live", async () => {
  const { db, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  const fake = sessions[0];
  assert.ok(fake);
  fake.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");

  // The stream does NOT end on its own — the runtime must kill the session
  // itself, or the dead worker stays in the live map (the zombie that wedged
  // steer and resume into mutual rejection).
  fake.emit({
    kind: "result",
    payload: { subtype: "error_during_execution", isError: true, resultText: null },
  });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "failed", "worker failed");

  // Steer refuses with advice that actually works…
  const steered = await runtime.steer(outcome.workerId, "keep going");
  assert.equal(steered.ok, false);
  if (!steered.ok) {
    assert.match(steered.reason, /resume_worker/);
  }
  // …and resume actually works — no "still live, steer it" runaround.
  const resumed = await runtime.resume({ project, workerId: outcome.workerId });
  assert.ok(resumed.ok, `resume must succeed after a fatal error: ${resumed.ok ? "" : resumed.reason}`);
  if (resumed.ok) {
    assert.equal(resumed.worktreePath, outcome.worktreePath, "same worktree, same work");
    assert.notEqual(resumed.workerId, outcome.workerId, "a fresh session, not resurrection");
  }
});

test("resume reaps a dead-but-lingering session instead of rejecting", async () => {
  const { db, project, runtime, sessions } = await fixture({ reapTimeoutMs: 50 });
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  const fake = sessions[0];
  assert.ok(fake);
  fake.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");

  // A truly hung process: it ignores the runtime's kill, so the dead worker
  // lingers in the live map with the lane held hostage — the exact state
  // Darwin reported ("resume says live, steer says failed").
  fake.session.stop = async () => {};
  fake.emit({
    kind: "result",
    payload: { subtype: "error_during_execution", isError: true, resultText: null },
  });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "failed", "worker failed");

  const steered = await runtime.steer(outcome.workerId, "keep going");
  assert.equal(steered.ok, false);

  // Resume must reap the zombie (bounded wait) and proceed, not bounce back.
  const resumed = await runtime.resume({ project, workerId: outcome.workerId });
  assert.ok(resumed.ok, `resume must reap and proceed: ${resumed.ok ? "" : resumed.reason}`);
  if (resumed.ok) {
    assert.equal(resumed.worktreePath, outcome.worktreePath, "same worktree, same work");
  }
  // The lane belongs to the successor now — exactly one active lane.
  assert.equal(listActiveLanes(db, project.id).length, 1);
});

test("an interrupt-induced error result during stop leaves the worker stopped, not failed", async () => {
  const { db, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  const fake = sessions[0];
  assert.ok(fake);
  fake.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");

  // Some interrupts surface as an error RESULT rather than a stream error.
  const originalStop = fake.session.stop.bind(fake.session);
  fake.session.stop = async () => {
    fake.emit({
      kind: "result",
      payload: { subtype: "error_during_execution", isError: true, resultText: null },
    });
    await originalStop();
  };

  const stopped = await runtime.stop(outcome.workerId);
  assert.ok(stopped.ok);
  if (stopped.ok) {
    assert.equal(stopped.status, "stopped", "a user-stopped worker is not a failed worker");
  }
});

test("reconcileOrphans finalizes an orphan whose worktree is gone — nothing to re-attach", async () => {
  const { db, config, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");

  // Resume is cwd-keyed: with the worktree gone, the session cannot come back.
  rmSync(outcome.worktreePath, { recursive: true, force: true });

  const restarted = restartedRuntime(db, config);
  const counts = await restarted.runtime.reconcileOrphans();
  assert.deepEqual(counts, { reattached: 0, finalized: 1 });
  assert.equal(restarted.spawnInputs.length, 0, "no session spawned for an unrecoverable orphan");

  const worker = getWorker(db, outcome.workerId);
  assert.equal(worker?.status, "stopped");
  assert.equal(listActiveLanes(db, project.id).length, 0, "lane freed for new spawns");
  const payloads = listWorkerEvents(db, outcome.workerId).map(
    (event) => JSON.parse(event.payload) as Record<string, unknown>,
  );
  assert.ok(
    payloads.some((payload) => /Daemon restarted/.test(String(payload.message ?? ""))),
    "the restart is recorded honestly",
  );
  assert.ok(
    payloads.some(
      (payload) =>
        payload.subtype === "stopped" && /restart reconciliation/.test(String(payload.stoppedBy)),
    ),
    "the stop marker names the daemon as the stopper",
  );
  assert.ok(
    listWorkerAttentionItems(db, outcome.workerId).some(
      (item) => item.kind === "unstructured_completion",
    ),
    "an orphan without a digest is not rendered done",
  );
});

test("boot re-attach: a live orphan resumes in place — same row, same lane, zero failure evidence", async () => {
  const { db, config, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");
  const eventsBefore = listWorkerEvents(db, outcome.workerId).length;

  // Confidence snapshot before the "crash" — the acceptance bar is that a
  // restart moves this not one point. Fixed clock so staleness cannot drift.
  const now = new Date();
  const workerBefore = getWorker(db, outcome.workerId);
  assert.ok(workerBefore);
  const laneBefore = getLane(db, workerBefore.lane_id) ?? null;
  const reportBefore = scoreWorker(
    (await buildWorkerEvidence(db, { worker: workerBefore, lane: laneBefore, staleWorkerSeconds: 900, now })).input,
  );

  const restarted = restartedRuntime(db, config);
  const counts = await restarted.runtime.reconcileOrphans();
  assert.deepEqual(counts, { reattached: 1, finalized: 0 });

  const input = restarted.spawnInputs[0];
  assert.ok(input, "a session was spawned for the orphan");
  assert.equal(input.resume, "sdk-w1", "resumed by the persisted session id");
  assert.equal(input.worktreePath, outcome.worktreePath, "resume is cwd-keyed to the SAME worktree");
  assert.match(input.briefText, /continue from your current step/i);
  assert.match(input.briefText, /Do not emit a new galapagos-plan/);

  assert.equal(listWorkers(db, project.id).length, 1, "no new worker row");
  const worker = getWorker(db, outcome.workerId);
  assert.equal(worker?.status, "running", "status survives the restart");
  assert.equal(worker?.sdk_session_id, "sdk-w1");
  assert.equal(listActiveLanes(db, project.id).length, 1, "lane never retired");
  assert.equal(listWorkerAttentionItems(db, outcome.workerId).length, 0, "zero attention");
  const newEvents = listWorkerEvents(db, outcome.workerId).slice(eventsBefore);
  assert.equal(newEvents.length, 1, "exactly one restart notice, nothing else");
  assert.equal(newEvents[0]?.kind, "steer", "the notice is neutral, not an error");
  const noticePayload = JSON.parse(newEvents[0]?.payload ?? "{}") as Record<string, unknown>;
  assert.equal(noticePayload.reattached, true);

  // The resumed session confirms the SAME id: nothing is clobbered.
  restarted.sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(getWorker(db, outcome.workerId)?.status, "running", "init never flips a resumed status");

  const workerAfter = getWorker(db, outcome.workerId);
  assert.ok(workerAfter);
  const reportAfter = scoreWorker(
    (await buildWorkerEvidence(db, { worker: workerAfter, lane: getLane(db, workerAfter.lane_id) ?? null, staleWorkerSeconds: 900, now })).input,
  );
  assert.deepEqual(reportAfter, reportBefore, "a restart feeds ZERO evidence into confidence");

  // And the re-attached worker is a first-class live worker: steerable.
  const steered = await restarted.runtime.steer(outcome.workerId, "carry on");
  assert.ok(steered.ok);
  assert.ok(restarted.sessions[0]?.sent.includes("carry on"), "steer reaches the resumed session");
});

test("boot re-attach preserves awaiting_input and tells the worker to restate its question", async () => {
  const { db, config, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  const fake = sessions[0];
  assert.ok(fake);
  fake.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");
  // A turn ending without a completion block = the worker is waiting on its manager.
  fake.emit({
    kind: "result",
    payload: { subtype: "success", isError: false, resultText: "Which auth flow should I target?" },
  });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "awaiting_input", "awaiting_input");

  const restarted = restartedRuntime(db, config);
  const counts = await restarted.runtime.reconcileOrphans();
  assert.deepEqual(counts, { reattached: 1, finalized: 0 });
  assert.match(restarted.spawnInputs[0]?.briefText ?? "", /restate your question/i);

  restarted.sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    getWorker(db, outcome.workerId)?.status,
    "awaiting_input",
    "init never clobbers a waiting worker to running",
  );
});

test("boot re-attach keeps a held worker held — the nudge never releases a hold", async () => {
  const { db, config, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  const fake = sessions[0];
  assert.ok(fake);
  fake.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");

  const pending = runtime.hold(outcome.workerId, "the lane guard");
  await waitFor(() => fake.sent.some((text) => text.startsWith("HOLD")), "hold delivered");
  fake.emit({
    kind: "result",
    payload: { subtype: "error_during_execution", isError: true, resultText: null },
  });
  fake.emit({ kind: "assistant", payload: { text: "Paused mid-edit; awaiting instructions." } });
  const held = await pending;
  assert.ok(held.ok);

  const restarted = restartedRuntime(db, config);
  const counts = await restarted.runtime.reconcileOrphans();
  assert.deepEqual(counts, { reattached: 1, finalized: 0 });
  const nudge = restarted.spawnInputs[0]?.briefText ?? "";
  assert.match(nudge, /still ON HOLD/);
  assert.doesNotMatch(nudge, /continue from your current step/i, "a held worker is never told to continue");
});

test("a released hold re-attaches with the ordinary continue nudge", async () => {
  const { db, config, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  const fake = sessions[0];
  assert.ok(fake);
  fake.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");
  const pending = runtime.hold(outcome.workerId, "triage");
  await waitFor(() => fake.sent.some((text) => text.startsWith("HOLD")), "hold delivered");
  fake.emit({
    kind: "result",
    payload: { subtype: "error_during_execution", isError: true, resultText: null },
  });
  fake.emit({ kind: "assistant", payload: { text: "Paused." } });
  await pending;
  // The release is an ordinary steer — the newest steer no longer carries hold.
  const released = await runtime.steer(outcome.workerId, "Continue where you paused.");
  assert.ok(released.ok);

  const restarted = restartedRuntime(db, config);
  await restarted.runtime.reconcileOrphans();
  assert.match(restarted.spawnInputs[0]?.briefText ?? "", /continue from your current step/i);
});

test("a resume that comes back blank falls back to the honest finalize — stopped, never failed", async () => {
  const { db, config, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");

  const restarted = restartedRuntime(db, config);
  const counts = await restarted.runtime.reconcileOrphans();
  assert.deepEqual(counts, { reattached: 1, finalized: 0 });

  // The SDK silently started a blank session under a different id.
  restarted.sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-blank" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "stopped", "fallback finalize");

  const worker = getWorker(db, outcome.workerId);
  assert.equal(worker?.sdk_session_id, "sdk-w1", "the real transcript's id is never overwritten");
  assert.equal(listActiveLanes(db, project.id).length, 0, "lane retired by the fallback");
  const payloads = listWorkerEvents(db, outcome.workerId).map(
    (event) => JSON.parse(event.payload) as Record<string, unknown>,
  );
  assert.ok(
    payloads.some((payload) => /came back blank/.test(String(payload.message ?? ""))),
    "the mismatch is recorded honestly",
  );
  assert.ok(
    payloads.some(
      (payload) =>
        payload.subtype === "stopped" && /re-attach failed/.test(String(payload.stoppedBy)),
    ),
    "the stop marker names the failed re-attach",
  );
  assert.ok(
    !listWorkerAttentionItems(db, outcome.workerId).some((item) => item.kind === "worker_failed"),
    "a platform failure is never pinned on the worker",
  );
});

test("an orphan that already reported completion is finalized, not re-attached", async () => {
  const { db, config, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  const fake = sessions[0];
  assert.ok(fake);
  fake.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");
  fake.emit({
    kind: "result",
    payload: { subtype: "success", isError: false, resultText: VALID_COMPLETION },
  });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "idle", "idle with digest");

  const restarted = restartedRuntime(db, config);
  const counts = await restarted.runtime.reconcileOrphans();
  assert.deepEqual(counts, { reattached: 0, finalized: 1 });
  assert.equal(restarted.spawnInputs.length, 0);
  assert.equal(getWorker(db, outcome.workerId)?.status, "stopped");
  assert.ok(
    !listWorkerAttentionItems(db, outcome.workerId).some(
      (item) => item.kind === "unstructured_completion",
    ),
    "a digest-carrying orphan is not flagged as unfinished",
  );
});

test("a still-spawning orphan (no session id yet) keeps the legacy finalize", async () => {
  const { db, config, project, runtime } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  // No session_started ever arrived: status is spawning, sdk_session_id null.
  assert.equal(getWorker(db, outcome.workerId)?.status, "spawning");

  const restarted = restartedRuntime(db, config);
  const counts = await restarted.runtime.reconcileOrphans();
  assert.deepEqual(counts, { reattached: 0, finalized: 1 });
  assert.equal(restarted.spawnInputs.length, 0);
  assert.equal(getWorker(db, outcome.workerId)?.status, "stopped");
});

test("a crash-window orphan whose lane is already retired is finalized, never re-attached", async () => {
  const { db, config, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");

  // A daemon death inside finalizeStop's retire→status window leaves exactly
  // this: a live-status row whose lane is retired. Re-attaching it would run
  // with the lane guard silently disabled.
  const worker = getWorker(db, outcome.workerId);
  assert.ok(worker);
  retireLane(db, worker.lane_id);

  const restarted = restartedRuntime(db, config);
  const counts = await restarted.runtime.reconcileOrphans();
  assert.deepEqual(counts, { reattached: 0, finalized: 1 });
  assert.equal(restarted.spawnInputs.length, 0);
  assert.equal(getWorker(db, outcome.workerId)?.status, "stopped");
});

test("a stop persists an honest stopped-by marker, not an execution error", async () => {
  const { db, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  const fake = sessions[0];
  assert.ok(fake);
  fake.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");

  // Interrupts can surface as an error RESULT mid-stop — it must not be
  // persisted as one.
  const originalStop = fake.session.stop.bind(fake.session);
  fake.session.stop = async () => {
    fake.emit({
      kind: "result",
      payload: { subtype: "error_during_execution", isError: true, resultText: null },
    });
    await originalStop();
  };
  const stopped = await runtime.stop(outcome.workerId, "the user, via the workers page");
  assert.ok(stopped.ok);

  const events = listWorkerEvents(db, outcome.workerId).map(
    (event) => JSON.parse(event.payload) as Record<string, unknown>,
  );
  assert.ok(
    !events.some((payload) => payload.subtype === "error_during_execution"),
    "the interrupt-induced error result is not persisted on a requested stop",
  );
  const marker = events.find((payload) => payload.subtype === "stopped");
  assert.ok(marker, "a stopped marker event exists");
  assert.equal(marker?.stoppedBy, "the user, via the workers page");
  assert.equal(marker?.isError, false);
});

test("reusing a retired lane's name is a clean rejection, never a failed worker row", async () => {
  const { db, project, runtime, sessions } = await fixture();
  const first = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(first.ok);
  if (!first.ok) {
    return;
  }
  sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await runtime.stop(first.workerId, "Darwin");

  const again = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.equal(again.ok, false);
  if (!again.ok) {
    assert.match(again.reason, /Pick a NEW lane name/);
    assert.match(again.reason, /resume_worker/);
  }
  assert.equal(runtime.list(project.id).length, 1, "no failed worker row was created");
});

test("resume_worker continues stopped work: same worktree, lane re-activated, honest brief", async () => {
  const { db, project, runtime, sessions, spawnInputs } = await fixture();
  const first = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(first.ok);
  if (!first.ok) {
    return;
  }
  sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, first.workerId)?.status === "running", "running");

  // Live workers cannot be resumed.
  const whileLive = await runtime.resume({ project, workerId: first.workerId });
  assert.equal(whileLive.ok, false);

  // The predecessor did some work, then was stopped.
  writeFileSync(path.join(first.worktreePath, "src", "auth", "login.ts"), "// progress\n");
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-am", "half done"],
    { cwd: first.worktreePath },
  );
  await runtime.stop(first.workerId, "the user, via the workers page");
  assert.equal(listActiveLanes(db, project.id).length, 0);

  const resumed = await runtime.resume({
    project,
    workerId: first.workerId,
    note: "Also validate the email field.",
  });
  assert.ok(resumed.ok, JSON.stringify(resumed));
  if (!resumed.ok) {
    return;
  }
  assert.notEqual(resumed.workerId, first.workerId, "a fresh worker row");
  assert.equal(resumed.worktreePath, first.worktreePath, "the SAME worktree");
  assert.equal(resumed.branch, first.branch);
  assert.equal(listActiveLanes(db, project.id).length, 1, "lane re-activated");
  assert.equal(getWorker(db, resumed.workerId)?.resumed_from, first.workerId);

  const resumeBrief = spawnInputs.at(-1)?.briefText ?? "";
  assert.match(resumeBrief, /CONTINUATION/);
  assert.match(resumeBrief, /Harden the login form/, "original brief title included");
  assert.match(resumeBrief, /half done/, "the worktree's real commits included");
  assert.match(resumeBrief, /Also validate the email field/, "the manager's note included");

  // The resumed worker is live and steerable; exclusivity still holds.
  const overlapping = await runtime.spawn({
    project,
    laneName: "auth rewrite",
    allowedGlobs: ["src/auth/**"],
    briefTitle: "t",
    brief: "b",
  });
  assert.equal(overlapping.ok, false);
});

test("resume is refused when a now-active lane overlaps the retired one", async () => {
  const { db, project, runtime, sessions } = await fixture();
  const first = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(first.ok);
  if (!first.ok) {
    return;
  }
  sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await runtime.stop(first.workerId, "Darwin");

  const successor = await runtime.spawn({
    project,
    laneName: "auth take two",
    allowedGlobs: ["src/auth/**"],
    briefTitle: "t",
    brief: "b",
  });
  assert.ok(successor.ok, "same globs are legal once the old lane retired");

  const resumed = await runtime.resume({ project, workerId: first.workerId });
  assert.equal(resumed.ok, false);
  if (!resumed.ok) {
    assert.match(resumed.reason, /overlaps/);
    assert.match(resumed.reason, /auth take two/);
  }
  assert.equal(getWorker(db, first.workerId)?.status, "stopped", "predecessor untouched");
});

test("steer with acknowledgment returns the worker's next reply, or null on timeout", async () => {
  const { db, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  const fake = sessions[0];
  assert.ok(fake);
  fake.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");

  const pending = runtime.steer(outcome.workerId, "How is it going?", {
    awaitResponse: true,
    timeoutMs: 2_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  fake.emit({ kind: "assistant", payload: { text: "Halfway — validation logic remains." } });
  const acked = await pending;
  assert.ok(acked.ok);
  if (acked.ok) {
    assert.equal(acked.response, "Halfway — validation logic remains.");
  }

  const timedOut = await runtime.steer(outcome.workerId, "Anything else?", {
    awaitResponse: true,
    timeoutMs: 40,
  });
  assert.ok(timedOut.ok);
  if (timedOut.ok) {
    assert.equal(timedOut.response, null, "honest null when the worker stays silent");
  }
});

test("hold sends the pause instruction and reports the worker's position", async () => {
  const { db, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  const fake = sessions[0];
  assert.ok(fake);
  fake.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");

  const pending = runtime.hold(outcome.workerId, "the user, via the workers page");
  await waitFor(() => fake.sent.some((text) => text.startsWith("HOLD")), "hold delivered");
  // Holding a RUNNING worker preempts its turn: the aborted turn's error
  // result is the debris that clears the brake, and only the pause ack that
  // follows it drains the waiter (see the dedicated preempt test below).
  fake.emit({
    kind: "result",
    payload: { subtype: "error_during_execution", isError: true, resultText: null },
  });
  fake.emit({ kind: "assistant", payload: { text: "Paused after the form markup; tests remain." } });
  const held = await pending;
  assert.ok(held.ok);
  if (held.ok) {
    assert.equal(held.response, "Paused after the form markup; tests remain.");
  }
  const holdEvent = listWorkerEvents(db, outcome.workerId)
    .map((event) => JSON.parse(event.payload) as Record<string, unknown>)
    .find((payload) => payload.hold === true);
  assert.ok(holdEvent, "the hold is a visible steer event");
  assert.equal(holdEvent?.heldBy, "the user, via the workers page");

  const deadHold = await runtime.hold("nope", "Darwin");
  assert.equal(deadHold.ok, false);
});

test("hold → steer resumes the SAME session: no new worker, no new SDK session, full context (2026-07-10 ruling)", async () => {
  const { db, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  const fake = sessions[0];
  assert.ok(fake);
  fake.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");

  const pending = runtime.hold(outcome.workerId, "triage");
  await waitFor(() => fake.sent.some((text) => text.startsWith("HOLD")), "hold delivered");
  fake.emit({
    kind: "result",
    payload: { subtype: "error_during_execution", isError: true, resultText: null },
  });
  fake.emit({ kind: "assistant", payload: { text: "Paused mid-refactor; two files remain." } });
  const held = await pending;
  assert.ok(held.ok);

  // Release: an ordinary steer lands in the SAME live session object — the
  // whole point of hold over stop. No spawn, no fresh brief, no re-plan.
  const released = await runtime.steer(outcome.workerId, "Continue where you paused.");
  assert.ok(released.ok);
  assert.ok(
    fake.sent.includes("Continue where you paused."),
    "the release reached the very session that was held",
  );
  assert.equal(sessions.length, 1, "no second session was ever spawned");
  assert.equal(getWorker(db, outcome.workerId)?.status, "running");
  assert.equal(getWorker(db, outcome.workerId)?.sdk_session_id, "sdk-w1");
});

test("hold preempts a busy worker: turn aborted, debris suppressed, ack is the pause reply", async () => {
  const { db, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  const fake = sessions[0];
  assert.ok(fake);
  fake.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");

  const pending = runtime.hold(outcome.workerId, "the user, via the workers page");
  await waitFor(() => fake.sent.some((text) => text.startsWith("HOLD")), "hold delivered");
  assert.equal(fake.interruptCount(), 1, "a busy worker is braked, not queued behind");

  // The dying turn's tail narration must never read as the hold ack.
  fake.emit({ kind: "assistant", payload: { text: "Now wiring Venus end to end." } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  // The aborted turn's debris: an error RESULT — expected, not a failure.
  fake.emit({
    kind: "result",
    payload: { subtype: "error_during_execution", isError: true, resultText: null },
  });
  fake.emit({ kind: "assistant", payload: { text: "Paused. At step 3 of 5; commits clean." } });

  const held = await pending;
  assert.ok(held.ok);
  if (held.ok) {
    assert.equal(held.response, "Paused. At step 3 of 5; commits clean.");
  }
  assert.notEqual(getWorker(db, outcome.workerId)?.status, "failed", "a hold is never a failure");
  const persistedResults = listWorkerEvents(db, outcome.workerId)
    .filter((event) => event.kind === "result")
    .map((event) => JSON.parse(event.payload) as { isError?: boolean });
  assert.ok(
    persistedResults.every((payload) => payload.isError !== true),
    "the preempted turn's error result is debris, never persisted",
  );
});

test("hold on a worker idle between turns does not interrupt anything", async () => {
  const { db, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  const fake = sessions[0];
  assert.ok(fake);
  fake.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  // A block-less turn end parks the worker awaiting its manager.
  fake.emit({
    kind: "result",
    payload: { subtype: "success", isError: false, resultText: "Which color scheme?" },
  });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "awaiting_input", "parked");

  const pending = runtime.hold(outcome.workerId, "Darwin");
  await waitFor(() => fake.sent.some((text) => text.startsWith("HOLD")), "hold delivered");
  assert.equal(fake.interruptCount(), 0, "nothing in flight — nothing to brake");
  fake.emit({ kind: "assistant", payload: { text: "Still parked; nothing started." } });
  const held = await pending;
  assert.ok(held.ok);
  if (held.ok) {
    assert.equal(held.response, "Still parked; nothing started.");
  }
});

test("a user-approved lane amendment widens the live contract, the row, and the record", async () => {
  const { db, project, runtime, sessions, spawnInputs } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  const fake = sessions[0];
  assert.ok(fake);
  fake.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");

  // Before: the live contract (what canUseTool consults) rejects the file.
  const liveContract = spawnInputs[0]?.lane;
  assert.ok(liveContract);
  assert.deepEqual(liveContract.allowedGlobs, ["src/auth/**"]);

  const amended = await runtime.applyLaneAmendment({
    project,
    workerId: outcome.workerId,
    addGlobs: ["src/nav/**"],
    reason: "the login page needs a nav link",
    approvedBy: "the user (in chat)",
  });
  assert.ok(amended.ok, JSON.stringify(amended));
  if (!amended.ok) {
    return;
  }
  assert.deepEqual(amended.allowedGlobs, ["src/auth/**", "src/nav/**"]);
  assert.deepEqual(
    liveContract.allowedGlobs,
    ["src/auth/**", "src/nav/**"],
    "the SAME object the session's canUseTool closes over is widened",
  );
  const laneRow = runtime.list(project.id)[0]?.lane;
  assert.deepEqual(JSON.parse(laneRow?.allowed_globs ?? "[]"), ["src/auth/**", "src/nav/**"]);
  assert.ok(
    fake.sent.some((text) => text.startsWith("LANE AMENDED")),
    "the worker is told",
  );
  const briefFile = readdirSync(path.join(project.root_path, "docs", "galapagos", "briefs"))[0];
  const briefBody = readFileSync(
    path.join(project.root_path, "docs", "galapagos", "briefs", briefFile ?? ""),
    "utf8",
  );
  assert.match(briefBody, /Lane amended \(approved by the user \(in chat\)\)/);

  // The widened lane still cannot swallow another active lane's territory.
  const second = await runtime.spawn({
    project,
    laneName: "docs lane",
    allowedGlobs: ["docs/notes/**"],
    briefTitle: "t",
    brief: "b",
  });
  assert.ok(second.ok);
  const overlapping = await runtime.applyLaneAmendment({
    project,
    workerId: outcome.workerId,
    addGlobs: ["docs/**"],
    reason: "grab everything",
    approvedBy: "the user (in chat)",
  });
  assert.equal(overlapping.ok, false);
  if (!overlapping.ok) {
    assert.match(overlapping.reason, /docs lane/);
  }
});

test("repeated tool denials raise a single loud attention item at the threshold", async () => {
  const { db, project, runtime, sessions, spawnInputs } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  assert.ok(sessions[0]);
  const onDeny = spawnInputs[0]?.onToolDenied;
  assert.ok(onDeny, "the runtime wires the denial counter into the session");

  onDeny("WebSearch");
  onDeny("WebSearch");
  assert.equal(
    listWorkerAttentionItems(db, outcome.workerId).filter((item) => item.kind === "tool_denied").length,
    0,
    "below the threshold, denials stay quiet",
  );
  onDeny("WebSearch");
  onDeny("WebSearch");
  const items = listWorkerAttentionItems(db, outcome.workerId).filter(
    (item) => item.kind === "tool_denied",
  );
  assert.equal(items.length, 1, "one item at the threshold, not one per denial");
  assert.match(items[0]?.title ?? "", /WebSearch/);
});

test("collectAuditFiles unions committed diff with porcelain, handling renames", async () => {
  const repo = fixtureRepo();
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Galapagos Tests", "-c", "user.email=tests@galapagos.local", ...args],
      { cwd: repo, encoding: "utf8" },
    );
  const baseSha = git(["rev-parse", "HEAD"]).trim();

  writeFileSync(path.join(repo, "committed.ts"), "committed\n");
  git(["add", "committed.ts"]);
  git(["commit", "-m", "add committed file"]);
  git(["mv", "README.md", "RENAMED.md"]);
  writeFileSync(path.join(repo, "dirty.ts"), "dirty\n");
  // A brand-new directory must surface as its FILES, not a collapsed "dir/"
  // entry that globs can neither honestly clear nor blame.
  mkdirSync(path.join(repo, "newdir", "deep"), { recursive: true });
  writeFileSync(path.join(repo, "newdir", "deep", "fresh.ts"), "fresh\n");
  // Non-ASCII paths must reach the globs verbatim — git's default C-style
  // quoting would render this as "caf\\303\\251.ts", which no glob matches.
  writeFileSync(path.join(repo, "café.ts"), "accent\n");

  const files = await collectAuditFiles(repo, baseSha);
  assert.deepEqual(files.sort(), [
    "RENAMED.md",
    "café.ts",
    "committed.ts",
    "dirty.ts",
    "newdir/deep/fresh.ts",
  ]);
});

test("collectAuditFiles excludes build/dependency output even when the repo did not .gitignore it", async () => {
  const repo = fixtureRepo();
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Galapagos Tests", "-c", "user.email=tests@galapagos.local", ...args],
      { cwd: repo, encoding: "utf8" },
    );
  const baseSha = git(["rev-parse", "HEAD"]).trim();

  // A worker that ran `npm install` / a build leaves these UNtracked and, in a
  // repo that forgot to .gitignore them, they would otherwise flood the audit.
  mkdirSync(path.join(repo, "node_modules", "@babel", "core", "lib"), { recursive: true });
  writeFileSync(path.join(repo, "node_modules", "@babel", "core", "lib", "index.js"), "x\n");
  mkdirSync(path.join(repo, "dist", "bodies"), { recursive: true });
  writeFileSync(path.join(repo, "dist", "index.html"), "x\n");
  writeFileSync(path.join(repo, "dist", "bodies", "earth.jpg"), "x\n");
  // A nested workspace copy (monorepo) must be excluded by segment too.
  mkdirSync(path.join(repo, "packages", "app", "node_modules"), { recursive: true });
  writeFileSync(path.join(repo, "packages", "app", "node_modules", "dep.js"), "x\n");
  // The one genuine out-of-lane change must still surface.
  writeFileSync(path.join(repo, "stray.ts"), "real work\n");

  const files = await collectAuditFiles(repo, baseSha);
  assert.deepEqual(files.sort(), ["stray.ts"]);
});

test("a galapagos-plan block in an assistant message becomes the checklist and broadcasts worker_plan", async () => {
  const { db, project, runtime, sessions, broadcasts } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });

  const plan = JSON.stringify({
    goal: "Harden the login form",
    steps: [{ title: "Add validation", detail: "empty + invalid" }, { title: "Unit tests" }],
  });
  sessions[0]?.emit({
    kind: "assistant",
    payload: { text: "Here is my plan.\n```galapagos-plan\n" + plan + "\n```" },
  });
  await waitFor(
    () => listWorkerSteps(db, outcome.workerId).length === 2,
    "plan steps persisted",
  );
  const steps = listWorkerSteps(db, outcome.workerId);
  assert.deepEqual(
    steps.map((s) => ({ ordinal: s.ordinal, title: s.title, status: s.status })),
    [
      { ordinal: 1, title: "Add validation", status: "planned" },
      { ordinal: 2, title: "Unit tests", status: "planned" },
    ],
  );
  assert.equal(steps[0]?.detail, "empty + invalid");
  assert.equal(
    broadcasts.filter((b) => b.type === "worker_plan").length,
    1,
    "one worker_plan broadcast for the plan",
  );
});

test("step updates advance the checklist with the exactly-one-active invariant", async () => {
  const { db, project, runtime, sessions, broadcasts } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  const plan = JSON.stringify({
    goal: "g",
    steps: [{ title: "one" }, { title: "two" }, { title: "three" }],
  });
  sessions[0]?.emit({
    kind: "assistant",
    payload: { text: "```galapagos-plan\n" + plan + "\n```" },
  });
  await waitFor(() => listWorkerSteps(db, outcome.workerId).length === 3, "plan persisted");

  // Start step 1, then in one message finish it and start step 2.
  sessions[0]?.emit({
    kind: "assistant",
    payload: { text: '```galapagos-step\n{ "step": 1, "status": "active" }\n```' },
  });
  await waitFor(
    () => listWorkerSteps(db, outcome.workerId)[0]?.status === "active",
    "step 1 active",
  );
  sessions[0]?.emit({
    kind: "assistant",
    payload: {
      text:
        'Done with one.\n```galapagos-step\n{ "step": 1, "status": "done" }\n```\n' +
        '```galapagos-step\n{ "step": 2, "status": "active" }\n```',
    },
  });
  await waitFor(
    () => listWorkerSteps(db, outcome.workerId)[1]?.status === "active",
    "step 2 active",
  );
  const statuses = listWorkerSteps(db, outcome.workerId).map((s) => s.status);
  assert.deepEqual(statuses, ["done", "active", "planned"]);
  assert.ok(
    broadcasts.filter((b) => b.type === "worker_plan").length >= 3,
    "each checklist move broadcasts",
  );

  // Activating step 3 demotes nothing done: 1 stays done, 2 -> planned.
  sessions[0]?.emit({
    kind: "assistant",
    payload: { text: '```galapagos-step\n{ "step": 3, "status": "active" }\n```' },
  });
  await waitFor(
    () => listWorkerSteps(db, outcome.workerId)[2]?.status === "active",
    "step 3 active",
  );
  assert.deepEqual(
    listWorkerSteps(db, outcome.workerId).map((s) => s.status),
    ["done", "planned", "active"],
  );
});

test("a re-plan replaces the checklist but preserves done steps by title; malformed blocks raise nothing", async () => {
  const { db, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  const first = JSON.stringify({ goal: "g", steps: [{ title: "keep" }, { title: "drop" }] });
  sessions[0]?.emit({
    kind: "assistant",
    payload: { text: "```galapagos-plan\n" + first + "\n```" },
  });
  await waitFor(() => listWorkerSteps(db, outcome.workerId).length === 2, "first plan");
  sessions[0]?.emit({
    kind: "assistant",
    payload: { text: '```galapagos-step\n{ "step": 1, "status": "done" }\n```' },
  });
  await waitFor(
    () => listWorkerSteps(db, outcome.workerId)[0]?.status === "done",
    "step 'keep' done",
  );

  // Malformed plan block: tolerated silently — no attention item, checklist untouched.
  sessions[0]?.emit({
    kind: "assistant",
    payload: { text: "```galapagos-plan\n{ goal: broken\n```" },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(listWorkerSteps(db, outcome.workerId).length, 2, "checklist untouched");
  assert.equal(
    listWorkerAttentionItems(db, outcome.workerId).length,
    0,
    "a botched plan block is not an attention item",
  );

  // Re-plan: 'keep' survives as done, 'drop' is gone, new steps are planned.
  const second = JSON.stringify({
    goal: "g",
    steps: [{ title: "keep" }, { title: "new step" }],
  });
  sessions[0]?.emit({
    kind: "assistant",
    payload: { text: "Re-planning after steer.\n```galapagos-plan\n" + second + "\n```" },
  });
  await waitFor(
    () => listWorkerSteps(db, outcome.workerId).some((s) => s.title === "new step"),
    "re-plan applied",
  );
  assert.deepEqual(
    listWorkerSteps(db, outcome.workerId).map((s) => ({ title: s.title, status: s.status })),
    [
      { title: "keep", status: "done" },
      { title: "new step", status: "planned" },
    ],
  );
});
