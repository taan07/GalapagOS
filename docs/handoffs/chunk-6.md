# Handoff — Chunk 6 (Decision bloodline + checkpoints)

## Kickoff prompt (paste this to the implementing agent verbatim)

```
Chunk 6 — Decision bloodline + checkpoints (wrong turns become cheap)

Repo: ~/Dev/galapagos (github.com/taan07/GalapagOS). START GATE — verify
before writing any code: chunk 3 (claude/chunk-3-workers-lanes-vl5mh8,
including its post-drill fixes) and the manager-brief-worker-quality
track must BOTH be merged to main. Check with git fetch origin && git log
--oneline origin/main. If either is unmerged, STOP and tell the user —
starting early means building on surfaces two other sessions are still
changing. Once the gate passes: create and work on
claude/chunk-6-decision-bloodline from main. The chunk-4 branch
(claude/chunk-4-monitoring-confidence-*) may still be in flight — do NOT
touch its surfaces (monitor, checks, confidence engine, attention-queue
UI, evidence adapter) and expect mutual rebases; keep commits clean.
Chunk 5 (clarity/digest UI) is deliberately sequenced AFTER you — do not
build any of it.

Start by reading docs/handoffs/chunk-6.md (your handoff), then
docs/vision.md and docs/architecture.md — the binding contracts that
override everything else, including this prompt (§8 is your spec; §4 the
decision-record contract; the vision's "bloodline" section the product
intent). Then implement docs/chunks/6.md. Study before writing:
src/core/records/schema.ts (decision validation already enforces
decision_options/rollback_note/confidence_impact on create and
chosen_path before close — you extend, never fork, this),
src/adapters/records/store.ts (create/update mechanics),
src/adapters/git/mutating-runner.ts (THE pattern you extend: narrow
allowlisted mutations — commitRecords pathspec-commits only
docs/galapagos/; addWorktree/removeWorktree live behind a placement
guard under <GALAPAGOS_STATE_DIR>/worktrees/ — you add exactly
checkpoint-commit and tag in the same style),
src/adapters/agent/manager-tools.ts (write_record — your trigger point),
and the /records and /workers pages for UI conventions.

State you inherit (all verified live unless noted): daemon on :4517 owns
all Agent SDK sessions, startup line + GET /health report git revision
and branch — ALWAYS verify which code is running before diagnosing (a
stale daemon once ate an hour of drills). Web UI :3005: /, /records,
/workers (+ /clarity is chunk 5's, /decisions is YOURS). Central SQLite
~/.galapagos/state.db: projects, manager_sessions, manager_turns, jobs,
lanes, workers, worker_events, completion_digests, attention_items
(chunk 4 adds evidence_runs; you add NO tables — the bloodline derives
from records ONLY, no decisions table, forbidden by architecture §3).
Per-project records store in each target repo's docs/galapagos/ (8
glp_types, wx creates, closed statuses only via update, distill fork
auto-commits under galapagos(records): with narrow staging). Darwin's
tools: git_truth, record_specific, list_specifics, read_records,
write_record, update_record, spawn_worker (structured briefs:
deliverables/done_criteria/out_of_scope/context_refs — from the
brief-quality track), steer_worker, stop_worker, list_workers,
worker_status. Workers: worktrees under
<GALAPAGOS_STATE_DIR>/worktrees/<project-slug>/<lane-slug>/, branches
galapagos/worker/<lane-slug>, Opus 4.8 at high effort (user-confirmed).
Take the test count from npm test on your base — keep the full suite
green before every commit.

Chunk 6 in one line: write_record(type=decision) triggers the checkpoint
mechanism — (1) target ref = the relevant worker's worktree HEAD for
worker-scoped decisions or the project's main HEAD for direction-level
ones; (2) dirty tree → WIP commit "galapagos: pre-decision checkpoint
<id>", and if that commit FAILS → git_checkpoint_status: blocked_dirty +
an attention item (kind check_failed — chunk 3's convention: a safety
step that could not run is surfaced, never skipped silently); (3) git
tag galapagos/decision/<shortid> <sha> in the TARGET repo; (4) record
written with git_checkpoint_ref + parent_decision_ref = current tip
decision of that line (nullable only for roots), record file committed
under the chunk-2 narrow-staging rules. Then: core/decisions/tree.ts —
pure graph builder, decision records → nodes/edges via
parent_decision_ref, forks visible, unit-tested with orphan/fork/
multi-root cases. /decisions page — the bloodline as its own calm page:
each node shows title, chosen_path, date, checkpoint status; readable at
a glance; matches existing UI conventions (CSS variables in globals.css,
honest empty state for a project with no decisions yet). LAST — build
this only after everything above is green: resume-from-node — node
action → git worktree add <GALAPAGOS_STATE_DIR>/worktrees/
<project-slug>/resume-<shortid> -b resume/<slug>
galapagos/decision/<shortid>, a new lane, a worker if requested, and a
CHILD decision record pointing at the resumed node so the bloodline
visibly forks.

Schema upgrade that is yours: architecture §4 makes git_checkpoint_ref
REQUIRED on decision records — chunk 2 deliberately deferred that to
you. Flip it: the checkpoint mechanism (not Darwin) supplies
git_checkpoint_ref/git_checkpoint_status/parent_decision_ref, and
validation now rejects a decision record missing its checkpoint ref
unless status is blocked_dirty. Update the chunk-2 schema tests
accordingly — additively, without weakening any existing rule.

USER RULINGS — interrogate BEFORE building, stamp each user-confirmed in
docs/chunks/6.md in the same commit: (1) how a decision is born in chat —
Darwin proposes options as an open_question (brief-quality rule: an
unaccepted proposal is never a decision) and the user's pick converts it
to a decision record with chosen_path, or does the user dictate
decisions explicitly? Define the exact conversational flow. (2) How is
"the relevant worker" determined for target-ref selection — explicit
worker reference in the decision, or Darwin's judgment with the choice
echoed in the record? (3) Where does resume-from-node live — a button on
the /decisions node (Stop-button precedent from /workers: UI actions for
irreversible-ish operations exist, spawn/steer stay chat-only), chat
command to Darwin, or both? (4) Does resuming auto-spawn a worker or
just materialize the worktree+lane and wait?

Forbidden (architecture + brief): force-pushes, tag deletion, history
rewriting, a decisions table in SQLite, worktrees inside target repos,
auto-decisions (every node originates from the user or a user-approved
proposal), touching chunk-4 or chunk-5 surfaces, new record types.

Exit criterion: user makes a decision in chat → tag exists in the target
repo and the node appears on /decisions; user resumes from an earlier
node → a worktree/branch materializes under the state dir, a lane (and
worker if requested) starts there, and the bloodline shows the fork.
Then the FINAL overall drill across all chunks (docs/chunks/6.md lists
it): goal → two non-overlapping workers → one goes stale → a triaged
question reaches the user → a decision → a resume from an earlier node —
every step observable in the UI with sourced data, every target repo
clean apart from docs/galapagos/ and its own checkpoint history. Write
docs/chunks/6-verification.md as a practical drill runbook (follow the
3-verification.md style) so the user can run acceptance the same way as
prior chunks.

Verification bar: npm test green with new suites — checkpoint
integration tests on fixture repos (clean tree, dirty tree → WIP commit,
dirty tree where the WIP commit itself fails → blocked_dirty + attention
row, tag collision → suffixed or rejected LOUDLY, never overwritten),
pure tree-builder tests, resume worktree placement-guard tests. The
mutating-git additions must carry the same tests-first discipline as
commitRecords (user-staged files outside docs/galapagos/ provably
survive) — those regression cases exist in tests/mutating-runner.test.ts;
extend them.

Operational facts that will save you hours: auth is keychain-bound —
build and npm test anywhere; the USER runs live drills from their own
terminal; don't burn time on "Not logged in" from an agent shell. Every
session spawns through src/adapters/agent/spawn.ts; cwd is load-bearing.
karz98rk is intent-only, NEVER code (architecture §10). Load-bearing
conventions: tool failures return as tool TEXT so the model
self-corrects; system turns carry JSON payloads; ordering by rowid;
honest empty states everywhere; strict TS with noUncheckedIndexedAccess;
attention rows are append-only facts; worktrees survive stop — nothing
deletes them except failed-spawn cleanup (your resume worktrees follow
the same rule).

Working standard (unchanged since Chunk 1 — keep it): purposeful commits
with explanatory bodies, tests green before every commit, push to
origin, no half-wired surfaces — a page ships with the real data that
feeds it or not at all (your /decisions page ships in the same chunk as
the checkpoint mechanism that feeds it, exactly as designed).
Interrogate the user on anything ambiguous and stamp what gets agreed
into the docs in the same commit — the product's defining behavior
applies to building the product.
```

## Notes for the human coordinating sessions

- This chunk is gated on chunk 3 (+fixes) AND manager-brief-worker-quality
  merging to main. Chunk 4 may run concurrently — surfaces are disjoint by
  design; expect rebases in shared central files (daemon, globals.css).
- Chunk 5 remains last: its digest/clarity UI consumes chunk 4's evidence
  AND renders decisions/briefs richer once this chunk and the brief track
  exist. Do not start it before chunk 4 merges.
- After chunk 6 merges and its drills pass, the final overall drill (all
  chunks together) is the project's acceptance test — schedule real time
  for it.
