import test from "node:test";
import assert from "node:assert/strict";
import { parsePlan, parseStepUpdates } from "../src/core/plans/plan";

const VALID_PLAN = {
  goal: "Add emissions calculation to the questionnaire flow",
  steps: [
    { title: "Model the emission factors", detail: "one table per category" },
    { title: "Wire the calc engine" },
    { title: "Render the result screen" },
  ],
};

function fenced(tag: string, body: string): string {
  return `Here is the plan.\n\n\`\`\`${tag}\n${body}\n\`\`\`\n`;
}

test("a valid plan parses; step detail is optional", () => {
  const result = parsePlan(fenced("galapagos-plan", JSON.stringify(VALID_PLAN)));
  assert.equal(result.status, "parsed");
  if (result.status !== "parsed") {
    return;
  }
  assert.equal(result.plan.goal, VALID_PLAN.goal);
  assert.equal(result.plan.steps.length, 3);
  assert.deepEqual(result.plan.steps[0], {
    title: "Model the emission factors",
    detail: "one table per category",
  });
  assert.deepEqual(result.plan.steps[1], { title: "Wire the calc engine" });
});

test("text without a plan block is missing, not malformed", () => {
  assert.deepEqual(parsePlan("Just thinking out loud about the approach."), { status: "missing" });
  // A different language tag is not a plan block.
  assert.deepEqual(parsePlan("```json\n{}\n```"), { status: "missing" });
});

test("a plan block that is not valid JSON is malformed", () => {
  const result = parsePlan(fenced("galapagos-plan", "{ goal: no quotes }"));
  assert.equal(result.status, "malformed");
});

test("a plan missing goal or steps is malformed, naming each problem", () => {
  const noGoal = parsePlan(fenced("galapagos-plan", JSON.stringify({ steps: [{ title: "x" }] })));
  assert.equal(noGoal.status, "malformed");
  if (noGoal.status === "malformed") {
    assert.ok(noGoal.problems.some((p) => p.includes("goal")));
  }
  const emptySteps = parsePlan(
    fenced("galapagos-plan", JSON.stringify({ goal: "g", steps: [] })),
  );
  assert.equal(emptySteps.status, "malformed");
  const badStep = parsePlan(
    fenced("galapagos-plan", JSON.stringify({ goal: "g", steps: [{ detail: "no title" }] })),
  );
  assert.equal(badStep.status, "malformed");
});

test("when several plan blocks exist, the LAST one wins (a re-plan)", () => {
  const first = JSON.stringify({ goal: "old", steps: [{ title: "a" }] });
  const second = JSON.stringify({ goal: "new", steps: [{ title: "b" }, { title: "c" }] });
  const result = parsePlan(
    fenced("galapagos-plan", first) + fenced("galapagos-plan", second),
  );
  assert.equal(result.status, "parsed");
  if (result.status === "parsed") {
    assert.equal(result.plan.goal, "new");
    assert.equal(result.plan.steps.length, 2);
  }
});

test("parseStepUpdates returns every step block in order", () => {
  const text =
    "Progress:\n" +
    fenced("galapagos-step", JSON.stringify({ step: 1, status: "done" })) +
    fenced("galapagos-step", JSON.stringify({ step: 2, status: "active", note: "on it" }));
  const updates = parseStepUpdates(text);
  assert.deepEqual(updates, [
    { step: 1, status: "done" },
    { step: 2, status: "active", note: "on it" },
  ]);
});

test("malformed or out-of-contract step blocks are skipped, not thrown", () => {
  const text =
    fenced("galapagos-step", "{ not json }") +
    fenced("galapagos-step", JSON.stringify({ step: 0, status: "done" })) + // bad ordinal
    fenced("galapagos-step", JSON.stringify({ step: 2, status: "planned" })) + // bad status
    fenced("galapagos-step", JSON.stringify({ step: 3, status: "active" })); // valid
  assert.deepEqual(parseStepUpdates(text), [{ step: 3, status: "active" }]);
});

test("no step blocks yields an empty list", () => {
  assert.deepEqual(parseStepUpdates("nothing here"), []);
});
