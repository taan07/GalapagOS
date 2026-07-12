import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOSED_STATUSES,
  defaultStatus,
  GLP_TYPES,
  isGlpType,
  TYPE_DIRS,
  validateCreate,
  validateStatusChange,
} from "../src/core/records/schema";

test("exactly nine record types, each with a type dir and a default open status", () => {
  // style_contract joined 2026-07-13 (principle 7a: "how to work with me"
  // survives every compaction). Growing this list is always a deliberate,
  // test-updating act.
  assert.equal(GLP_TYPES.length, 9);
  for (const type of GLP_TYPES) {
    assert.ok(TYPE_DIRS[type], `missing dir for ${type}`);
    const status = defaultStatus(type);
    assert.ok(status);
    assert.ok(!(CLOSED_STATUSES as readonly string[]).includes(status));
  }
  assert.equal(isGlpType("agreed_specific"), false);
  assert.equal(isGlpType("active_goal"), true);
  assert.equal(isGlpType("style_contract"), true);
});

test("creating with a closed status is rejected", () => {
  for (const closed of CLOSED_STATUSES) {
    const problems = validateCreate({
      type: "active_goal",
      title: "Ship reviews",
      status: closed,
      extra: {},
    });
    assert.equal(problems.length, 1, closed);
    assert.match(problems[0] ?? "", /closed status/);
  }
});

test("creating with an open status valid for the type passes", () => {
  assert.deepEqual(
    validateCreate({ type: "open_question", title: "Who pays?", status: "deferred", extra: {} }),
    [],
  );
  const wrongType = validateCreate({
    type: "active_goal",
    title: "Goal",
    status: "deferred",
    extra: {},
  });
  assert.equal(wrongType.length, 1);
  assert.match(wrongType[0] ?? "", /not valid for active_goal/);
});

test("empty titles are rejected", () => {
  const problems = validateCreate({ type: "user_answer", title: "  ", status: "agreed", extra: {} });
  assert.match(problems.join(" "), /non-empty title/);
});

test("decision records require options, rollback note, and confidence impact", () => {
  const problems = validateCreate({ type: "decision", title: "Pick a db", status: "proposed", extra: {} });
  assert.equal(problems.length, 3);
  assert.match(problems.join(" "), /decision_options/);
  assert.match(problems.join(" "), /rollback_note/);
  assert.match(problems.join(" "), /confidence_impact/);

  const valid = validateCreate({
    type: "decision",
    title: "Pick a db",
    status: "proposed",
    extra: {
      decision_options: ["sqlite", "markdown"],
      rollback_note: "revert the commit",
      confidence_impact: "none until proven",
    },
  });
  assert.deepEqual(valid, []);
});

test("a decision cannot close without chosen_path", () => {
  const blocked = validateStatusChange({
    type: "decision",
    currentStatus: "proposed",
    nextStatus: "approved",
  });
  assert.equal(blocked.length, 1);
  assert.match(blocked[0] ?? "", /chosen_path/);

  const allowed = validateStatusChange({
    type: "decision",
    currentStatus: "proposed",
    nextStatus: "approved",
    chosenPath: "git-committed markdown",
  });
  assert.deepEqual(allowed, []);
});

test("closed records never reopen", () => {
  const problems = validateStatusChange({
    type: "open_question",
    currentStatus: "resolved",
    nextStatus: "open",
  });
  assert.match(problems.join(" "), /Cannot reopen/);
});

test("unknown statuses are rejected on update", () => {
  const problems = validateStatusChange({
    type: "user_answer",
    currentStatus: "agreed",
    nextStatus: "kinda-done",
  });
  assert.match(problems.join(" "), /not valid for user_answer/);
});
