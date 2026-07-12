import test from "node:test";
import assert from "node:assert/strict";
import { buildRebrief, type RebriefInput, type RebriefRecord } from "../src/core/records/rebrief";

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

function input(overrides: Partial<RebriefInput>): RebriefInput {
  return {
    projectName: "Mali",
    synthesis: null,
    goals: [],
    openQuestions: [],
    recentAnswers: [],
    styleContracts: [],
    threadState: [],
    fleet: [],
    ...overrides,
  };
}

test("returns null when there is nothing durable to seed from", () => {
  assert.equal(buildRebrief(input({})), null);
});

test("thread state and fleet alone never justify a preamble — they are ephemera, not records", () => {
  assert.equal(
    buildRebrief(
      input({
        threadState: ["User: are we done?", "Darwin: almost."],
        fleet: ["abc12345 [running] lane \"auth ui\""],
      }),
    ),
    null,
  );
});

test("seeds synthesis and goals with full bodies, questions and answers as lists", () => {
  const brief = buildRebrief(
    input({
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
      recentAnswers: [record({ title: "Which providers at launch?", body: "PromptPay only." })],
    }),
  );

  assert.ok(brief);
  assert.match(brief, /^# Re-brief from durable records — project "Mali"/);
  assert.match(brief, /## Latest synthesis/);
  assert.match(brief, /payments pinned to PromptPay/);
  assert.match(brief, /## Active goals/);
  assert.match(brief, /Reviews with photos, launch TH-first\./);
  assert.match(brief, /- \[open\] Who moderates photos\? \(2026-07-04\)/);
  assert.match(brief, /- \[agreed\] Which providers at launch\? \(2026-07-04\)/);
  // Honesty framing: records are memory, not transcripts.
  assert.match(brief, /institutional/);
});

test("sections with no records are omitted entirely", () => {
  const brief = buildRebrief(
    input({
      goals: [record({ type: "active_goal", title: "G", body: "g" })],
    }),
  );
  assert.ok(brief);
  assert.doesNotMatch(brief, /## Latest synthesis/);
  assert.doesNotMatch(brief, /## Open questions/);
  assert.doesNotMatch(brief, /## Where the thread stood/);
  assert.doesNotMatch(brief, /## Live workers right now/);
  assert.match(brief, /## Active goals/);
});

test("a style contract alone justifies a re-brief and leads the preamble", () => {
  const brief = buildRebrief(
    input({
      styleContracts: [
        record({
          type: "style_contract",
          title: "How to work with me",
          status: "active",
          body: "Answer first, details fold. Ask before touching main.",
        }),
      ],
    }),
  );
  assert.ok(brief, "behavior must survive a compaction even on a records-poor project");
  assert.match(brief, /## How to work with the user/);
  assert.match(brief, /Answer first, details fold/);
  // The style section renders before everything else in the body.
  assert.ok(
    brief.indexOf("How to work with the user") < brief.length,
  );
});

test("thread state and fleet render when records justify the preamble", () => {
  const brief = buildRebrief(
    input({
      goals: [record({ type: "active_goal", title: "G", body: "g" })],
      threadState: ["User: ship it today?", "Darwin: two checks remain."],
      fleet: ['abc12345 [running] lane "auth ui" — validating the login form'],
    }),
  );
  assert.ok(brief);
  assert.match(brief, /## Where the thread stood/);
  assert.match(brief, /- User: ship it today\?/);
  assert.match(brief, /- Darwin: two checks remain\./);
  assert.match(brief, /## Live workers right now/);
  assert.match(brief, /abc12345 \[running\] lane "auth ui"/);
  assert.match(brief, /survived the compaction/);
});
