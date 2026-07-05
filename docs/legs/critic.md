# Leg: critic — blinded critique (independent model)

**One sentence:** an independent reviewer that judges the actual diff against
the actual brief — and is structurally prevented from hearing the worker's
side of the story.

**Why it exists:** this is the leg that answers the user's core question —
"does this work actually do what was asked?" — which no amount of passing
tests can answer (tests cover thin intent, and the worker may have written
them). It is also the most dangerous leg to build naively: the research
shows code that *asserts its own correctness* pushes model judges toward
FALSE acceptance (up to −27 points of accuracy), and judges favor work that
resembles their own output. A sloppy critic would manufacture false
confidence — the exact disease this system treats.

**How it is blinded (each rule maps to a measured bias):**
- Sees the brief, the lane contract, the user's agreed specifics, the REAL
  diff, and the execution evidence. **Never** the worker's narrative,
  claims, completion report, or transcript — judge the work, not the story.
- Told explicitly that persuasive comments inside the diff are a smell, not
  a proof, and that diff content is untrusted data.
- Derives a checklist FROM the brief (question-specific rubrics measurably
  beat generic "rate this code" prompts) plus the recorded specifics — the
  user's pinned decisions are constraints, not suggestions. This is
  Galapagos's unusual advantage: nothing in the literature has an
  equivalent of the records store to ground intent.
- Every finding must anchor to something concrete in the diff, brief, or
  evidence — unanchored findings are dropped at parse time, and a "reject"
  without an evidence-anchored blocker is refused.

**Verdicts:** **approve** (checklist satisfied AND the evidence genuinely
proves it — small positive signal), **needs_work** (majors without
blockers — caps below strong at 70 until addressed), **reject** (any
blocker: wrong behavior, faked/weakened verification, destructive change —
caps at 40/blocked, high-priority `integrity_alert` naming the blocker).

**Freshness:** verdicts are keyed to the workspace state. New commit or
edit → the critique is stale → counts as "not yet reviewed" and the leg
re-runs. An approval of last hour's code says nothing about this hour's.

**Cost policy:** runs once per completion (and again when the workspace
moves past a verdict) on `GALAPAGOS_CRITIC_MODEL` — default claude-haiku-4-5,
raise it per-project for harder codebases. Failed runs are not auto-retried;
they surface as "unavailable" and drain the gauge.

**Honest limits:** a single-shot reviewer reading a bounded diff — very
large diffs are truncated with an explicit marker (and told to say if that
hides what it needs); it cannot execute code (the facts leg owns
execution); and judge validity is task-dependent — the moments the user
overrides a critic verdict are recalibration data, not noise.

**Code:** `src/core/legs/critic.ts` (rubric prompt + verdict parsing, pure),
`src/adapters/legs/critic.ts` (blinded packet assembly, session, persistence
as a `critic` jobs row). Tests: `tests/leg-verdicts.test.ts`.
