// Triage plumbing that carries judgment: the seed message a triage session
// wakes to, and the ask_user bridge that lands a question in the user's
// chat plus the attention queue. The SDK session itself is exercised live —
// these prove the batch is assembled honestly.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/adapters/db/db";
import { loadConfig } from "../src/config";
import { registerProject } from "../src/adapters/db/repos/projects";
import {
  createAttentionItem,
  listOpenAttentionItems,
} from "../src/adapters/db/repos/attention";
import { createCompletionDigest, listUnreviewedDigests } from "../src/adapters/db/repos/digests";
import { getOrCreateActiveSession, listTurns } from "../src/adapters/db/repos/manager";
import { createWorkerRuntime } from "../src/adapters/agent/worker-runtime";
import type { WorkerSession } from "../src/adapters/agent/worker-session";
import { buildTriageSeed, createAskUserBridge } from "../src/adapters/agent/triage";

function fixtureRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glp-triage-repo-"));
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
    async stop() {},
  };
}

async function fixture() {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-triage-state-"));
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
  return { db, config, project, runtime, workerId: spawned.workerId };
}

test("buildTriageSeed carries the batch, worker confidence, and claim-vs-evidence links", async () => {
  const { db, config, project, runtime, workerId } = await fixture();
  const item = createAttentionItem(db, {
    projectId: project.id,
    workerId,
    kind: "stale_worker",
    title: 'Worker "auth ui" has gone quiet',
    detail: "No messages for 900s while running (threshold 300s).",
    priority: "high",
  });
  createCompletionDigest(db, {
    workerId,
    narrative: "Login form validates input.",
    beforeAfter: [],
    claims: [{ text: "full suite passes", evidence_kind: "test", files: [] }],
    touchedAreas: [],
  });

  const seed = await buildTriageSeed(db, {
    config,
    project,
    workers: runtime,
    items: listOpenAttentionItems(db, project.id),
    digests: listUnreviewedDigests(db, project.id),
  });

  assert.match(seed, new RegExp(`id ${item.id} \\[high\\] stale_worker`));
  assert.match(seed, /No messages for 900s/);
  // The worker roster carries evidence-based confidence, not vibes.
  assert.match(seed, new RegExp(`${workerId} lane "auth ui"`));
  assert.match(seed, /confidence \d+\/(strong|steady|draining|blocked)/);
  // The unreviewed completion shows HOW each claim resolved.
  assert.match(seed, /Login form validates input\./);
  assert.match(seed, /\[unsupported\] "full suite passes"/);
  assert.match(seed, /No test run exists/);
});

test("createAskUserBridge lands the question in chat AND on the queue, and broadcasts", async () => {
  const { db, project } = await fixture();
  const events: unknown[] = [];
  const bridge = createAskUserBridge({
    db,
    project,
    broadcast: (event) => events.push(event),
  });

  const { attentionId } = bridge(
    "Stripe or PromptPay first?",
    "The payments worker is blocked on this. Recommendation: PromptPay — it was the launch-market answer in the records.",
  );

  const items = listOpenAttentionItems(db, project.id);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, attentionId);
  assert.equal(items[0]?.kind, "question_for_user");
  assert.equal(items[0]?.priority, "high");
  assert.match(items[0]?.detail ?? "", /Recommendation: PromptPay/);

  // The chat surface: a system note turn in Darwin's active session.
  const session = getOrCreateActiveSession(db, project.id);
  const turns = listTurns(db, session.id);
  const note = turns.find((turn) => turn.role === "system");
  assert.ok(note);
  const payload = JSON.parse(note.content) as { kind: string; text: string };
  assert.equal(payload.kind, "note");
  assert.match(payload.text, /Stripe or PromptPay first\?/);
  assert.match(payload.text, new RegExp(attentionId));

  assert.ok(events.some((event) => (event as { type: string }).type === "manager_note"));
  assert.ok(events.some((event) => (event as { type: string }).type === "attention_changed"));
});
