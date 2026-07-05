# Handoff — Chunk 4 (Monitoring, evidence, confidence)

## Kickoff prompt (paste this to the implementing agent verbatim)

```
Chunk 4 — Monitoring, evidence, confidence (the system grows judgment)

Repo: ~/Dev/galapagos (github.com/taan07/GalapagOS). Chunk 2 is MERGED to
main (merge commit b40e22e; its branch is deleted). Chunk 3 lives on
claude/chunk-3-workers-lanes-vl5mh8, rebased directly onto main — check
whether it has merged before branching: if yes, create
claude/chunk-4-monitoring from main; otherwise stack it on the chunk-3
branch. Never commit Chunk 4 code to earlier chunks' branches; chunks are
verified and merged independently. Start by reading docs/handoffs/chunk-4.md
(your handoff), then docs/vision.md and docs/architecture.md — the binding
contracts that override everything else, including this prompt. Then
implement docs/chunks/4.md.

State you inherit — Chunks 1 and 2 COMPLETE (verified live 2026-07-04 and
2026-07-05; stamps in docs/chunks/1.md and 2.md). Chunk 3 BUILT, awaiting
the user's live drills (stamp in docs/chunks/3.md, runbook in
3-verification.md; if the user reports chunk-3 issues mid-work, fixing them
comes FIRST, on the chunk-3 branch, then rebase your stack — same for any
chunk-2 regression, which lands on main). Standing: daemon :4517 owns all
Agent SDK sessions (startup line + GET /health report git revision and
branch — ALWAYS verify which code is running before diagnosing); web
UI :3005 (pages /, /workers, /records); central SQLite at
~/.galapagos/state.db — projects, manager_sessions, manager_turns, jobs,
lanes, workers, worker_events, completion_digests, attention_items (you ADD
evidence_runs per architecture §3); per-project records in each target
repo's docs/galapagos/; Darwin's tools: git_truth, record_specific,
list_specifics, read_records, write_record, update_record, spawn_worker,
resume_worker (continue stopped work in the same worktree — user-confirmed
ruling), steer_worker, stop_worker, list_workers, worker_status; workers run in
worktrees under <GALAPAGOS_STATE_DIR>/worktrees/<project-slug>/<lane-slug>/
on branches galapagos/worker/<lane-slug>, streaming-input query() with
canUseTool lane guard (preventive; Bash bypass documented), every message
persisted to worker_events, completion digests parsed (hybrid timing —
stamped in docs/chunks/3.md), lane-check at stop raising lane_violation/
unstructured_completion/check_failed attention rows, boot reconciliation
for orphaned workers. 116/116 tests green via npm test.

Chunk 4 in one line: the monitor loop (30s daemon tick, ZERO LLM calls —
staleness, lane audit, evidence freshness, unsupported-claims scan), the
check runner writing evidence_runs keyed to worktree head_sha (run_checks
manager tool), the PURE confidence engine implementing architecture §9's
gold scenarios exactly (caps that positives cannot overcome, every score
explaining itself), the evidence adapter linking digest claims to runs, the
attention queue UI (the one loud surface, resolve/dismiss), event-driven
triage on a fork/fresh session with GALAPAGOS_TRIAGE_MODEL (default
claude-haiku-4-5) — clean completions auto-reviewed, only failures/
contradictions/direction calls escalate — and confidence gauges on / and
/workers. Forbidden: per-tick LLM calls, triage on Darwin's main session,
new record types, default sub-bars, confidence from confident-sounding
prose.

Operational facts that will save you hours:
- Auth is keychain-bound on the user's machine. Every session spawns
  through src/adapters/agent/spawn.ts. npm test runs anywhere; the user
  runs live drills. (The Chunk 3 build sandbox DID have working SDK auth —
  yours might too; a quick real-worker smoke via the daemon API is worth
  trying before assuming otherwise.)
- cwd is load-bearing: manager pins the project root, workers their
  worktree, checks must run in the WORKER'S worktree.
- SDK permission facts (verified, load-bearing): dontAsk never consults
  canUseTool; an allowedTools entry bypasses canUseTool for that tool;
  omitted settingSources loads the target repo's .claude/settings.json.
  Workers therefore run permissionMode "default" + settingSources: [],
  deny-by-default outside their fixed tool surface (WebFetch allowlisted,
  user-confirmed; WebSearch/Task denied).
  Known open niggle: manager/distill sessions still load filesystem
  settings — a target repo's allow rules could widen their surface.
- karz98rk is NOT reachable and NOT to be ported from (architecture §10:
  intent only, never code). The §9 gold-scenario list IS the engine spec —
  sharpen ambiguities with the user, don't guess.
- Load-bearing conventions: tool failures return as tool TEXT; system turns
  carry JSON payloads; hasHistory counts only non-system turns; ordering by
  rowid; busy flag held through distillation (workers are OUTSIDE that
  lock); honest empty states; strict TS with noUncheckedIndexedAccess.

Working standard (set by Chunk 1, kept since — keep it): purposeful commits
with explanatory bodies, tests green before every commit, push to origin,
no half-wired surfaces, interrogate the user on anything ambiguous and
stamp what gets agreed into the docs in the same commit.
```

You are a fresh implementer picking up Galapagos after Chunk 3. Read
`docs/vision.md` and `docs/architecture.md` first — they are binding and
override everything, including this handoff. Then implement
`docs/chunks/4.md`.

## Branch state — read this before writing code (updated 2026-07-05)

- Chunk 2 is COMPLETE (all live drills passed) and MERGED to main at
  b40e22e; its branch is deleted. Chunk-2-surface fixes now land on main.
- Chunk 3 (`claude/chunk-3-workers-lanes-vl5mh8`) is REBASED directly onto
  main (merge-base == main's tip) and BUILT, awaiting the user's live
  drills. Chunk-3 fixes land on that branch; rebase your stack after.
- Post-rebase additions on the chunk-3 branch beyond the original build:
  triple-Esc turn interrupt, distill restraint (unaccepted proposals →
  open_question), daemon identity (rev/branch in startup line + /health),
  workers defaulting to claude-opus-4-8 at high effort (user-confirmed).
- 116 tests green at handoff (`npm test` = typecheck + `node --test` on
  `dist-node/tests`). Keep them green before every commit.

## What Chunk 3 added (concrete map)

- `src/core/lanes/lane-check.ts` — pure: `checkLane(files, contract)` →
  violations (forbidden wins, dot:true, path normalization);
  `findLaneOverlap` (conservative glob-vs-glob base-dir comparison, exact
  for literals). The monitor's lane audit should reuse `checkLane` and
  `collectAuditFiles` — do not reimplement.
- `src/core/digests/completion.ts` — pure parser for the fenced
  `galapagos-completion` block: parsed | missing | malformed(problems),
  evidence kinds validated (`typecheck|lint|test|build|diff|manual`).
- `src/adapters/db/repos/{lanes,workers,digests,attention}.ts` — rows +
  queries: active lanes, live-status workers, latest digest per worker,
  open/worker-scoped attention. `resolveAttentionItem` exists for your
  queue UI. worker_events kinds include `steer`.
- `src/adapters/git/mutating-runner.ts` — `addWorktree`/`removeWorktree`
  behind a placement guard (under `<stateDir>/worktrees/`, never inside the
  target repo; guard violations throw). `workerWorktreePath()` is the
  canonical path builder.
- `src/adapters/agent/worker-session.ts` — the ONLY module that knows the
  SDK runs workers: message-queue streaming input, `workerCanUseTool`
  (pure, tested), normalized `WorkerStreamEvent`s.
- `src/adapters/agent/worker-runtime.ts` — daemon-side orchestration:
  `createWorkerRuntime({db, config, sessionFactory?, broadcast?})` →
  spawn/resume/steer/stop/list/status/reconcileOrphans. `collectAuditFiles`
  (diff base...HEAD ∪ porcelain -uall) lives here — your monitor tick
  wants it. Tests inject a fake sessionFactory; yours can too.
- `src/adapters/agent/worker-doctrine.ts` — the worker system prompt (lane
  echoed, completion contract, honest evidence labels).
- Daemon routes: `POST /workers`, `POST /workers/:id/steer`,
  `POST /workers/:id/stop`; `GET /events` broadcasts `worker_event` and
  `worker_status`. UI reads via `/api/workers`, `/api/workers/detail`,
  SSE proxy `/api/events`.
- `/workers` page: list + drilldown, live stream, digest card, attention
  rows, and a user-confirmed Stop escape hatch (spawn/steer stay
  chat-only). Your gauges and attention queue extend these surfaces.
- Config: `GALAPAGOS_WORKER_MODEL` (default claude-opus-4-8) and
  `GALAPAGOS_WORKER_EFFORT` (default high) — user-confirmed 2026-07-05.

## Conventions established in Chunk 3 — follow them

1. **Completion-report timing is hybrid** (stamped in docs/chunks/3.md):
   malformed block → immediate attention; absent block mid-run → nothing;
   no digest at stop → attention + not done. Your completion-claims scan
   builds on digests, not raw transcripts.
2. **Worktrees survive stop** — they are the work product. Nothing deletes
   them except failed-spawn cleanup.
3. **Attention rows are append-only facts**; `check_failed` is used when a
   safety step itself could not run (never skip silently — vision).
4. **A failed worker stays failed** — stop is not recovery. Auth-errored
   worker turns are never retried on fresh sessions.
5. **Live session handles are the only in-memory state**; every streamed
   event persists as it lands; boot reconciliation covers restarts.

## Known open items (do not silently fix; coordinate)

- Chunks 2 AND 3 live verification pending (2-verification.md,
  3-verification.md). The Chunk 3 stamp lists implementer decisions the
  user has not yet ruled on — if a ruling changes behavior, that fix goes
  on the chunk-3 branch.
- No proactive context-size compaction trigger (stamped in chunk 2).
- Manager/distill sessions load filesystem settings (see SDK facts above).
- Records written during a turn whose distill commit was skipped sit
  uncommitted until the next successful commit — documented, surfaced.
- **The detective audit never observes the target repo's main checkout.**
  It diffs the WORKTREE against the lane base; a worker using Bash with
  absolute paths could mutate the project's primary checkout undetected
  and the stop audit would report clean. The chunk-4 monitor is the right
  place to close this (e.g. fingerprint the target repo's dirty state per
  tick and attribute unexplained changes) — coordinate the design with the
  user; naive porcelain-diffing false-positives on the user's own edits.
- `/api/workers/detail` returns the full event log and the board refetches
  it on every status flip — fine at current scale, needs a rowid cursor if
  workers grow long-lived (flagged in review, deliberately not built).

## The working standard (unchanged since Chunk 1 — keep it)

Purposeful commits with explanatory bodies; tests green before every
commit; push to origin; no half-wired surfaces; interrogate the user before
building anything ambiguous and stamp what gets agreed into the docs in the
same commit. When the user makes a call in chat, stamp it user-confirmed in
the relevant doc.
