# Handoff — Chunk 3 (Workers + lanes)

You are a fresh implementer picking up Galapagos after Chunk 2. Start by
reading `docs/vision.md` and `docs/architecture.md` — they are the binding
contracts and override everything else, including this handoff. Then
implement `docs/chunks/3.md`. Consult the Claude Agent SDK docs
(code.claude.com/docs/en/agent-sdk) for streaming-input `query()` and
`canUseTool` — never guess SDK APIs.

## Branch state — read this before writing code

- **Base your work on `claude/chunk-2-durable-memory-w3g1cs`**, not `main`.
  Chunk 2 lives there and is NOT yet merged. If it has merged into `main` by
  the time you start, base on `main` instead — check first.
- Chunk 2's stamp is **BUILT, awaiting the user's live verification** (see
  the stamp in `docs/chunks/2.md` and the drill list in
  `docs/chunks/2-verification.md`). The user may report Chunk 2 issues while
  you work; fixes to Chunk 2 surfaces take priority over new Chunk 3 code —
  the product is a spine, not a pile of features.
- All 66 tests green at handoff (`npm test` = typecheck + `node --test` on
  compiled `dist-node/tests`). Keep them green before every commit.

## What you inherit (Chunks 1–2, concrete map)

**Chunk 1 (verified live):** daemon on :4517 (`src/daemon/main.ts`), Next UI
on :3005, central SQLite `~/.galapagos/state.db`
(`GALAPAGOS_STATE_DIR` override), projects/manager_sessions/manager_turns/
jobs tables, project registration (native chooser + create-from-name),
Darwin chat end-to-end, `git_truth`, resume proven.

**Chunk 2 (built):**

- `src/core/records/` — `frontmatter.ts` (pure parse/serialize),
  `schema.ts` (8 glp_types, per-type open statuses, global closed statuses
  `resolved|done|approved|superseded|archived`, decision validation),
  `rebrief.ts` (pure re-brief preamble builder).
- `src/adapters/records/` — `store.ts` (`RecordsStore`: wx creates into
  `<project.root_path>/docs/galapagos/<type-dir>/`, list/get/update with
  status-lifecycle validation), `ingest.ts` (idempotent vault import),
  `write-through.ts` (record + vault mirror).
- `src/adapters/git/mutating-runner.ts` — `commitRecords()`: the ONLY
  mutating-git surface so far. Stages/commits ONLY `docs/galapagos/` paths
  (pathspec commit — user-staged files provably survive untouched), skips
  with a surfaced reason mid-merge/rebase. **Chunk 3 extends mutating git
  only as far as `worktree add`/`worktree remove` under
  `<GALAPAGOS_STATE_DIR>/worktrees/<project-slug>/<lane-slug>/` — never
  inside target repos.**
- `src/adapters/agent/spawn.ts` — `baseQueryOptions()`: EVERY `query()` goes
  through this (keychain-bound auth via `pathToClaudeCodeExecutable`,
  explicit cwd, optional resume/forkSession). Worker sessions must use it
  too.
- `src/adapters/agent/manager-tools.ts` — the in-process
  `createSdkMcpServer` with `git_truth`, `record_specific` (write-through),
  `list_specifics`, `read_records`, `write_record`, `update_record`. Tools
  receive a `ManagerToolContext` and emit `{tool, summary, detail}` events
  that the session layer persists as tool turns and streams as UI chips.
  Extend this pattern for `spawn_worker`/`steer_worker`/`stop_worker`/
  `list_workers`/`worker_status`. Record-tool failures return as tool TEXT
  (so the model self-corrects), not thrown errors.
- `src/adapters/agent/manager-session.ts` — turn loop with
  compact-by-re-brief. Returns `ManagerTurnOutcome` so the daemon can run
  post-turn distillation.
- `src/adapters/agent/distill.ts` — post-turn fork
  (`resume` + `forkSession: true`), model `GALAPAGOS_DISTILL_MODEL`
  (default `claude-haiku-4-5` — user-confirmed choice), records-only tools,
  nothing persisted from the fork, then `commitRecords`.
- `src/adapters/db/repos/jobs.ts` — queued/running/done/failed job rows.
- UI: `/records` browser (source-attributed fields), re-brief chip with
  clear-to-blank, specifics side panel still live via write-through.

## Conventions established in Chunk 2 — follow them

1. **System turns carry JSON payloads.** `manager_turns.role='system'`
   content is `{kind: "rebrief"|"note", ...}`; the UI parses and falls back
   to plain text. Add new kinds rather than new formats.
2. **`hasHistory` counts only non-system turns** in `manager-session.ts`.
   This is load-bearing: a deliberately blanked session (user cleared a
   re-brief) contains a system note and must NOT trigger another
   records-seeded re-brief. Don't regress it.
3. **Cross-session history orders by `rowid`** (insertion), not timestamps —
   same-millisecond writes across a compaction boundary tie on `created_at`.
4. **The busy flag + SSE stream are held through distillation** so the
   manager session is never forked concurrently with a new user turn. Worker
   sessions are independent of this lock — but daemon-side, one manager turn
   per project at a time stays the rule.
5. **Auth-errored turns never persist as conversation and never trigger
   fresh-session retries** (`resultWasError` path in manager-session.ts).
   Apply the same rule to worker sessions.
6. **Honest empty states everywhere**: empty store says "no records yet",
   re-brief with no records says "blank slate". Workers UI must do the same
   (no fabricated liveness).
7. Strict TS with `noUncheckedIndexedAccess` — index access needs guards.
   `npm test` compiles tests via `tsconfig.node.json`; fixture repos are
   `mkdtempSync` + `git init` (see `tests/records-store.test.ts`).

## Operational facts (paid for in Chunks 1–2 — do not rediscover)

- **Auth is keychain-bound.** Live sessions authenticate only when the
  daemon runs from the user's own terminal. Build and `npm test` anywhere;
  the USER runs live drills. Do not burn time debugging "Not logged in"
  from an agent shell.
- **cwd is load-bearing.** Manager pins the project root; workers pin their
  worktree. Never spawn without an explicit cwd.
- **The karz98rk reference repo is NOT reachable** from remote/agent
  environments, and the user has explicitly said ground-up implementation is
  preferred over porting from it ("didn't want the code from that failed
  messy project to contaminate galapagos"). Where architecture §10 says
  "port", treat it as "implement to the documented behavior with equivalent
  tests".
- SDK facts verified in code: session id arrives on the init message and on
  every result; `forkSession: true` exists on Options; breaking out of the
  stream + `interrupt()` aborts a query (used for the resume-mismatch
  path).

## Known open items (do not silently fix; coordinate)

- **Chunk 2 live verification pending** — `docs/chunks/2-verification.md`.
- **No proactive context-size compaction trigger.** Compact-by-re-brief
  fires only on lost/failed resume. The agreed future fix (needs a schema
  amendment for per-session context size fed by SDK usage) is stamped in
  `docs/chunks/2.md`. Chunk 3 does not need it; don't build it ad hoc.
- Records written during a turn whose distill commit was skipped (e.g.
  mid-merge) sit uncommitted until the next successful distill commit —
  documented behavior, surfaced in chat when it happens.

## The working standard (set in Chunk 1, kept in Chunk 2 — keep it)

Purposeful commits with explanatory bodies; tests green before every
commit; push to origin; no half-wired surfaces — a page/tool/table ships
with the real data that feeds it or not at all. Interrogate the user for
specifics before building anything ambiguous, and record what gets agreed
in the chunk docs — the product's defining behavior applies to building
the product. When the user makes a call in chat (model choice, UX
behavior), stamp it user-confirmed in the relevant doc in the same commit.

## Chunk 3 in one line

Give Darwin hands: lane-scoped workers in state-dir worktrees
(`spawn_worker`/`steer_worker`/`stop_worker` via streaming-input `query()`),
every streamed message persisted to `worker_events`, the fenced
`galapagos-completion` report parsed into `completion_digests` (missing →
`unstructured_completion` attention row, never rendered done), lane-check
run at worker stop, and a `/workers` page with live streams — per
`docs/chunks/3.md`, which also lists the new tables, the overlap-rejection
rule, `GALAPAGOS_WORKER_MODEL`, and the forbidden list (no monitor loop, no
confidence engine, no triage, no worktrees inside target repos, no worker
without a lane contract).
