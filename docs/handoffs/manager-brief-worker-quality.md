# Handoff — Brief Quality track (Darwin's translation layer)

## Kickoff prompt (paste this to the implementing agent verbatim)

```
Brief Quality track — Darwin's translation layer (vision → routable work)

Repo: ~/Dev/galapagos (github.com/taan07/GalapagOS). Create and work on
claude/manager-brief-worker-quality stacked on claude/chunk-3-workers-lanes-vl5mh8 (if
chunk 3 has merged to main by the time you start, stack on main). A
SIBLING SESSION is concurrently landing post-drill fixes on the chunk-3
branch (timestamps, WebFetch trail, stop labeling, post-stop flow) — pull
its branch often, build your pure/core pieces first, touch shared files
(worker doctrine, manager-tools, daemon) last, and rebase onto the chunk-3
tip before every push. Never commit to earlier chunks' branches. Start by
reading docs/handoffs/manager-brief-worker-quality.md (your handoff), then docs/vision.md
and docs/architecture.md — the binding contracts that override everything
else, including this prompt. Study how chunk 3 built spawn_worker
(src/adapters/agent/manager-tools.ts, worker-runtime.ts,
worker-doctrine.ts) and how chunk 2 built record validation
(src/core/records/schema.ts — the pattern your brief schema mirrors).

Why this track exists (user-confirmed 2026-07-05): the chunk-3 drills
hand-fed Darwin exact lane names, globs, and briefs ("this is a drill —
don't interrogate me"), proving the worker machinery but bypassing
Darwin's actual job. The user's words: "i need to know just how good the
manager is at translating our potentially dragged out and or lazy
request/vision into an efficient prompt with the right commands and
parameters that a worker can start acting on confidently, even when the
darwin isnt being told by us to do so." Per docs/vision.md, routing
context to the right workers IS the manager's defining function — this
track makes it structured, memory-fed, visible, and measurable.

Build (four levers, in order):

1. STRUCTURED BRIEFS — you cannot optimize freeform. Give worker_brief
   records required fields mirroring the completion contract on the other
   end of a worker's life: deliverables[], done_criteria[],
   out_of_scope[], context_refs[] (ids of records the brief draws on).
   Extend core/records/schema.ts validation (same style as the
   decision-record rules: mechanical, loud) and the spawn_worker tool
   input. A spawn with empty done_criteria is REJECTED as tool text —
   Darwin cannot spawn on "make it nice".

2. MEMORY-FED BRIEFS — doctrine + tooling: before composing a brief,
   Darwin consults read_records for agreed specifics touching the task
   and cites them in context_refs; recurring per-project worker context
   (how to run tests, conventions) lives in a synthesis record injected
   into worker system prompts, not re-derived per brief. A brief citing
   zero records for a feature that HAS recorded specifics is a smell the
   doctrine names explicitly.

3. THE SPAWN PLAN — before spawning, Darwin states in chat: lane name,
   globs, brief summary (deliverables + done criteria). The user can veto
   or amend. USER RULING NEEDED before building: hard confirm gate
   (Darwin waits for an explicit yes), soft gate (proceeds next turn
   unless stopped), or plan shown only for non-trivial spawns?
   Interrogate the user, then stamp the ruling in this doc. The
   interrogation doctrine extends from recording to routing: vague
   request → sharp questions ONLY where genuinely underspecified → plan
   → spawn.

4. MEASUREMENT HOOKS (design-only here; chunk 4 computes): ensure the
   data exists — worker questions per task (awaiting_input occurrences),
   steer count, and digest-claims-vs-brief-deliverables coverage must be
   derivable by joining existing rows against the new brief fields. Do
   NOT build the monitor or metrics — that is chunk 4's. DO add a short
   section to docs/handoffs/chunk-4.md telling that agent to count
   questions/steers per worker and join digest claims to brief
   deliverables in its triage review. The learning loop — triage/
   distillation appending a dated "briefing lessons" note to the brief
   record after completion — should be specified here and built only if
   trivial with existing update_record mechanics.

Add the acceptance drill to docs/chunks/3-verification.md — "the lazy
request": the user says something like "make a little page that lists
the notes files, nothing fancy" with zero lane/glob/brief detail. Pass =
Darwin asks at most a couple of sharp questions if warranted, presents a
sensible spawn plan (non-colliding lane, correctly scoped globs, concrete
deliverables and done-criteria, records cited), and the worker completes
without needing a steer to understand the task. The USER runs this drill
and judges the brief — their judgment is the gate for this track.

Forbidden: no new record types (worker_brief gains fields, stays
worker_brief); no monitor loop or metric computation (chunk 4 owns it);
no touching the chunk-3 fix surfaces beyond what levers 1-3 require; no
letting Darwin edit code — he orchestrates, never implements.

Exit criterion: thin spawns are mechanically impossible; briefs cite the
records they draw on; the spawn plan appears in chat per the user's
ruling; the lazy-request drill passes with the user satisfied by a brief
Darwin wrote unaided. npm test green throughout (116 at handoff — plus
whatever the chunk-3 fix session adds; take the union after rebase).

Operational facts that will save you hours: auth is keychain-bound —
build and npm test anywhere, the USER runs live drills from their own
terminal; every session spawns through src/adapters/agent/spawn.ts; cwd
is load-bearing; verify the running daemon via curl -s
localhost:4517/health (revision + branch) before any live debugging;
karz98rk is intent-only, never code; workers run claude-opus-4-8 at
effort high (user-confirmed); tool failures return as tool TEXT so the
model self-corrects; strict TS with noUncheckedIndexedAccess; honest
empty states everywhere.

Working standard (unchanged since Chunk 1): purposeful commits with
explanatory bodies, tests green before every commit, push to origin, no
half-wired surfaces, interrogate the user on anything ambiguous and stamp
what gets agreed into the docs in the same commit.
```

## Scope boundaries (for the human coordinating sessions)

- The chunk-3 fix session keeps: in-app timestamps matching system time,
  the WebFetch visible trail, honest stop labeling, the post-stop flow +
  resume/successor design ruling. Item 4 of its fix prompt (brief
  quality) is REASSIGNED to this track.
- Chunk 4 keeps: all metric computation (questions/steers/coverage) and
  triage review. This track only guarantees the data shape exists.
- Merge order: chunk-3 fixes merge with chunk 3; this track merges after
  chunk 3 (it stacks on it); coordinate rebases with the chunk-4 branch.
