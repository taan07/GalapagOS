import test from "node:test";
import assert from "node:assert/strict";
import { buildRebrief, type RebriefRecord } from "../src/core/records/rebrief";

function record(overrides: Partial<RebriefRecord>): RebriefRecord {
  return {
    type: "user_answer",
    title: "t",
    status: "agreed",
    createdAt: "2026-07-04T10:00:00.000Z",
    body: "body",
    ...overrides,
  };
}

test("returns null when there is nothing durable to seed from", () => {
  assert.equal(
    buildRebrief({
      projectName: "Mali",
      synthesis: null,
      goals: [],
      openQuestions: [],
      recentAnswers: [],
    }),
    null,
  );
});

test("seeds synthesis and goals with full bodies, questions and answers as lists", () => {
  const brief = buildRebrief({
    projectName: "Mali",
    synthesis: record({
      type: "manager_synthesis",
      title: "Where the project stands",
      body: "A marketplace for local sellers; payments pinned to PromptPay.",
    }),
    goals: [
      record({
        type: "active_goal",
        title: "Ship seller reviews",
        status: "active",
        body: "Reviews with photos, launch TH-first.",
      }),
    ],
    openQuestions: [
      record({ type: "open_question", title: "Who moderates photos?", status: "open" }),
    ],
    recentAnswers: [
      record({ title: "Which providers at launch?", body: "PromptPay only." }),
    ],
  });

  assert.ok(brief);
  assert.match(brief, /^# Re-brief from durable records — project "Mali"/);
  assert.match(brief, /## Latest synthesis/);
  assert.match(brief, /payments pinned to PromptPay/);
  assert.match(brief, /## Active goals/);
  assert.match(brief, /Reviews with photos, launch TH-first\./);
  assert.match(brief, /- \[open\] Who moderates photos\? \(2026-07-04\)/);
  assert.match(brief, /- \[agreed\] Which providers at launch\? \(2026-07-04\)/);
  // Honesty framing: records are memory, not transcripts.
  assert.match(brief, /could not be resumed/);
});

test("sections with no records are omitted entirely", () => {
  const brief = buildRebrief({
    projectName: "P",
    synthesis: null,
    goals: [record({ type: "active_goal", title: "G", body: "g" })],
    openQuestions: [],
    recentAnswers: [],
  });
  assert.ok(brief);
  assert.doesNotMatch(brief, /## Latest synthesis/);
  assert.doesNotMatch(brief, /## Open questions/);
  assert.match(brief, /## Active goals/);
});
