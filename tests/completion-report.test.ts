import test from "node:test";
import assert from "node:assert/strict";
import { parseCompletionReport } from "../src/core/digests/completion";

const VALID_REPORT = {
  narrative: "Added login validation. Tests cover the empty and invalid cases.",
  before_after: [{ before: "any string logged in", after: "credentials are validated" }],
  claims: [
    { text: "unit tests pass", evidence_kind: "test", files: ["src/auth/login.test.ts"] },
    { text: "typecheck clean", evidence_kind: "typecheck" },
  ],
  touched_areas: ["src/auth"],
};

function fenced(body: string): string {
  return "Work is done.\n\n```galapagos-completion\n" + body + "\n```\n";
}

test("a valid report parses with files defaulting to empty", () => {
  const result = parseCompletionReport(fenced(JSON.stringify(VALID_REPORT)));
  assert.equal(result.status, "parsed");
  if (result.status !== "parsed") {
    return;
  }
  assert.equal(result.report.narrative, VALID_REPORT.narrative);
  assert.deepEqual(result.report.claims[1], {
    text: "typecheck clean",
    evidence_kind: "typecheck",
    files: [],
  });
  assert.deepEqual(result.report.touched_areas, ["src/auth"]);
});

test("text without a fenced block is missing, not malformed", () => {
  assert.deepEqual(parseCompletionReport("Should I use bcrypt or argon2 here?"), {
    status: "missing",
  });
  // A plain ``` fence or a different language tag is not a completion block.
  assert.deepEqual(parseCompletionReport("```json\n{}\n```"), { status: "missing" });
});

test("invalid JSON in the block is malformed with the parse error surfaced", () => {
  const result = parseCompletionReport(fenced("{ narrative: unquoted }"));
  assert.equal(result.status, "malformed");
  if (result.status === "malformed") {
    assert.match(result.problems[0] ?? "", /not valid JSON/);
  }
});

test("missing or wrong-typed fields are each named as problems", () => {
  const result = parseCompletionReport(
    fenced(JSON.stringify({ narrative: "", before_after: "nope", claims: [{}] })),
  );
  assert.equal(result.status, "malformed");
  if (result.status !== "malformed") {
    return;
  }
  const problems = result.problems.join("\n");
  assert.match(problems, /"narrative" must be a non-empty string/);
  assert.match(problems, /"before_after" must be an array/);
  assert.match(problems, /"claims\[0\]\.text"/);
  assert.match(problems, /"claims\[0\]\.evidence_kind"/);
  assert.match(problems, /"touched_areas" must be an array/);
});

test("an unknown evidence_kind is malformed — claims carry honest evidence labels", () => {
  const report = {
    ...VALID_REPORT,
    claims: [{ text: "it works", evidence_kind: "vibes", files: [] }],
  };
  const result = parseCompletionReport(fenced(JSON.stringify(report)));
  assert.equal(result.status, "malformed");
  if (result.status === "malformed") {
    assert.match(result.problems[0] ?? "", /evidence_kind" must be one of typecheck\|lint\|test/);
  }
});

test("a JSON array instead of an object is malformed", () => {
  const result = parseCompletionReport(fenced("[1, 2]"));
  assert.equal(result.status, "malformed");
  if (result.status === "malformed") {
    assert.match(result.problems[0] ?? "", /single JSON object/);
  }
});

test("the last completion block wins when several exist", () => {
  const first = { ...VALID_REPORT, narrative: "First attempt." };
  const second = { ...VALID_REPORT, narrative: "Final report." };
  const text = fenced(JSON.stringify(first)) + "\nMore work happened.\n" + fenced(JSON.stringify(second));
  const result = parseCompletionReport(text);
  assert.equal(result.status, "parsed");
  if (result.status === "parsed") {
    assert.equal(result.report.narrative, "Final report.");
  }
});
