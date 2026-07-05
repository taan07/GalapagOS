# BUG-004 — The turn loop, distillation, and daemon HTTP layer have zero automated coverage

- **Severity:** medium (test-coverage gap on the highest-risk code)
- **Status:** open
- **Where:** `src/adapters/agent/manager-session.ts` (`runManagerTurn`),
  `src/adapters/agent/distill.ts`, `src/daemon/main.ts`

## Defect

The 66-test suite thoroughly covers the pure core and the storage adapters —
the code least likely to break. The most complex, most failure-prone logic has
no tests at all:

- `runManagerTurn` is a ~200-line state machine: resume-mismatch detection and
  abort, compact-and-rebrief (turn deletion + session swap + re-prompt),
  auth-error turn rollback (`resultWasError` → `deleteTurns`), interrupt
  handling, the single-retry path, sdk-session-id bookkeeping.
- `runDistillJob`: fork options, records-written counting, commit-regardless
  semantics, abort-during-distill.
- Daemon handlers: busy-flag lifecycle, the two-phase AbortController swap,
  clear-rebrief validation chain.

All of it is verified only by one-time manual drills. Every behavior here also
depends on Agent SDK stream semantics (init/assistant/result message shapes)
pinned to `"latest"` (see BUG-005) — the exact combination most likely to
regress silently.

## Symptoms if left unfixed

- An SDK behavior change (message shape, resume semantics, error subtypes)
  breaks the recovery paths and nothing catches it until a live turn eats it —
  likely mid-conversation, as a lost turn, a duplicated user message, or a
  silently blank Darwin.
- Chunks 3–6 all extend this layer (workers reuse the same stream-consumption
  pattern). Each chunk's implementer edits untested code holding invariants
  documented only in handoff prose ("auth-errored turns never persist", "one
  manager turn per project"). Regression risk compounds per chunk.
- The manual drill list grows superlinearly: every fix here re-obligates a
  human evening of drills that a fake-stream test would cover in milliseconds.

## Fix sketch

`query` is imported at module top — inject it (or wrap it in a seam) so tests
can supply a scripted async-iterable emitting canned init/assistant/result
messages. Then encode the drills as unit tests: happy turn, resume-mismatch →
rebrief → retry, auth error → turns deleted + no retry, interrupt → turns kept
+ session resumable, lost-pointer-with-history → upfront compaction. Same seam
serves worker-session tests in Chunk 3.
