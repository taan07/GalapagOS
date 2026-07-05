// The judgment legs' pure halves: prompt assembly (blinding, truncation,
// untrusted-data framing) and verdict parsing (no quote, no finding).
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWatchdogPrompt,
  parseWatchdogVerdict,
} from "../src/core/legs/watchdog";
import { buildCriticPrompt, parseCriticVerdict } from "../src/core/legs/critic";

test("watchdog prompt frames the transcript as untrusted and truncates honestly", () => {
  const events = Array.from({ length: 50 }, (_, index) => ({
    kind: "assistant",
    text: `step ${index} ${"x".repeat(200)}`,
    createdAt: "2026-07-05T10:00:00.000Z",
  }));
  const prompt = buildWatchdogPrompt({
    laneName: "auth ui",
    allowedGlobs: ["src/auth/**"],
    events,
    charBudget: 3000,
  });
  assert.match(prompt, /UNTRUSTED/);
  assert.match(prompt, /BEGIN UNTRUSTED TRANSCRIPT/);
  assert.match(prompt, /transcript truncated/);
  assert.match(prompt, /step 0 /, "the head survives truncation");
  assert.match(prompt, /step 49 /, "the tail survives truncation");
});

test("watchdog verdicts parse, and accusations without quotes are refused", () => {
  const clean = parseWatchdogVerdict(
    'ok\n```watchdog-verdict\n{ "verdict": "clean", "summary": "honest run", "evidence": [] }\n```',
  );
  assert.ok(clean.ok && clean.verdict.verdict === "clean");

  const gaming = parseWatchdogVerdict(
    '```watchdog-verdict\n{ "verdict": "gaming", "summary": "faked pass", "evidence": ["I will just call exit(0)"] }\n```',
  );
  assert.ok(gaming.ok && gaming.verdict.evidence.length === 1);

  const unevidenced = parseWatchdogVerdict(
    '```watchdog-verdict\n{ "verdict": "gaming", "summary": "vibes", "evidence": [] }\n```',
  );
  assert.ok(!unevidenced.ok, "no quote, no verdict");

  assert.ok(!parseWatchdogVerdict("no block here").ok);
  assert.ok(!parseWatchdogVerdict("```watchdog-verdict\n{ not json }\n```").ok);
});

test("critic prompt is blinded: brief, contract, specifics, evidence, diff — and truncates honestly", () => {
  const prompt = buildCriticPrompt({
    briefTitle: "Harden the login form",
    briefBody: "Add validation. Out of scope: SSO.",
    laneName: "auth ui",
    allowedGlobs: ["src/auth/**"],
    forbiddenGlobs: ["**/*.env"],
    agreedSpecifics: [{ question: "Which providers?", answer: "cards only at launch" }],
    evidenceSummary: "- test: passed (fresh)",
    diffText: "x".repeat(200),
    diffBudget: 100,
  });
  assert.match(prompt, /Harden the login form/);
  assert.match(prompt, /cards only at launch/);
  assert.match(prompt, /UNTRUSTED DATA/);
  assert.match(prompt, /diff truncated/);
  // Blinding is structural: the builder has no parameter that could carry
  // the worker's narrative or claims — nothing to assert beyond its inputs.
});

test("critic verdicts parse; unanchored findings are dropped; reject demands a blocker", () => {
  const ok = parseCriticVerdict(
    [
      "```critic-verdict",
      JSON.stringify({
        verdict: "needs_work",
        summary: "usable with follow-up",
        findings: [
          { severity: "major", title: "no error path", evidence: "diff adds no catch/reject handling" },
          { severity: "minor", title: "unanchored vibes", evidence: "  " },
        ],
      }),
      "```",
    ].join("\n"),
  );
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.verdict.findings.length, 1, "the unanchored finding was dropped");
  }

  const emptyReject = parseCriticVerdict(
    '```critic-verdict\n{ "verdict": "reject", "summary": "bad", "findings": [] }\n```',
  );
  assert.ok(!emptyReject.ok, "a reject with no evidence-anchored blocker is refused");

  const approve = parseCriticVerdict(
    '```critic-verdict\n{ "verdict": "approve", "summary": "meets the brief", "findings": [] }\n```',
  );
  assert.ok(approve.ok && approve.verdict.verdict === "approve");
});
