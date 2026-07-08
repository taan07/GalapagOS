# Leg: tripwires — test integrity (deterministic)

**One sentence:** before believing "the tests pass", check whether the worker
touched the things that decide what "pass" means.

**Why it exists:** the documented way agents cheat is not writing clever bad
code — it is corrupting the checks: rewriting the test script to `true`,
patching the test runner's config, exiting 0 before assertions run, adding
an object that says it equals everything, skipping tests, or deleting
assertions until the suite passes. (Every one of these is a real, observed
production exploit — sources in docs/research/confidence-engine-evidence.md.)

**How it works:** pure pattern-matching over the worker's actual diff vs its
lane base — committed, uncommitted, and untracked alike. No model, no
guessing, runs on every monitor tick for free.

| Tripwire | Fires when | Severity |
| --- | --- | --- |
| check-script-modified | package.json's test/typecheck/lint/build scripts changed | alert (blocks) |
| check-script-target-modified | a file the check scripts execute through (e.g. scripts/run-tests.sh) changed | alert (blocks) |
| check-machinery-modified | conftest.py, jest/vitest/mocha/karma config, Makefile/justfile/Taskfile changed | alert (blocks) |
| exit-in-tests | a hard `exit(0)` added inside test files | alert (blocks) |
| always-equal | a custom `__eq__` returning True added anywhere | alert (blocks) |
| tests-skipped | skip markers added to tests (≥3 escalates to alert) | warn → alert |
| tests-focused | a .only/fit/fdescribe added — the runner silently skips every OTHER test | alert (blocks) |
| trivial-assertions | assertions that assert nothing added (expect(true).toBe(true), assert(true)) | warn |
| assertions-deleted | net assertion loss in tests (≥3 escalates) | warn → alert |
| judge-tests-edited | worker changed both code AND the tests that judge it | warn |

**What a finding does:** an **alert** caps the worker's confidence at 40 and
blocks it (corrupting the judge is a contradiction-class breach), and lands a
high-priority `integrity_alert` on the queue. A **warn** lowers the score and
points the critic's attention — editing your own tests is legitimate TDD, but
the passing evidence is then partly self-authored, and someone independent
should look.

**Honest limits** (sharpened by the adversarial review, 2026-07-05):
patterns are heuristics — a novel exploit that matches no pattern passes this
leg silently, and an unusual-but-honest change can fire a warn (that is what
warns are for). Known residual holes, deliberately left to the watchdog and
critic: script indirection is traced ONE level (a script calling a script is
invisible here); gutting a shared non-test helper that tests call
(src/support/verify.ts style) fires at most the judge-tests-edited warn;
junk assertions beyond the literal tautology patterns are semantic judgment.
If the diff cannot be read at all, the leg reports "unavailable" and the
gauge drains — it never silently reports clean.

**Code:** `src/core/legs/tripwires.ts` (pure detection + diff parsing),
`src/adapters/legs/tripwires.ts` (git I/O). Tests: `tests/leg-tripwires.test.ts`.
