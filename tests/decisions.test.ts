import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDecisionBroker,
  describeOutcome,
} from "../src/adapters/agent/decisions";
import { openDb } from "../src/adapters/db/db";
import { registerProject } from "../src/adapters/db/repos/projects";
import {
  appendTurn,
  getOrCreateActiveSession,
  getTurn,
  sweepPendingDecisionTurns,
} from "../src/adapters/db/repos/manager";

const OPTIONS = [
  { label: "Allow", implication: "The lane widens." },
  { label: "Deny", implication: "The lane stays as declared." },
];

test("a decision resolves with the user's answer", async () => {
  const broker = createDecisionBroker();
  const { request, outcome } = broker.ask({
    question: "Widen the lane?",
    options: OPTIONS,
    multiSelect: false,
  });
  assert.ok(broker.isPending(request.id));

  assert.equal(broker.answer(request.id, { selections: ["Allow"], custom: "but be careful" }), true);
  const settled = await outcome;
  assert.deepEqual(settled, {
    status: "answered",
    answer: { selections: ["Allow"], custom: "but be careful" },
  });
  assert.equal(broker.isPending(request.id), false);
  // A second answer to the same decision is rejected.
  assert.equal(broker.answer(request.id, { selections: ["Deny"], custom: "" }), false);
});

test("an unanswered decision stays pending after a delay and accepts a late answer", async () => {
  const broker = createDecisionBroker();
  const { request, outcome } = broker.ask({
    question: "q",
    options: OPTIONS,
    multiSelect: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(broker.isPending(request.id), true, "time alone must not settle the card");
  assert.equal(
    await Promise.race([outcome.then(() => false), new Promise<true>((resolve) => setTimeout(() => resolve(true), 5))]),
    true,
    "the outcome remains unresolved until an answer or interruption",
  );
  assert.equal(broker.answer(request.id, { selections: ["Deny"], custom: "after thinking" }), true);
  assert.deepEqual(await outcome, {
    status: "answered",
    answer: { selections: ["Deny"], custom: "after thinking" },
  });
});

test("an interrupted turn resolves its pending decision as interrupted", async () => {
  const broker = createDecisionBroker();
  const controller = new AbortController();
  const { outcome } = broker.ask({
    question: "q",
    options: OPTIONS,
    multiSelect: false,
    signal: controller.signal,
  });
  controller.abort();
  const settled = await outcome;
  assert.deepEqual(settled, { status: "interrupted" });
  assert.match(describeOutcome(settled), /interrupted/i);
});

test("an already-interrupted turn settles immediately without a pending card", async () => {
  const broker = createDecisionBroker();
  const controller = new AbortController();
  controller.abort();
  const { request, outcome } = broker.ask({
    question: "q",
    options: OPTIONS,
    multiSelect: false,
    signal: controller.signal,
  });
  assert.deepEqual(await outcome, { status: "interrupted" });
  assert.equal(broker.isPending(request.id), false);
  assert.equal(broker.answer(request.id, { selections: ["Allow"], custom: "" }), false);
});

test("answering an unknown decision id is refused", () => {
  const broker = createDecisionBroker();
  assert.equal(broker.answer("nope", { selections: [], custom: "" }), false);
});

test("a cancelled fire-and-forget decision releases its pending entry", async () => {
  const broker = createDecisionBroker();
  const { request, outcome } = broker.ask({ question: "q", options: OPTIONS, multiSelect: false });

  assert.equal(broker.cancel(request.id), true);
  assert.deepEqual(await outcome, { status: "cancelled" });
  assert.equal(broker.isPending(request.id), false);
  assert.equal(broker.answer(request.id, { selections: ["Allow"], custom: "" }), false);
  assert.match(describeOutcome({ status: "cancelled" }), /no longer needs an answer/i);
});

test("describeOutcome renders answers Darwin can act on", () => {
  assert.equal(
    describeOutcome({ status: "answered", answer: { selections: ["A", "B"], custom: "note" } }),
    "The user chose: A; B. Their note: note",
  );
  assert.match(
    describeOutcome({ status: "answered", answer: { selections: [], custom: "" } }),
    /answered without selecting/,
  );
});

test("batch and confirm cards share the no-timeout broker lifetime", async () => {
  const broker = createDecisionBroker();
  const fields = [
    { id: "tone", prompt: "Voice?", options: OPTIONS, multiSelect: false },
    { id: "units", prompt: "Units?", options: OPTIONS, multiSelect: false },
  ];
  const { request, outcome } = broker.ask({ kind: "batch", fields });
  assert.equal(request.kind, "batch");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(broker.isPending(request.id), true);
  assert.equal(
    broker.answer(request.id, {
      selections: [],
      responses: { tone: ["Allow"], units: ["Deny"] },
      custom: "",
    }),
    true,
  );
  const settled = await outcome;
  assert.equal(settled.status, "answered");
  const described = describeOutcome(settled, fields);
  assert.match(described, /Voice\? → Allow/);
  assert.match(described, /Units\? → Deny/);

  const confirm = broker.ask({
    kind: "confirm",
    question: "Proceed?",
    options: OPTIONS,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(broker.isPending(confirm.request.id), true);
  assert.equal(
    broker.answer(confirm.request.id, { selections: ["Allow"], custom: "" }),
    true,
  );
  assert.equal((await confirm.outcome).status, "answered");
});

test("describeOutcome carries the user's chat note as the free-text answer", () => {
  assert.match(
    describeOutcome({
      status: "answered",
      answer: { selections: [], responses: {}, custom: "actually, make it deadpan" },
    }),
    /Their note: actually, make it deadpan/,
  );
});

test("boot sweep expires decision turns left pending by a dead daemon", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-dec-state-"));
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "glp-dec-proj-"));
  mkdirSync(path.join(projectDir, ".git"));
  const db = openDb(stateDir);
  const project = await registerProject(db, { rootPath: projectDir });
  const session = getOrCreateActiveSession(db, project.id);

  const pending = appendTurn(db, {
    sessionId: session.id,
    role: "system",
    content: JSON.stringify({
      kind: "decision",
      decisionId: "d1",
      question: "q",
      options: [],
      multiSelect: false,
      status: "pending",
      selections: [],
      custom: "",
    }),
  });
  const answered = appendTurn(db, {
    sessionId: session.id,
    role: "system",
    content: JSON.stringify({
      kind: "decision",
      decisionId: "d2",
      question: "q2",
      options: [],
      multiSelect: false,
      status: "answered",
      selections: ["A"],
      custom: "",
    }),
  });

  assert.equal(sweepPendingDecisionTurns(db), 1);
  assert.match(getTurn(db, pending.id)?.content ?? "", /"status":"expired"/);
  assert.match(getTurn(db, answered.id)?.content ?? "", /"status":"answered"/, "settled turns untouched");
  assert.equal(sweepPendingDecisionTurns(db), 0, "idempotent");
});
