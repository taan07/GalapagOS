# Handoff — Chunk 5 (Clarity view + completion digests)

## Kickoff prompt (paste this to the implementing agent verbatim)

```
Chunk 5 — Clarity view + completion digests (finished work becomes
absorbable in seconds)

Repo: ~/Dev/galapagos (github.com/taan07/GalapagOS). Chunk 2 is MERGED to
main. Chunks 3 AND 4 live stacked on
claude/chunk-4-monitoring-confidence-mud9n3 (which contains the chunk-3
branch's history) — check what has merged before branching: create your
branch from main if both merged, otherwise stack on the highest unmerged
chunk branch. Never commit Chunk 5 code to earlier chunks' branches.
Start by reading docs/handoffs/chunk-5.md (your handoff), then
docs/vision.md and docs/architecture.md — the binding contracts that
override everything else, including this prompt. Then implement
docs/chunks/5.md.

State you inherit — Chunks 1 and 2 COMPLETE (stamps in docs/chunks/1.md,
2.md). Chunks 3 and 4 BUILT, awaiting the user's live drills (stamps +
runbooks in docs/chunks/{3,4}{,-verification}.md; if the user reports
issues mid-work, fixing them comes FIRST, on that chunk's branch, then
rebase your stack). Standing: daemon :4517 owns all Agent SDK sessions
(startup line + GET /health report git revision and branch — ALWAYS
verify which code is running before diagnosing); web UI :3005 (pages /,
/workers, /records); central SQLite at ~/.galapagos/state.db — the
architecture §3 schema is now COMPLETE including evidence_runs; records
in each target repo's docs/galapagos/. Darwin's tools: git_truth,
record_specific, list_specifics, read_records, write_record,
update_record, spawn_worker, steer_worker, stop_worker, list_workers,
worker_status, run_checks, list_attention, resolve_attention,
review_completion (+ask_user, triage-only). The monitor ticks every 30s
with ZERO LLM calls (staleness, abandoned questions, mid-run lane audit,
claims-vs-evidence scan with auto-resolve, zero-LLM auto-review of clean
completions, main-checkout watch); event-driven triage runs on a fresh
records-seeded haiku session ONLY when new attention items exist; the
PURE confidence engine (core/confidence) implements §9's gold scenarios
exactly and aggregates FOUR independent legs — facts, tripwires
(deterministic test-integrity patterns), watchdog (haiku reads the full
transcript), critic (blinded diff-vs-brief critique) — one module, test
file, and doc per leg (docs/legs/), every signal naming its leg, and a
completion nobody independent reviewed is never strong or auto-reviewed;
evidence_runs are keyed to `<sha>` or `<sha>+dirty.<fingerprint>` so ANY
change makes evidence stale; the attention queue UI with resolve/dismiss
lives on /, gauges on / and /workers. 178/178 tests green via npm test.

Chunk 5 in one line: the pure clarity view-model (every displayed field
carries source attribution — source, sourceLabel, sourceRecords —
missing data renders explicitly missing, never fabricated), per-worker
now-vs-inception clarity, project clarity, the /clarity page, and the
completion digest as the four-layer lead surface of a finished worker's
drilldown (tiny narrative; before/after in product terms; visual change
map from live numstat sized by magnitude and colored in-lane/tested/
untested/out-of-lane; claim checklist with evidence badges, proof one
click away) via pure core/digests/assemble.ts. Forbidden: fabricated or
default-filled fields, raw agent prose as a default surface anywhere,
new tables or record types, confidence semantics changes.

Operational facts that will save you hours:
- Auth is keychain-bound on the user's machine; every session spawns
  through src/adapters/agent/spawn.ts. npm test runs anywhere; the build
  sandboxes of chunks 3 AND 4 had working SDK auth — try a real smoke
  via the daemon API before assuming yours does not.
- cwd is load-bearing: manager pins the project root, workers their
  worktree, checks the WORKER'S worktree.
- The evidence adapter (src/adapters/evidence/adapter.ts) is the ONE
  place claims resolve against runs; the UI's badges and the engine's
  scores both come from it. Your claim checklist (layer 4) should
  consume its LinkedClaim output (already served via /api/confidence's
  claimLinks) — do not invent a second linking.
- The visual change map's numstat comes live from git, never from the
  report (architecture §6). collectAuditFiles + LocalGitCommandRunner
  exist; parseNumstat is in core/git/parsers.
- The §9 gold suite (tests/confidence-engine.test.ts) is a SPEC — if
  your work needs an engine change, the scenario changes first, with the
  user.
- karz98rk is NOT reachable and NOT to be ported from (architecture
  §10: intent only, never code).

Load-bearing conventions: tool failures return as tool TEXT; system
turns carry JSON payloads; ordering by rowid; busy flag held through
distillation (workers and monitor are OUTSIDE that lock); honest empty
states; strict TS with noUncheckedIndexedAccess; UI never imports
adapters (route handlers only); monitor facts are deduplicated against
identical OPEN attention items.

Working standard (set by Chunk 1, kept since — keep it): purposeful
commits with explanatory bodies, tests green before every commit, push
to origin, no half-wired surfaces, interrogate the user on anything
ambiguous (the question channel worked in chunk 4 — use it) and stamp
what gets agreed into the docs in the same commit.
```

You are a fresh implementer picking up Galapagos after Chunk 4. Read
`docs/vision.md` and `docs/architecture.md` first — they are binding and
override everything, including this handoff. Then implement
`docs/chunks/5.md`.

## The user's framing: clarity and confidence dictate each other (stated 2026-07-05 — build to this)

A misconception got corrected late in chunk 4, and it reshapes what
chunk 5 is FOR. The user had assumed the confidence bar WAS clarity —
"the agent is confident in the idea and understands what the user wants,
with the context provided." Chunk 4's build made plain it is not: the
gauge is external verification, "outside monitors' fluctuating proof of
the agent's actions." The user's ruling on seeing that: **the proofs and
the clarity of understanding the intended vision go hand in hand — their
success is dictated by each other.** They are coupled concerns, not
separate instruments:

- **Clarity bounds confidence.** Verification quality is capped by brief
  and record quality: the critic judges the diff against the brief and
  the agreed specifics, so a vibes-brief can only ever produce weak
  critique — the gauge of a poorly-briefed worker is structurally less
  meaningful, and that should be VISIBLE. A worker's clarity (does its
  brief cite recorded specifics? do open_question records overlap its
  lane?) belongs in view NEXT TO its confidence gauge — and, pending new
  §9 gold scenarios agreed with the user in-session, as a facts-leg
  input to worker confidence itself.
- **Confidence feeds clarity back.** A critic rejection or a
  contradicted claim is not just a work defect — it is evidence the idea
  was never truly shared. The clarity view should surface fresh
  rejections/contradictions as understanding-gap rows with their
  evidence linked; the natural durable record for a gap is an
  open_question (no new record types).
- **What survives from the old framing:** the gauge still never takes
  confident-sounding prose as input. The coupling flows through records
  and evidence — never through vibes.

## Branch state — read this before writing code (updated 2026-07-05)

- Chunk 2 COMPLETE and merged to main (b40e22e).
- Chunk 3 (`claude/chunk-3-workers-lanes-vl5mh8`) BUILT, awaiting drills.
- Chunk 4 (`claude/chunk-4-monitoring-confidence-mud9n3`) BUILT on top of
  the chunk-3 branch, awaiting drills (runbook:
  docs/chunks/4-verification.md). Chunk-4 fixes land there.
- 178 tests green at handoff. Keep them green before every commit.

## What Chunk 4 added (concrete map)

- `src/core/confidence/{types,engine}.ts` — the PURE engine. Signals
  accumulate, caps clamp (blocking → blocked state, draining flags →
  draining state; low-but-stable is STEADY), every number carries its
  reason. `tests/confidence-engine.test.ts` is the §9 spec.
- `src/adapters/db/repos/evidence.ts` — evidence_runs rows;
  `latestRunsByKey` per scope (worker vs project pools are distinct).
  `head_sha` stores the composite evidence key (see stamp #5).
- `src/adapters/checks/run-checks.ts` — npm-script auto-detected checks,
  sequential, per-run evidence key, concise summary + full log file under
  `<stateDir>/check-logs/`. Exposed as the run_checks tool.
- `src/adapters/evidence/workspace.ts` — `observeWorkspaceEvidence(cwd)`
  → the current evidence key.
- `src/adapters/evidence/adapter.ts` — `linkClaims` (the ONE
  claim-resolution point: fresh pass → verified, fresh fail →
  contradicted, stale → unverified, no run → unsupported, diff claims
  checked against real changed files, manual honest),
  `buildWorkerEvidence` (liveness, lane audit, digest, checks →
  WorkerConfidenceInput), `REQUIRED_ON_COMPLETION` policy.
- `src/adapters/evidence/confidence.ts` — `computeProjectConfidence`:
  the full picture (used identically by UI reads, the monitor, and the
  triage seed — a gauge and a triage decision can never disagree).
- `src/daemon/monitor.ts` — the tick. Injectable clock and triage
  runner; see tests/monitor.test.ts for every behavior.
- `src/adapters/agent/triage.ts` — `buildTriageSeed`,
  `createAskUserBridge` (chat note + queue item), `runTriageJob` (job row
  = trigger cutoff, taken at run END).
- **The three legs** (user-confirmed 2026-07-05; docs/legs/{tripwires,
  watchdog,critic}.md are the deep-dives): `core/legs/` pure halves
  (pattern detection + diff parsing; prompt building + verdict parsing
  with no-quote-no-finding and evidence-anchor rules), `adapters/legs/`
  I/O halves (git diff assembly; single-shot sessions via the shared
  `session.ts`; verdicts persisted as jobs rows keyed to the workspace
  evidence key, found via `latestJobByPayload`). The monitor launches
  watchdog+critic once per completion (re-runs on staleness, one in
  flight per worker per leg, failed runs surface as unavailable and are
  not self-retried); tripwires run inline every tick. integrity_alert is
  the queue kind for tripwire alerts, watchdog gaming/suspicion, and
  critic rejections.
- Manager tools grew: run_checks, list_attention, resolve_attention,
  review_completion, ask_user (triage-only wiring). Doctrine updated.
- UI: `src/ui/confidence.tsx` (gauge + "why N" drilldown),
  `src/ui/attention-queue.tsx` (the loud surface), routes
  /api/confidence, /api/attention, /api/attention/resolve; both pages
  subscribe to monitor_tick/attention_changed/digest_reviewed/
  manager_note stream events.
- New attention kind `worker_failed` (§3 comment updated).
- Config: GALAPAGOS_TRIAGE_MODEL (claude-haiku-4-5),
  GALAPAGOS_MONITOR_INTERVAL_MS (30000), GALAPAGOS_STALE_WORKER_SECONDS
  (300), GALAPAGOS_CHECK_TIMEOUT_MS (600000).

## Conventions established in Chunk 4 — follow them

1. **Claims resolve in exactly one place** (evidence adapter). Layer-4
   claim badges consume LinkedClaim; never re-derive.
2. **Evidence freshness is key equality.** Any commit or edit staleness
   the evidence; drills and gauges rely on this.
3. **Monitor facts are deduplicated, never rewritten** — identical open
   fact = no new row; changed fact = new row; supported claims
   auto-resolve with the reason recorded.
4. **Required-ness lives where completion claims live** (workers, on
   digest existence, configured scripts only). Project-level runs are
   informative.
5. **Triage acts, then stops**: resolve with evidence, steer answers the
   records hold, escalate direction calls with a recommendation; its own
   ask_user items never retrigger it.
6. **States mean things**: blocked = standing trust-critical failure,
   draining = actively leaking (flags, not bands), steady covers
   low-but-stable honestly.

## Known open items (do not silently fix; coordinate)

- Chunks 2, 3 AND 4 live verification pending. Chunk 4's stamp carries
  one flagged interpretation: required checks were read as
  typecheck/test/build from the user's "triage, test and build" — get
  it confirmed or overturned during drills.
- Manager/distill sessions still load filesystem settings (chunk-3
  niggle; triage deliberately does NOT — settingSources: []).
- Non-npm projects report all checks "not configured" — an override
  mechanism is deliberately unbuilt.
- The monitor's main-checkout baseline is in-memory: a daemon restart
  re-baselines, so a mutation exactly spanning a restart can slip the
  watch. Documented, accepted.
- `/api/workers/detail` still returns the full event log per fetch
  (chunk-3 flag, unchanged); /api/confidence recomputes per request
  (git observation per worker) — fine at current scale, revisit if
  worker counts grow.
- Decision checkpoints/tags (architecture §8) and the bloodline remain
  unbuilt — chunk 6.

## The working standard (unchanged since Chunk 1 — keep it)

Purposeful commits with explanatory bodies; tests green before every
commit; push to origin; no half-wired surfaces; interrogate the user
before building anything ambiguous and stamp what gets agreed into the
docs in the same commit. When the user makes a call in chat, stamp it
user-confirmed in the relevant doc.
