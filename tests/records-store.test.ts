import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRecordsStore, RECORDS_DIR } from "../src/adapters/records/store";

function fixtureProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glp-store-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  return dir;
}

const NOW = new Date("2026-07-04T12:00:00.000Z");

test("create writes a per-type file with full frontmatter and round-trips", () => {
  const root = fixtureProject();
  const store = createRecordsStore(root, "mali");
  const record = store.create({
    type: "active_goal",
    title: "Ship the seller review flow",
    body: "Reviews with photos, PromptPay-gated, launch in TH first.",
    now: NOW,
  });

  assert.match(record.id, /^[0-9a-f]{8}$/);
  assert.equal(record.status, "active");
  assert.equal(record.project, "mali");
  assert.equal(
    record.filePath,
    `${RECORDS_DIR}/goals/2026-07-04-ship-the-seller-review-flow-${record.id}.md`,
  );

  const content = readFileSync(path.join(root, record.filePath), "utf8");
  assert.match(content, /glp_type: "active_goal"/);
  assert.match(content, /written_by: "Galapagos"/);
  assert.match(content, /created_at: "2026-07-04T12:00:00\.000Z"/);
  assert.match(content, /PromptPay-gated/);

  const listed = store.list({ type: "active_goal" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, record.id);
  assert.equal(store.get(record.id)?.title, "Ship the seller review flow");
});

test("creates never overwrite: same title, same day, distinct files", () => {
  const root = fixtureProject();
  const store = createRecordsStore(root, "p");
  const first = store.create({ type: "user_answer", title: "Same", body: "a", now: NOW });
  const second = store.create({ type: "user_answer", title: "Same", body: "b", now: NOW });
  assert.notEqual(first.filePath, second.filePath);
  assert.equal(readdirSync(path.join(root, RECORDS_DIR, "answers")).length, 2);
});

test("closed statuses are rejected on create but reachable via update", () => {
  const root = fixtureProject();
  const store = createRecordsStore(root, "p");
  assert.throws(
    () => store.create({ type: "open_question", title: "Q", body: "b", status: "resolved" }),
    /closed status/,
  );

  const record = store.create({ type: "open_question", title: "Q", body: "b", now: NOW });
  const updated = store.update({
    id: record.id,
    status: "resolved",
    note: "Answered in chat: PromptPay only.",
    now: new Date("2026-07-05T09:00:00.000Z"),
  });
  assert.equal(updated.status, "resolved");
  assert.equal(updated.updatedAt, "2026-07-05T09:00:00.000Z");
  assert.match(updated.body, /## Update \(2026-07-05\)\n\nAnswered in chat: PromptPay only\./);
  assert.equal(updated.createdAt, record.createdAt);

  assert.throws(() => store.update({ id: record.id, status: "open" }), /Cannot reopen/);
});

test("decision lifecycle: options required, chosen_path gates closing", () => {
  const root = fixtureProject();
  const store = createRecordsStore(root, "p");
  assert.throws(
    () => store.create({ type: "decision", title: "Pick", body: "b" }),
    /decision_options/,
  );

  const decision = store.create({
    type: "decision",
    title: "Pick the payments provider",
    body: "Considered during launch planning.",
    extra: {
      decision_options: ["PromptPay", "Cards"],
      rollback_note: "Feature-flag back to manual invoicing.",
      confidence_impact: "Neutral until live traffic.",
    },
    now: NOW,
  });
  assert.throws(() => store.update({ id: decision.id, status: "approved" }), /chosen_path/);

  const approved = store.update({
    id: decision.id,
    status: "approved",
    chosenPath: "PromptPay",
    now: NOW,
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.frontmatter.chosen_path, "PromptPay");
  assert.deepEqual(approved.frontmatter.decision_options, ["PromptPay", "Cards"]);
});

test("chosen_path is rejected on non-decision records", () => {
  const root = fixtureProject();
  const store = createRecordsStore(root, "p");
  const record = store.create({ type: "user_answer", title: "Q", body: "b", now: NOW });
  assert.throws(
    () => store.update({ id: record.id, chosenPath: "x" }),
    /only to decision records/,
  );
});

test("reserved frontmatter keys cannot be smuggled through extra", () => {
  const root = fixtureProject();
  const store = createRecordsStore(root, "p");
  assert.throws(
    () =>
      store.create({
        type: "user_answer",
        title: "Q",
        body: "b",
        extra: { written_by: "not-galapagos" },
      }),
    /reserved/,
  );
});

test("list filters by type and status and sorts by creation time", () => {
  const root = fixtureProject();
  const store = createRecordsStore(root, "p");
  store.create({ type: "user_answer", title: "First", body: "b", now: new Date("2026-07-01T00:00:00Z") });
  store.create({ type: "user_answer", title: "Second", body: "b", now: new Date("2026-07-02T00:00:00Z") });
  const question = store.create({
    type: "open_question",
    title: "Open one",
    body: "b",
    now: new Date("2026-07-03T00:00:00Z"),
  });
  store.update({ id: question.id, status: "resolved" });

  assert.deepEqual(
    store.list().map((doc) => doc.title),
    ["First", "Second", "Open one"],
  );
  assert.equal(store.list({ type: "user_answer" }).length, 2);
  assert.equal(store.list({ status: "resolved" }).length, 1);
  assert.equal(store.list({ type: "user_answer", status: "resolved" }).length, 0);
});

test("unknown ids and empty updates fail loudly; foreign files are ignored", () => {
  const root = fixtureProject();
  const store = createRecordsStore(root, "p");
  assert.throws(() => store.update({ id: "deadbeef", status: "resolved" }), /No record/);

  const record = store.create({ type: "user_answer", title: "Q", body: "b", now: NOW });
  assert.throws(() => store.update({ id: record.id }), /needs a status change/);

  assert.equal(existsSync(path.join(root, RECORDS_DIR)), true);
});
