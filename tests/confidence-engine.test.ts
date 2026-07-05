// The §9 gold scenarios — the confidence engine's SPECIFICATION. Each test
// names the architecture bullet it encodes; a change that breaks one is
// wrong until the contract itself changes. Sharpen ambiguities with the
// user, never by weakening a scenario.
import test from "node:test";
import assert from "node:assert/strict";
import { scoreProject, scoreWorker } from "../src/core/confidence/engine";
import type {
  ConfidenceReport,
  ProjectConfidenceInput,
  WorkerConfidenceInput,
} from "../src/core/confidence/types";

/** A healthy, fully evidenced worker — the baseline scenarios mutate from. */
function healthyWorker(overrides: Partial<WorkerConfidenceInput> = {}): WorkerConfidenceInput {
  return {
    label: "auth ui",
    liveness: { kind: "live", stale: false, secondsSinceLastMessage: 12, staleThresholdSeconds: 300 },
    laneAudit: { ran: true, violations: [] },
    hasDigest: true,
    claims: [
      { text: "tests pass", evidenceKind: "test", verification: "verified" },
      { text: "types check", evidenceKind: "typecheck", verification: "verified" },
    ],
    checks: {
      requiredKeys: ["typecheck", "test"],
      runs: [
        { key: "typecheck", status: "passed", fresh: true },
        { key: "test", status: "passed", fresh: true },
      ],
    },
    ...overrides,
  };
}

function clearProject(overrides: Partial<ProjectConfidenceInput> = {}): ProjectConfidenceInput {
  return {
    clarity: { hasSynthesis: true, hasActiveGoal: true, openQuestionCount: 0 },
    checks: {
      requiredKeys: [],
      runs: [
        { key: "typecheck", status: "passed", fresh: true },
        { key: "test", status: "passed", fresh: true },
        { key: "build", status: "passed", fresh: true },
      ],
    },
    freshEvidenceExists: true,
    workers: [],
    openAttention: { high: 0, normal: 0 },
    ...overrides,
  };
}

function capIds(report: ConfidenceReport): string[] {
  return report.caps.map((cap) => cap.id);
}

// ─── §9: complete manager clarity + fresh required evidence can reach strong ───

test("gold: full clarity plus fresh evidence reaches strong (project)", () => {
  const report = scoreProject(clearProject());
  assert.equal(report.state, "strong");
  assert.ok(report.score >= 80, `expected ≥80, got ${report.score}`);
});

test("gold: a fully evidenced worker reaches strong", () => {
  const report = scoreWorker(healthyWorker());
  assert.equal(report.state, "strong");
  assert.ok(report.score >= 80, `expected ≥80, got ${report.score}`);
});

// ─── §9: complete manager clarity with no real evidence stays below strong ───

test("gold: full clarity with no evidence stays below strong (records alone)", () => {
  const report = scoreProject(
    clearProject({
      checks: { requiredKeys: [], runs: [] },
      freshEvidenceExists: false,
    }),
  );
  assert.notEqual(report.state, "strong");
  assert.ok(report.score < 80, `expected <80, got ${report.score}`);
  assert.ok(capIds(report).includes("evidence.records-alone"), "the cap names itself");
  // No failure is standing — this is capped, not blocked or draining.
  assert.equal(report.state, "steady");
});

test("gold: a worker's claims alone cannot reach strong", () => {
  // Completion claimed, all claims 'verified'-looking prose… but nothing ran.
  // Under Galapagos policy completion also demands required checks, so this
  // worker is BLOCKED, not merely capped — a done-claim without evidence is
  // the exact thing the gauge exists to catch.
  const report = scoreWorker(
    healthyWorker({
      claims: [{ text: "all good", evidenceKind: "manual", verification: "unverified" }],
      checks: { requiredKeys: ["typecheck", "test"], runs: [] },
    }),
  );
  assert.ok(report.score < 80);
  assert.equal(report.state, "blocked");
  // An in-progress worker (no completion claimed, nothing demanded yet) is
  // merely capped below strong — never born blocked.
  const inProgress = scoreWorker(
    healthyWorker({
      hasDigest: false,
      claims: [],
      checks: { requiredKeys: [], runs: [] },
    }),
  );
  assert.equal(inProgress.state, "steady");
  assert.ok(inProgress.score < 80);
  assert.ok(capIds(inProgress).includes("evidence.none-fresh"));
});

// ─── §9: a missing or failed required check blocks; a failed optional lowers ───

test("gold: a missing required check blocks", () => {
  const report = scoreWorker(
    healthyWorker({
      checks: {
        requiredKeys: ["typecheck", "test"],
        runs: [{ key: "typecheck", status: "passed", fresh: true }],
      },
      claims: [],
    }),
  );
  assert.equal(report.state, "blocked");
  assert.ok(report.score <= 30, `expected ≤30, got ${report.score}`);
  const cap = report.caps.find((entry) => entry.id === "check.required-missing.test");
  assert.ok(cap, "the missing check names itself");
  assert.ok(cap.blocking);
});

test("gold: a failed required check blocks", () => {
  const report = scoreWorker(
    healthyWorker({
      checks: {
        requiredKeys: ["typecheck", "test"],
        runs: [
          { key: "typecheck", status: "passed", fresh: true },
          { key: "test", status: "failed", fresh: true },
        ],
      },
      claims: [],
    }),
  );
  assert.equal(report.state, "blocked");
  assert.ok(report.score <= 30);
  assert.ok(capIds(report).includes("check.required-failed.test"));
});

test("gold: a failed optional check lowers without blocking", () => {
  const clean = scoreWorker(healthyWorker());
  const lintFailed = scoreWorker(
    healthyWorker({
      checks: {
        requiredKeys: ["typecheck", "test"],
        runs: [
          { key: "typecheck", status: "passed", fresh: true },
          { key: "test", status: "passed", fresh: true },
          { key: "lint", status: "failed", fresh: true },
        ],
      },
    }),
  );
  assert.notEqual(lintFailed.state, "blocked");
  assert.ok(
    lintFailed.score < clean.score,
    `failed lint must lower: ${lintFailed.score} vs ${clean.score}`,
  );
  const signal = lintFailed.signals.find((entry) => entry.id === "check.optional-failed.lint");
  assert.ok(signal && signal.delta < 0, "the optional failure names itself");
});

// ─── §9: evidence that predates a head/dirty-state change is stale and drains ───

test("gold: stale evidence drains instead of counting", () => {
  const fresh = scoreWorker(healthyWorker());
  const stale = scoreWorker(
    healthyWorker({
      claims: [
        { text: "tests pass", evidenceKind: "test", verification: "unverified" },
        { text: "types check", evidenceKind: "typecheck", verification: "unverified" },
      ],
      checks: {
        requiredKeys: ["typecheck", "test"],
        runs: [
          { key: "typecheck", status: "passed", fresh: false },
          { key: "test", status: "passed", fresh: false },
        ],
      },
    }),
  );
  assert.equal(stale.state, "draining");
  assert.ok(stale.score < fresh.score);
  // Stale runs exist, so nothing is "missing" — this drains, it does not block.
  assert.ok(!stale.caps.some((cap) => cap.blocking), "staleness never blocks");
  assert.ok(capIds(stale).includes("check.stale.test"));
});

// ─── §9: a claim marked supported without linked evidence lowers ───

test("gold: an unsupported claim lowers — honesty is observable support", () => {
  const honest = scoreWorker(
    healthyWorker({
      claims: [{ text: "looks right in the browser", evidenceKind: "manual", verification: "unverified" }],
    }),
  );
  const dishonest = scoreWorker(
    healthyWorker({
      claims: [{ text: "full test suite passes", evidenceKind: "test", verification: "unsupported" }],
    }),
  );
  assert.ok(
    dishonest.score < honest.score,
    `claiming test evidence that does not exist must cost more than honest 'manual': ${dishonest.score} vs ${honest.score}`,
  );
  const signal = dishonest.signals.find((entry) => entry.id === "claim.unsupported");
  assert.ok(signal && signal.delta < 0 && signal.label.includes("full test suite passes"));
});

// ─── §9: a contradicted claim caps hard (≈40/blocked) ───

test("gold: a contradicted claim caps at 40 and blocks", () => {
  const report = scoreWorker(
    healthyWorker({
      claims: [{ text: "tests pass", evidenceKind: "test", verification: "contradicted" }],
    }),
  );
  assert.equal(report.state, "blocked");
  assert.ok(report.score <= 40, `expected ≤40, got ${report.score}`);
  const cap = report.caps.find((entry) => entry.id === "claim.contradicted");
  assert.ok(cap && cap.blocking && cap.capTo === 40);
  assert.ok(cap.label.includes("tests pass"), "the cap names the claim");
});

test("gold: a lane violation is a contradiction — caps and blocks", () => {
  const report = scoreWorker(
    healthyWorker({ laneAudit: { ran: true, violations: ["src/billing/sneaky.ts"] } }),
  );
  assert.equal(report.state, "blocked");
  assert.ok(report.score <= 40);
  const cap = report.caps.find((entry) => entry.id === "lane.violation");
  assert.ok(cap && cap.label.includes("src/billing/sneaky.ts"));
});

// ─── §9: one risky worker lowers project confidence even when others are healthy ───

test("gold: one blocked worker lowers an otherwise healthy project", () => {
  const healthy = scoreWorker(healthyWorker());
  const blocked = scoreWorker(
    healthyWorker({
      label: "payments api",
      claims: [{ text: "tests pass", evidenceKind: "test", verification: "contradicted" }],
    }),
  );
  const withoutRisk = scoreProject(
    clearProject({
      workers: [
        { label: "auth ui", report: healthy },
        { label: "search", report: healthy },
      ],
    }),
  );
  const withRisk = scoreProject(
    clearProject({
      workers: [
        { label: "auth ui", report: healthy },
        { label: "search", report: healthy },
        { label: "payments api", report: blocked },
      ],
    }),
  );
  assert.equal(withoutRisk.state, "strong");
  assert.ok(withRisk.score < withoutRisk.score);
  assert.notEqual(withRisk.state, "strong");
  const cap = withRisk.caps.find((entry) => entry.id === "workers.blocked");
  assert.ok(cap, "the risky worker caps the project");
  assert.ok(cap.label.includes("payments api"), "the cap names the worker");
});

// ─── §9: every score's caps and signals identify their reason ───

test("gold: no opaque numbers — every signal and cap carries a reason", () => {
  const reports = [
    scoreWorker(healthyWorker()),
    scoreWorker(
      healthyWorker({
        liveness: { kind: "failed" },
        laneAudit: { ran: false, reason: "worktree missing" },
        claims: [{ text: "x", evidenceKind: "test", verification: "contradicted" }],
        checks: { requiredKeys: ["test"], runs: [] },
      }),
    ),
    scoreProject(clearProject()),
    scoreProject(
      clearProject({
        checks: { requiredKeys: [], runs: [] },
        freshEvidenceExists: false,
        openAttention: { high: 2, normal: 3 },
      }),
    ),
  ];
  for (const report of reports) {
    assert.ok(report.stateReason.trim().length > 0, "the state explains itself");
    for (const signal of report.signals) {
      assert.ok(signal.id && signal.label.trim().length > 0, `signal ${signal.id} has a reason`);
      assert.ok(Number.isFinite(signal.delta));
    }
    for (const cap of report.caps) {
      assert.ok(cap.id && cap.label.trim().length > 0, `cap ${cap.id} has a reason`);
      assert.ok(cap.capTo >= 0 && cap.capTo <= 100);
    }
    // The binding cap is first and actually binds.
    const first = report.caps[0];
    if (first) {
      assert.ok(report.score <= first.capTo);
      for (const cap of report.caps) {
        assert.ok(cap.capTo >= first.capTo, "caps are sorted, binding first");
      }
    }
  }
});

// ─── Supporting scenarios the chunk exit criterion depends on ───

test("a stale (silent) worker drains", () => {
  const report = scoreWorker(
    healthyWorker({
      liveness: { kind: "live", stale: true, secondsSinceLastMessage: 900, staleThresholdSeconds: 300 },
    }),
  );
  assert.equal(report.state, "draining");
  assert.ok(report.score <= 55);
  const cap = report.caps.find((entry) => entry.id === "liveness.stale");
  assert.ok(cap && cap.label.includes("900s") && cap.label.includes("300s"));
});

test("a failed session blocks — stop is not recovery", () => {
  const report = scoreWorker(healthyWorker({ liveness: { kind: "failed" } }));
  assert.equal(report.state, "blocked");
  assert.ok(report.score <= 30);
});

test("a lane audit that could not run drains — missing evidence is never quiet health", () => {
  const report = scoreWorker(
    healthyWorker({ laneAudit: { ran: false, reason: "git diff failed: worktree deleted" } }),
  );
  assert.equal(report.state, "draining");
  const cap = report.caps.find((entry) => entry.id === "lane.audit-unavailable");
  assert.ok(cap && cap.label.includes("worktree deleted"));
});

test("open attention items lower project confidence", () => {
  const quiet = scoreProject(clearProject());
  const loud = scoreProject(clearProject({ openAttention: { high: 1, normal: 2 } }));
  assert.ok(loud.score < quiet.score);
  assert.ok(loud.signals.some((signal) => signal.id === "attention.high" && signal.delta < 0));
});

test("open questions lower clarity, answered questions restore it", () => {
  const open = scoreProject(
    clearProject({ clarity: { hasSynthesis: true, hasActiveGoal: true, openQuestionCount: 3 } }),
  );
  const answered = scoreProject(clearProject());
  assert.ok(open.score < answered.score);
  assert.ok(open.signals.some((signal) => signal.id === "clarity.open-questions" && signal.delta < 0));
});
