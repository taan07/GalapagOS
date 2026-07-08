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
import { getLane, listActiveLanes } from "../src/adapters/db/repos/lanes";
import { getWorker, listWorkerEvents } from "../src/adapters/db/repos/workers";
import { latestDigestForWorker } from "../src/adapters/db/repos/digests";
import { listWorkerAttentionItems } from "../src/adapters/db/repos/attention";
import {
  collectAuditFiles,
  createWorkerRuntime,
  type WorkerRuntime,
} from "../src/adapters/agent/worker-runtime";
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
    async stop() {
      ended = true;
      notify();
    },
  };
  return {
    session,
    sent,
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
};

async function fixture(): Promise<Fixture> {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-rt-state-"));
  const config = loadConfig({ ...process.env, GALAPAGOS_STATE_DIR: stateDir });
  const db = openDb(stateDir);
  const project = await registerProject(db, { rootPath: fixtureRepo() });
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
  return { db, config, project, runtime, sessions, spawnInputs };
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

test("reconcileOrphans finalizes live-status workers after a daemon restart", async () => {
  const { db, config, project, runtime, sessions } = await fixture();
  const outcome = await runtime.spawn({ project, ...SPAWN_INPUT });
  assert.ok(outcome.ok);
  if (!outcome.ok) {
    return;
  }
  sessions[0]?.emit({ kind: "session_started", sdkSessionId: "sdk-w1" });
  await waitFor(() => getWorker(db, outcome.workerId)?.status === "running", "running");

  // A new runtime over the same db = the restarted daemon (empty live map).
  const restarted = createWorkerRuntime({ db, config });
  const count = await restarted.reconcileOrphans();
  assert.equal(count, 1);

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
