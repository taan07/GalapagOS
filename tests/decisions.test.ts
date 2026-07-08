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

test("an unanswered decision times out honestly", async () => {
  const broker = createDecisionBroker();
  const { outcome } = broker.ask({
    question: "q",
    options: OPTIONS,
    multiSelect: false,
    timeoutMs: 20,
  });
  const settled = await outcome;
  assert.deepEqual(settled, { status: "timeout" });
  assert.match(describeOutcome(settled), /deferred/);
  assert.match(describeOutcome(settled), /do NOT guess/);
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

test("answering an unknown decision id is refused", () => {
  const broker = createDecisionBroker();
  assert.equal(broker.answer("nope", { selections: [], custom: "" }), false);
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
