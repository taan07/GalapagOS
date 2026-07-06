# Review — the user → Darwin → worker flow (2026-07-05)

Requested by the user after chunk 3's live drills: review the whole flow
between manager and worker, report factually on what code ensures Darwin's
briefs are efficient (NO solutions — the brief-quality track,
`docs/handoffs/manager-brief-worker-quality.md`, owns that), and think
freely about Darwin's dexterity with workers and about guardrails not
frustrating the user. Factual claims were verified against
`claude/chunk-3-workers-lanes-vl5mh8` with citations; the ideas section
merges two independent passes.

Nothing in this document is built. Tier 1 is proposed as chunk-4 scoping;
Tiers 2–3 await explicit user rulings, one by one.

---

## Part 1 — The flow as built (review findings)

1. **User → Darwin.** One manager turn per project; chat input is locked
   through post-turn distillation (busy flag set at
   `src/daemon/main.ts:164`, released in the finally at `main.ts:222`,
   distill inside the same hold, `main.ts:189-214`). The UI queues
   messages typed while busy — client-side only, drained one per completed
   turn (`src/ui/app.tsx:283-307`); a reload loses the queue. Triple-Esc
   aborts the in-flight turn (streamed text persists; honest "interrupted"
   note; the session stays resumable, `manager-session.ts:287-299`); a
   second Esc aborts the distill fork; interrupted turns still distill and
   still commit records (`distill.ts:122-135`). *Verdict: sound. Minor
   frictions: the distill wait before input unlocks, and the volatile
   client-side queue.*

2. **Darwin → worker.** spawn/resume/steer/stop are tool-mediated with
   failures returned as tool text; leftover lane names, branches, and
   worktrees reject cleanly before any row exists. Steer delivery is
   immediate daemon-side (`worker-session.ts:150-180`): an awaiting_input
   worker wakes instantly; a mid-turn worker sees the message at its next
   turn boundary. *Verdict: sound — but steer is fire-and-forget; Darwin
   never learns how the steer was taken (see T2-5).*

3. **Worker → user.** The /workers page: live event stream (every block
   type normalized after the drill-5 fix), honest statuses including
   awaiting_input, digest cards with evidence badges, stop button,
   local-time rendering. *Verdict: the strongest leg of the loop.*

4. **Worker → Darwin: THE structural gap.** Verified — no push path
   exists. The runtime's broadcast feeds only browser SSE clients
   (`main.ts:79-83`, `539-546`); worker state lands in SQLite and in
   attention rows that nothing consumes; Darwin's session receives input
   exclusively as user turns (`manager-session.ts:114-124`). He learns
   about workers only when he calls list_workers/worker_status inside a
   user-initiated turn. A worker can sit on a question (awaiting_input,
   set at `worker-runtime.ts:320`) for hours with Darwin oblivious — the
   USER is the messenger between the /workers page and the chat, which
   inverts vision.md's "the manager owns the cognitive load."

5. **Darwin's blindness to the work product.** He can technically Read
   any absolute path — bare "Read"/"Glob"/"Grep" allow rules plus dontAsk
   (`spawn.ts:23-31`, `manager-session.ts:73-75`) — including worker
   worktrees; but neither doctrine nor tools tell him so, and git_truth is
   pinned to the project root (`manager-tools.ts:34-43`). Today he
   *parrots* digest claims to the user with no way to review a diff or run
   a check — which his own "documents and prior chat are claims, not
   truth" doctrine forbids in spirit. Vision.md's "the manager reviews
   every worker completion itself" is structurally impossible until this
   changes.

6. **Completion → merge.** Deliberately out of scope until a later chunk;
   Darwin's terminal answer is "the work is on branch X" and the
   direction-level user goes to a terminal. Known roadmap gap; T3-9 gives
   it a concrete shape when its prerequisites (chunk 4 evidence) exist.

## Part 2 — Brief-efficiency inventory (facts only; solutions owned by the brief-quality track)

Everything that exists today to make Darwin's brief efficient:

- **Doctrine** (`src/daemon/doctrine.ts:85-114`): "Composing a spawn is
  YOUR job, not the user's" — consult read_records first; derive lane
  name and globs himself (the user never dictates a glob); interrogate
  only genuine gaps; required brief contents (goal in product terms,
  concrete deliverables, constraints from agreed specifics, out-of-scope,
  done-criteria with self-verification); state lane/globs/title in chat
  before spawning; "The worker_brief record is the artifact you are
  judged on."
- **Tool prose** (`manager-tools.ts:313,321`): "Write the brief like a
  real hand-off … the worker sees only the brief and its worktree, none
  of this conversation."
- **Mechanical enforcement — the honest limit** (`worker-runtime.ts:420-433`):
  non-empty lane name, ≥1 allowed glob, non-empty briefTitle and brief.
  That is ALL. Every quality requirement above is prose-only; a
  one-sentence brief with no done-criteria spawns without complaint.
- **The judgeable artifact:** the worker_brief record stores title and
  body verbatim plus frontmatter lane_name / allowed_globs /
  forbidden_globs / base_sha / branch, committed to the target repo
  (`worker-runtime.ts:530-542`).
- **What the worker actually receives** (`worker-runtime.ts:564-581` →
  `worker-session.ts:209-230`): ONLY buildWorkerDoctrine (lane echo,
  completion contract, steering semantics, fetch/evidence honesty rules)
  plus the brief text as its first message. `settingSources: []` means no
  CLAUDE.md, no project conventions, no how-to-run-tests knowledge
  reaches a worker unless Darwin writes it into the brief.
- **The one structured template:** resume briefs
  (`worker-runtime.ts:696-717`) — original brief + commits since base +
  dirty state + manager note.
- **Acceptance test:** the R2-4 lazy-request drill; the user's judgment
  of the record is the gate.
- **Note for the brief-quality track:** its four levers map exactly onto
  these gaps. One verified fact it should know: the worker-side context
  injection point already exists (the doctrine builder), and settings
  isolation is deliberate — any conventions injection must flow through
  brief/doctrine, never through settings files.

## Part 3 — Free thinking: dexterity and guardrail frustration (ranked)

### Tier 1 — close Darwin's sensory loop (proposed as chunk-4 acceptance criteria, not new scope)

1. **Worker questions must reach Darwin without the user carrying them.**
   awaiting_input exists; nothing consumes it. A block-less turn end
   should raise a question-shaped attention item, and event-driven triage
   should read it, answer from records when a record covers it (citing
   which), steer the worker, and escalate only genuine direction calls.
   Converts hours of dead worker time into one small-model triage turn —
   vision.md's central promise ("never interrupt the user with anything
   the manager could have resolved itself").
2. **Fleet snapshot injected into every manager turn.** A deterministic,
   LLM-free preamble from SQLite: per worker — lane, status, minutes
   silent, digest state, open attention count. Darwin starts every turn
   knowing the board instead of spending three tool calls rediscovering
   it or answering from a stale mental model. A few hundred tokens; cap
   at one line per worker.
3. **Eyes on the work product.** `worker_diff(id)` (tiered and bounded:
   numstat → per-file → hunk, derived from base_sha...HEAD) alongside
   chunk 4's run_checks; plus a zero-code doctrine line telling Darwin he
   MAY read worker worktrees read-only via absolute paths (verified
   technically possible today). Management-by-exception requires the
   manager to see evidence before he speaks.

### Tier 2 — grace on existing guardrails (guarantees untouched; each needs a ruling)

4. **Malformed-report auto-retry.** On a malformed (not missing)
   completion block, the daemon steers the same live session ONCE with
   the exact parse problems ("re-emit only the corrected block");
   attention only if the retry also fails. A field-name typo on finished
   work stops escalating to a human. No parsed report still means not
   done.
5. **Steer with acknowledgment.** steer_worker gains an optional bounded
   wait (~60–90s) for the worker's next message, so Darwin catches
   misinterpretation inside the same turn; on timeout it returns
   "delivered, no response yet" honestly.
6. **Hold semantics.** A pause affordance — canned steer ("commit nothing
   new, state where you are, wait") plus a visible held state — so Stop
   stops being the only, over-terminal brake when the user just wants to
   ask Darwin something first. Best-effort on top of unchanged hard
   guarantees; resume_worker covers real recovery.
7. **Loud denial patterns.** Repeated same-tool denials become a stream
   badge and, past a threshold, an attention item ("worker in lane X
   denied Y, N times") so the friction is visible instead of a worker
   silently improvising around a permission wall. Deny-by-default stays.

### Tier 3 — contract extensions (architecture amendments; the bigger rulings)

8. **amend_lane(worker_id, add_globs[]).** Widen a live lane mid-flight
   through the SAME overlap gate a spawn passes; amendment recorded on
   the lane row and brief record, visible as a stream event, steered to
   the worker. Kills the 95%-done-task-dies-over-a-nav-link dead end.
   Needs a one-paragraph §7 update ("declared at spawn" → "declared at
   spawn, amendable through the same exclusivity gate").
9. **Evidence-gated merge_worker** (post-chunk-4). Parsed digest + clean
   lane audit + fresh green required checks + explicit user approval →
   checkpoint tag + merge into project HEAD; a conflict aborts cleanly
   into an attention item with a proposed resolution path. The first real
   consumer of the confidence engine ("can this proceed without
   intervention"). The biggest ruling: it widens the mutating-git surface
   beyond records + worktree-add.
10. **Deferred spawn queue.** An overlapping spawn can queue behind the
    blocking lane and auto-fire on retirement after re-validation
    (re-check globs, refresh base_sha, Darwin confirms via triage).
    Sequencing becomes the system's job, not the user's.
11. **Micro-worker fast path.** A `quick_task` spawn variant — auto
    single-file lane, one-line brief, fast model — for "fix this typo"
    moments. Every guarantee (lane, worktree, audit, report) still
    applies; only the ceremony compresses. Shines once merge (9) exists.
12. **The garage.** A retired-lane surface (branch, merge status, disk
    weight) with consented worktree archival — git history, branches, and
    tags stay immortal; checkout DIRECTORIES become reclaimable with
    explicit consent — plus name-collision rejections that suggest the
    next free name. Needs a one-line contract clarification: work-never-
    lost is a guarantee about history, not about checkout directories.

**Explicitly out of scope here:** how Darwin composes the initial brief
(structured fields, spawn-plan gate, memory-fed briefs) — the
brief-quality track owns those.

## Rulings (user-confirmed 2026-07-05, same day)

- **Tier 2:** steer-acknowledgment, hold semantics, and loud denial
  patterns — BUILD (built on the chunk-3 branch). Malformed-report
  auto-retry — REJECTED (a malformed block stays an immediate attention
  item).
- **T3-8 amend_lane:** YES, with a stronger gate than proposed — the USER
  approves every amendment via an accept/deny prompt in the manager chat.
  This ruling also created the general chat decision mechanism (`ask_user`:
  single/multi choice, practical implications per option, always a
  free-text field) — the questionnaire the user asked for by analogy to
  Codex/Claude Desktop.
- **T3-9 merge_worker:** REJECTED permanently — merging stays human.
  Darwin's completion duty is branch name + honest evidence summary.
- **T3-10 deferred spawn queue:** REJECTED.
- **T3-11 quick_task, T3-12 the garage:** accepted as stamped roadmap
  items, not built yet.
- Tier 1 routing to chunk 4 stands unchanged.

## Routing

| Item | Route |
|---|---|
| T1-1..3 (sensory loop) | Chunk 4 — absorb as triage/monitor/evidence **acceptance criteria** |
| T2-4..7 (grace) | Small, independent; land with chunk 4 or a 3.x fix round — each needs a user ruling first |
| T3-8..12 (extensions) | Ruling-gated architecture amendments; 9 and 11 depend on chunk-4 evidence |
