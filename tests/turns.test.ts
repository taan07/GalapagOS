import test from "node:test";
import assert from "node:assert/strict";
import {
  groupTurns,
  isFirstClassChip,
  planSettledTurn,
  splitAnswerFold,
  type IndexedItem,
} from "../src/ui/turns";
import type { ChatItem } from "../src/ui/types";

const chip = (tool: string): ChatItem => ({
  kind: "chip",
  chip: { tool, summary: `${tool} ran`, detail: "" },
});

test("groupTurns opens a group per user message and keeps order", () => {
  const items: ChatItem[] = [
    { kind: "user", text: "first", at: "2026-07-10T10:00:00Z" },
    chip("git_truth"),
    { kind: "assistant", text: "done" },
    { kind: "user", text: "second" },
    { kind: "assistant", text: "ok" },
  ];
  const groups = groupTurns(items);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.user?.item.kind, "user");
  assert.equal(groups[0]?.at, "2026-07-10T10:00:00Z");
  assert.equal(groups[0]?.body.length, 2);
  assert.deepEqual(
    groups[0]?.body.map((entry) => entry.index),
    [1, 2],
  );
  assert.equal(groups[1]?.key, 3);
  assert.equal(groups[1]?.body.length, 1);
});

test("items before any user message form a preamble group", () => {
  const items: ChatItem[] = [
    { kind: "note", text: "daemon restarted" },
    { kind: "user", text: "hi" },
  ];
  const groups = groupTurns(items);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.user, null);
  assert.equal(groups[0]?.body.length, 1);
});

test("worker management and merges are first-class; reads and records roll up", () => {
  for (const tool of [
    "spawn_worker",
    "resume_worker",
    "steer_worker",
    "hold_worker",
    "stop_worker",
    "merge_worker",
    "amend_lane",
  ]) {
    assert.equal(isFirstClassChip({ tool, summary: "", detail: "" }), true, tool);
  }
  for (const tool of ["git_truth", "read_records", "write_record", "run_checks", "Read", "Grep"]) {
    assert.equal(isFirstClassChip({ tool, summary: "", detail: "" }), false, tool);
  }
});

test("planSettledTurn rolls routine chips up and keeps everything else inline", () => {
  const body: IndexedItem[] = [
    { item: chip("git_truth"), index: 1 },
    { item: { kind: "assistant", text: "working on it" }, index: 2 },
    { item: chip("spawn_worker"), index: 3 },
    { item: chip("read_records"), index: 4 },
    { item: { kind: "assistant", text: "done" }, index: 5 },
  ];
  const plan = planSettledTurn(body);
  assert.deepEqual(
    plan.inline.map((entry) => entry.index),
    [2, 3, 5],
  );
  assert.deepEqual(
    plan.rolledUp.map((entry) => entry.index),
    [1, 4],
  );
});

test("splitAnswerFold splits the first paragraph from substantial detail", () => {
  const text =
    "The merge landed cleanly — all 231 tests pass.\n\n" +
    "The conflict in worker-runtime.ts resolved in favor of the lane guard, and the " +
    "records store required no migration because the schema was already current.";
  const fold = splitAnswerFold(text);
  assert.equal(fold.lead, "The merge landed cleanly — all 231 tests pass.");
  assert.ok(fold.rest?.startsWith("The conflict"));
});

test("splitAnswerFold refuses unsafe or worthless splits", () => {
  // Single paragraph: nothing to fold.
  assert.equal(splitAnswerFold("Just one line.").rest, null);
  // Unclosed code fence in the lead: splitting would break the markdown.
  const fenced = "Here:\n```ts\nconst a = 1;\n\nconst b = 2;\n```";
  assert.equal(splitAnswerFold(fenced).rest, null);
  // Tiny remainder: not worth a click.
  assert.equal(splitAnswerFold("An answer sentence.\n\nOk.").rest, null);
  // Giant first paragraph: not a headline, keep it whole.
  const giant = `${"x".repeat(500)}\n\n${"y".repeat(100)}`;
  assert.equal(splitAnswerFold(giant).rest, null);
});
