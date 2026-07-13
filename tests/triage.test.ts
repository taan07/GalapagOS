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
import {
  buildTriageSeed,
  createAskUserBridge,
  TRIAGE_ALLOWED_TOOLS,
} from "../src/adapters/agent/triage";
import { createDecisionBroker } from "../src/adapters/agent/decisions";

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
    async interrupt() {},
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

test("createAskUserBridge without a broker keeps the legacy note path", async () => {
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

test("with a broker, an escalation is a REAL pending card — persisted, broadcast, never awaited", async () => {
  const { db, project } = await fixture();
  const events: { type: string; [key: string]: unknown }[] = [];
  const answers: { question: string; outcomeText: string; attentionId: string }[] = [];
  const decisions = createDecisionBroker();
  const bridge = createAskUserBridge({
    db,
    project,
    decisions,
    broadcast: (event) => events.push(event as { type: string }),
    onAnswered: (answer) => answers.push(answer),
  });

  const { attentionId } = bridge(
    "Stripe or PromptPay first?",
    "Recommendation: PromptPay.",
    [
      { label: "PromptPay", implication: "Launch-market default — e.g. TH QR checkout day one." },
      { label: "Stripe", implication: "Cards first — e.g. international buyers before local." },
    ],
    false,
  );

  // The durable half is unchanged: the queue records the question.
  const items = listOpenAttentionItems(db, project.id);
  assert.equal(items[0]?.id, attentionId);

  // The chat surface: a PENDING decision turn, byte-compatible with live
  // cards (reload rendering + the boot sweep both key on this shape).
  const session = getOrCreateActiveSession(db, project.id);
  const cardTurn = listTurns(db, session.id).find((turn) => turn.role === "system");
  assert.ok(cardTurn);
  const payload = JSON.parse(cardTurn.content) as Record<string, unknown>;
  assert.equal(payload.kind, "decision");
  assert.equal(payload.status, "pending");
  assert.match(String(payload.question), /Stripe or PromptPay first\?/);
  assert.equal((payload.options as unknown[]).length, 2);

  // The broadcast: a decision_request with the card's decisionId, plus the
  // queue ping — and NO dead manager_note.
  const request = events.find((event) => event.type === "decision_request");
  assert.ok(request);
  assert.equal(request.decisionId, payload.decisionId);
  assert.ok(events.some((event) => event.type === "attention_changed"));
  assert.ok(!events.some((event) => event.type === "manager_note"));
  assert.equal(answers.length, 0, "the bridge never waits");

  // The user answers: the turn stamps settled, decision_settled broadcasts,
  // the attention item resolves, and the answer callback fires for the wake.
  const answered = decisions.answer(String(payload.decisionId), {
    selections: ["PromptPay"],
    responses: {},
    custom: "",
  });
  assert.ok(answered);
  await new Promise((resolve) => setImmediate(resolve));

  const settled = JSON.parse(
    listTurns(db, session.id).find((turn) => turn.id === cardTurn.id)?.content ?? "{}",
  ) as Record<string, unknown>;
  assert.equal(settled.status, "answered");
  assert.deepEqual(settled.selections, ["PromptPay"]);
  assert.ok(events.some((event) => event.type === "decision_settled"));
  assert.equal(listOpenAttentionItems(db, project.id).length, 0, "answered = resolved");
  assert.equal(answers.length, 1);
  assert.match(answers[0]?.outcomeText ?? "", /PromptPay/);
  assert.equal(answers[0]?.attentionId, attentionId);
});

test("a timed-out card stamps honestly and leaves the attention item OPEN", async () => {
  const { db, project } = await fixture();
  const answers: unknown[] = [];
  const decisions = createDecisionBroker();
  const bridge = createAskUserBridge({
    db,
    project,
    decisions,
    onAnswered: (answer) => answers.push(answer),
    cardTimeoutMs: 25,
  });
  bridge("Ship tonight?", "", [], false);

  const session = getOrCreateActiveSession(db, project.id);
  const cardTurn = listTurns(db, session.id).find((turn) => turn.role === "system");
  assert.ok(cardTurn);
  assert.equal((JSON.parse(cardTurn.content) as { status: string }).status, "pending");

  // A real broker timeout (injected short for the test; production is 10min).
  await new Promise((resolve) => setTimeout(resolve, 80));

  const settled = JSON.parse(
    listTurns(db, session.id).find((turn) => turn.id === cardTurn.id)?.content ?? "{}",
  ) as Record<string, unknown>;
  assert.equal(settled.status, "timeout");
  assert.equal(
    listOpenAttentionItems(db, project.id).length,
    1,
    "a non-answer keeps the question owed — the queue re-raises it",
  );
  assert.equal(answers.length, 0, "no wake without an answer");
});

test("triage's tool surface is non-destructive: pause and escalate, never stop (2026-07-10 ruling)", () => {
  assert.ok(!TRIAGE_ALLOWED_TOOLS.includes("mcp__galapagos__stop_worker"));
  assert.ok(TRIAGE_ALLOWED_TOOLS.includes("mcp__galapagos__hold_worker"));
  assert.ok(TRIAGE_ALLOWED_TOOLS.includes("mcp__galapagos__ask_user"));
  assert.ok(TRIAGE_ALLOWED_TOOLS.includes("mcp__galapagos__steer_worker"));
});
