# Galapagos Architecture Contract

This document is the binding technical contract for all implementation chunks.
If a chunk brief conflicts with this document, this document wins. Read
`docs/vision.md` first for product intent.

Implementers: consult the Claude Agent SDK documentation (docs.claude.com,
Agent SDK section) for `query()`, `createSdkMcpServer`, `tool()`, `canUseTool`,
streaming input, and session resume. Do not guess SDK APIs from memory.

## 1. Process shape

Three processes, one machine, no cloud:

- **Next.js UI** — disposable. Restarts constantly in dev. Holds no state.
- **Daemon** (`src/daemon/main.ts`) — long-lived node process on localhost
  **:4517**. Owns ALL Agent SDK subprocesses (manager and workers). Small API:
  `POST /manager/message` (SSE reply), `POST /workers`, `POST /workers/:id/steer`,
  `POST /workers/:id/stop`, `GET /events` (SSE), `GET /health`.
- **SQLite** — the single operational store, at **`~/.galapagos/state.db`**
  (user-level, central; override dir with `GALAPAGOS_STATE_DIR`). Galapagos is
  multi-project from Chunk 1: a `projects` table is the registry, every other
  table is scoped by `project_id`, and the UI carries a project picker plus an
  Add-project flow (which offers one-click `git init` for non-git projects —
  Galapagos never manages a project without history). Every streamed message,
  job, heartbeat, and attention item is persisted as it lands. Nothing
  state-bearing lives in module-level memory; the daemon can be killed at any
  moment and lose nothing durable.

Reads go straight to SQLite (Next route handlers open the db read-only);
commands and live streams go through the daemon.

**Durable memory** is separate from operational state: git-committed markdown
records at `docs/galapagos/` in the target repo (section 4).

**Interim memory (Chunk 1 → 2 bridge): agreed specifics in Obsidian.** Until
the records store lands, every answer the user gives Darwin is written as one
markdown file to `<GALAPAGOS_VAULT_PATH>/Galapagos/<project-slug>/specifics/`
(vault default: `/Users/taan/Documents/Obsidian Vault`). Filenames are
date-prefixed kebab-case; frontmatter carries `glp_type: agreed_specific`,
`question`, `answer` (summary — full answer in the body), `project`, `status`
(`agreed | superseded | deferred`), `created_at`. Chunk 2's records store MUST
ingest these files (mapping them onto `user_answer`/`routed_clarification`
records) rather than starting memory from zero. Writes use the wx flag and a
resolve-inside-vault guard.

## 2. Module boundaries

```
src/core/       PURE. No fs, no child_process, no React, no SQLite. Unit-tested.
                confidence/engine.ts, confidence/types.ts,
                clarity/view-model.ts, records/schema.ts,
                records/frontmatter.ts, lanes/lane-check.ts,
                git/parsers.ts, decisions/tree.ts, digests/assemble.ts
src/adapters/   I/O, thin over core. db/ (better-sqlite3 repos, schema.sql),
                records/store.ts, git/runner.ts (read-only) +
                git/mutating-runner.ts (commit, tag, worktree add),
                agent/manager-session.ts, agent/worker-session.ts,
                agent/manager-tools.ts, checks/run-checks.ts
src/daemon/     main.ts (HTTP+SSE), monitor.ts (interval loop)
src/server/     Next route handlers only: read SQLite/records, proxy to daemon
src/ui/         React components/hooks
src/app/        Next app router pages: / (chat+overview), /workers, /clarity,
                /decisions, /records
```

Rules: `core/` imports nothing outside `core/`. `adapters/` may import `core/`.
`ui/` never imports `adapters/` — only route handlers and SSE. Tests:
TypeScript strict; `node --test` (compiled) like the ported suites; `npm test`
= typecheck + unit tests.

**No half-wired surfaces.** A page, tool, or table ships in the same chunk as
the real data that feeds it, or it does not ship.

## 3. SQLite schema

```sql
projects(id PK, root_path, records_root, created_at)
manager_sessions(id PK, project_id FK, sdk_session_id, status,      -- active|compacted|closed
                 seeded_from_records_at, created_at, last_resumed_at)
manager_turns(id PK, session_id FK, turn_index, role,               -- user|assistant|tool
              content TEXT, sdk_session_id_after,                   -- resume pointer AFTER this turn
              distilled_at NULL, created_at)
lanes(id PK, project_id FK, name, allowed_globs JSON, forbidden_globs JSON,
      base_sha, status, created_at)                                 -- active|retired
workers(id PK, project_id FK, lane_id FK, sdk_session_id, worktree_path, branch,
        brief_record_id, status,                                    -- spawning|running|awaiting_input|idle|stopped|failed
        last_heartbeat_at, last_message_at, last_summary, created_at)
worker_events(id PK, worker_id FK, kind,                            -- assistant|tool_use|tool_result|result|error
              payload JSON, created_at)
completion_digests(id PK, worker_id FK, narrative, before_after JSON,
                   claims JSON,                                     -- [{text, evidence_kind, evidence_run_id NULL, files[]}]
                   touched_areas JSON, status,                      -- parsed|manager_reviewed|escalated
                   created_at)
attention_items(id PK, project_id FK, worker_id NULL, kind,
                -- lane_violation|stale_worker|question_for_user|unsupported_claim|
                -- check_failed|decision_needed|unstructured_completion
                title, detail, priority, status,                    -- open|resolved|dismissed
                record_id NULL, created_at, resolved_at)
evidence_runs(id PK, project_id FK, worker_id NULL, check_key,      -- typecheck|lint|test|build|diff-check
              status, summary, log_path, head_sha, created_at)
jobs(id PK, kind,                                                   -- monitor_tick|distill|lane_audit|checkpoint|triage
     status, payload JSON, result JSON, error NULL, started_at, finished_at)
```

Decisions have **no table** — the decision bloodline is derived purely from the
git-committed decision records.

## 4. Durable records

Location: `docs/galapagos/<type-dir>/YYYY-MM-DD-<slug>-<shortid>.md` in the
target repo. Frontmatter key `glp_type`; `written_by: Galapagos`; create with
`wx` flag (never overwrite); open statuses on create; closed statuses
(`resolved|done|approved|superseded|archived`) only via update.

Eight types: `manager_synthesis`, `active_goal`, `implementation_plan`,
`open_question`, `user_answer`, `routed_clarification`, `worker_brief`,
`decision`.

`decision` required frontmatter: `decision_options[]`, `chosen_path` (required
before any closed status), `rollback_note`, `confidence_impact`,
`git_checkpoint_ref` (tag name — REQUIRED), `git_checkpoint_status`,
`parent_decision_ref` (nullable only for roots — this is the bloodline edge).

Records are doctrine, not transcripts: short, durable, linkable. Operational
noise (runs, recaps, attention, liveness) belongs in SQLite, never in records.

## 5. Manager session (Agent SDK)

One logical manager session per project. Each user turn:
`query({ prompt, options: { resume: lastSdkSessionId, cwd: projectRoot,
mcpServers: { galapagos: { type: "sdk", serverInstance } }, systemPrompt:
managerDoctrine, allowedTools, model } })`. The manager model is pinned via
`GALAPAGOS_MANAGER_MODEL` (default `claude-fable-5`).

Verified SDK facts (code.claude.com/docs/en/agent-sdk — do not re-derive):
the session id is surfaced on the init message (`type === "system" &&
subtype === "init"` → `session_id`) and on every `result` message; persist it
to `manager_turns.sdk_session_id_after` after **every** turn — resume always
uses the latest. **Resume is cwd-keyed**: transcripts live at
`~/.claude/projects/<encoded-cwd>/*.jsonl`, and resuming from a different cwd
silently starts a blank session — the daemon must pass the project root as
`cwd` on every query, always. In-process tools are `tool(name, description,
zodShape, handler)` (zod is a required dependency) grouped by
`createSdkMcpServer({ name, version, tools })`.

**Resume is an optimization, never a dependency.** On resume failure or context
bloat, compact by **re-brief**: open a fresh session whose first message is
generated from the record set (latest synthesis + active goal + open questions +
worker briefs + open attention). This is the reason records exist.

Manager tools (in-process `createSdkMcpServer` + `tool()`):
`read_records`, `write_record`, `update_record`, `list_workers`,
`worker_status(id)`, `git_truth(scope)`, `spawn_worker(lane, brief)`,
`steer_worker(id, message)`, `stop_worker(id)`, `run_checks(worker_id?, keys[])`,
`ask_user(question, context)`, `resolve_attention(id, resolution)`.
`write_record(type=decision)` triggers the checkpoint mechanism (section 8).

**Distillation:** after each manager turn, enqueue a `distill` job — one cheap
follow-up prompt: "record any durable outcomes of this exchange using
write_record; write nothing if nothing durable happened." Run it on a **fork**
of the manager session (`resume` + `forkSession: true`) so Darwin's main
context never accumulates distillation chatter — persist nothing from the fork
except the records it writes. Use a small model via `GALAPAGOS_DISTILL_MODEL`
(default `claude-haiku-4-5`) — distillation is extraction, not judgment, and
must not double the subscription cost of every chat turn. Mark covered turns
`distilled_at`; auto-commit `docs/galapagos/` when files were written.

**Records are per-project and live in the TARGET repo.** All record paths are
`<project.root_path>/docs/galapagos/…`, and distill commits go to the target
project's own git history. The mutating-git surface for this stays as narrow
as project-init: stage only paths under `docs/galapagos/`, never anything
else; if the target repo is mid-merge/rebase or the commit fails, skip the
commit and surface a visible attention note — never block the turn, never
stage user files.

## 6. Workers

One streaming-input `query()` per worker, `cwd` = its own git worktree.
Worktrees are created under `<GALAPAGOS_STATE_DIR>/worktrees/<project-slug>/<lane-slug>/`
— never inside the target repo, which stays clean of orchestration artifacts.
Worker sessions spawn through the same helper as the manager (user's installed
Claude binary, cwd-pinned). The daemon consumes the async iterator and
persists **every** message to `worker_events` — that stream IS progress
reporting (no transcript polling). `steer_worker` injects messages mid-run via
streaming input.

**Completion report contract.** Worker system prompts require the final result
message to end with a fenced block:

````
```galapagos-completion
{
  "narrative": "<= 3 sentences",
  "before_after": [{ "before": "...", "after": "..." }],
  "claims": [{ "text": "...", "evidence_kind": "typecheck|lint|test|build|diff|manual", "files": ["..."] }],
  "touched_areas": ["src/..."]
}
```
````

The daemon parses it into `completion_digests`. Missing or malformed report →
`unstructured_completion` attention item; the worker is **not** rendered as
done. The visual change map is derived live from `git diff --numstat
<lane.base_sha>...HEAD`, not from the report.

**Worker harness abstraction.** `adapters/agent/worker-session.ts` is the ONLY
module that knows which harness runs a worker. Its interface: spawn(worktree,
systemPrompt, lane) → session; async-iterate streamed messages; inject a
message mid-run; stop. Chunks 1–6 implement exactly one backend: the Claude
Agent SDK. A designed-for future adapter is **Omnigent**
(github.com/omnigent-ai/omnigent — Apache 2.0 meta-harness, alpha as of
mid-2026): running workers behind its local server would allow non-Claude
harnesses (e.g. Codex), sandbox policies, and multi-device session steering
without touching core, daemon, or UI. It must never enter the Chunk 1–6
critical path — the prior prototype died betting its core loop on an unstable
external harness binary.

## 7. Lanes and monitoring

Lane = `allowed_globs` / `forbidden_globs` (picomatch) + `base_sha`, declared at
spawn, echoed in the worker_brief record and worker system prompt. Spawn-time
overlap rejection: a new lane whose allowed globs intersect an active lane's is
refused.

Two enforcement layers:
1. **Preventive (best-effort UX):** `canUseTool` denies Edit/Write outside the
   lane with an explanatory message. Known bypass: Bash writes — acceptable
   because of layer 2.
2. **Detective (authoritative):** monitor tick and worker stop run the pure
   lane-check over `git diff --name-only <base_sha>...HEAD` ∪ porcelain
   modified/untracked. Any out-of-lane file → high-priority `lane_violation`
   attention item + `contradicted` evidence signal (the confidence engine caps
   contradictions at 40/blocked).

**Monitor loop** (daemon, default 30s, **no LLM calls ever**): staleness
(`last_message_at` beyond threshold while running), lane audit, evidence
freshness (`evidence_runs.head_sha` vs worktree HEAD), completion-claims scan
(result claiming done without passing evidence → `unsupported_claim`).

**Manager triage is event-driven only** — runs when new open attention items
exist since last triage, batched, small-model option. Management by exception:
triage auto-reviews clean completions (`completion_digests.status =
manager_reviewed`), and escalates to the user only for failures, contradictions,
and direction calls.

## 8. Decision checkpoints (the bloodline)

On `write_record(type=decision)`:
1. Target ref = relevant worker's worktree HEAD, or project HEAD for
   direction-level decisions.
2. Dirty worktree → commit WIP first (`galapagos: pre-decision checkpoint
   <id>`). If that fails: `git_checkpoint_status: blocked_dirty` + attention
   item. Never silently skip.
3. `git tag galapagos/decision/<shortid> <sha>`.
4. Write the record with `git_checkpoint_ref` + `parent_decision_ref` = current
   tip decision on that line; commit the record file.

Resume from a node: `git worktree add
<GALAPAGOS_STATE_DIR>/worktrees/<project-slug>/resume-<shortid> -b
resume/<slug> galapagos/decision/<shortid>`, create lane (+ worker if asked),
and write a child decision record pointing at the resumed node so the bloodline
visibly forks. Forbidden always: force-push, tag deletion, history rewriting.

## 9. Confidence

One gauge per worker and per project: 0–100 with states
strong/steady/draining/blocked. Semantics (non-negotiable, encoded in the
ported regression suite): confidence = intervention need, not progress; records
alone cap below strong (real evidence required); required check failures block;
stale evidence drains; unsupported claims lower; contradictions cap at
40/blocked; one risky worker lowers project confidence. Detailed caps/signals
live in a debug drilldown, never as default sub-bars.

Every UI field everywhere carries source attribution (source, sourceLabel,
sourceRecords) — missing data renders as explicitly missing, never fabricated.

## 10. Ported sources (from the prior prototype)

Port these near-verbatim, with their tests, from `/Users/taan/Dev/karz98rk`
(read-only reference; never modify that repo):

| Into Galapagos | Source | Notes |
|---|---|---|
| `core/confidence/engine.ts` | `src/manager-clarity/confidence-engine.ts` | rename thread_brief→worker_brief; drop lifecycle/manager_run blocks; keep every cap/evidence semantic. Tests: `tests/manager-confidence-engine.test.ts`, `tests/confidence-engine.test.ts` |
| `core/git/parsers.ts` | `src/git-truth/parsers.ts` | verbatim. Tests: `tests/parsers.test.ts` |
| `adapters/git/runner.ts` | `src/git-truth/adapter.ts` | verbatim (read-only runner). Tests: `tests/adapter.test.ts` |
| `core/records/frontmatter.ts` | `src/obsidian/frontmatter.ts` | verbatim. Tests: frontmatter cases in `tests/obsidian.test.ts` |
| `adapters/records/store.ts` | `src/server/manager-docs.ts` | port mechanics (wx creates, type dirs, status lifecycle, decision validation); replace the 14 pcc_types with the 8 glp_types |
| `adapters/checks/run-checks.ts` | `src/local-session-reporter/checks.ts` | verbatim mechanics |
| clarity view-model pattern | `src/manager-clarity/view-model.ts` | rewrite trimmed; keep the source-attribution pattern. Test patterns: `tests/manager-clarity-view-model.test.ts` |

Not ported (rewritten or dropped): Convex/app-data layer, codex-connector,
openwebui, recap pipeline, handoff-parser, evidence adapter (rewrite thin over
SQLite rows).

## 11. Known risks (designed-for)

1. **SDK session resumability** — ids rotate; crashes lose sessions. Persist id
   per turn; re-brief is the guaranteed fallback; prove resume in Chunk 1.
2. **Subscription burn** — monitor ticks are LLM-free; triage is event-driven
   and batched; distillation is one cheap turn.
3. **Bash bypasses the preventive lane guard** — the detective diff audit is
   the authority; violations surface within one tick. Documented behavior, not
   a bug.
