# Chunk 4 — practical drill runbook (user, own terminal)

Eight drills, ~30 minutes. The mechanics were already proven with REAL
sessions in the build sandbox (stamp in `docs/chunks/4.md`): the full
clean-completion loop (worker → unsupported claims → triage runs checks →
auto-review, zero interruptions) and the question loop (hanging question →
triage). What these drills verify is the chat-driven flow, both UI
surfaces, your keychain auth path — and the decisions stamped in
`docs/chunks/4.md` that you may want to overturn (especially #2: required
checks were read as typecheck/test/build from your "triage, test and
build").

**Safety:** unchanged from chunk 3 — workers write only inside
`~/.galapagos/worktrees/`, the daemon commits only `docs/galapagos/`, and
these drills use a throwaway project. Triage runs on claude-haiku-4-5 and
only when new attention items exist; the monitor itself never spends a
token.

## Drill 0 — Setup

```bash
cd ~/Dev/galapagos
git checkout claude/chunk-4-monitoring-confidence-mud9n3
npm install && npm test        # expect 154/154
GALAPAGOS_STALE_WORKER_SECONDS=60 npm run dev   # YOUR terminal — keychain auth
```

(The 60s staleness override keeps the waiting drills short; drop it for
real use and the default is 300s.)

Create/register a throwaway project `chunk4-drill` with a package.json
that has real `typecheck` and `test` scripts (copy a small node project,
or ask Darwin to create one and add trivial scripts). Keep `/` and
`/workers` open in two tabs.

- [ ] `/` shows the project confidence gauge in the side column (low
      score is fine — the state must be `steady`, NOT `draining`, with
      "little is recorded or evidenced yet") and the queue's honest empty
      state: "Nothing needs you."
- [ ] The gauge's **why N** drilldown lists every signal and cap with a
      reason and a computed-at stamp. No opaque numbers anywhere.

## Drill 1 — The clean completion that never interrupts you (exit criterion)

Paste to Darwin:

> Spawn a worker, this is a drill — don't interrogate me. Lane "notes",
> allowed globs ["notes/**"]. Brief title: "Seed notes". Brief: "Create
> notes/plan.md with a five-line outline for a todo app. Run npm test to
> verify nothing broke, commit to your branch, then emit your completion
> report with your claims."

Watch, WITHOUT touching anything:

- [ ] The worker completes; its digest card appears on /workers.
- [ ] Within a tick or two the queue may briefly show
      `unsupported claim` items (the worker's test claims have no
      evidence rows yet) — then triage runs checks in the worktree and
      they flip to resolved on their own.
- [ ] The digest card reaches `manager_reviewed` — and **no question ever
      reached your chat**. That silence IS the exit criterion.
- [ ] The worker's gauge is strong; its claim rows now wear TWO badges —
      the claimed kind and `verified` (hover for the reason: the fresh
      passing run).

## Drill 2 — A stale worker drains, then escalates (exit criterion)

Spawn a worker on some multi-step task, and while it is `running`, freeze
its session process (kill would fail it — freezing makes it hang):

```bash
pkill -STOP -f "claude.*worktrees/chunk4-drill"   # adjust the match
```

- [ ] Within ~60s+tick: the worker's gauge drops to ≤55 `draining` with
      "has gone quiet" as the reason, a high-priority `stale worker` item
      opens on the queue, and the PROJECT gauge drops (the risky-worker
      cap names the worker).
- [ ] Triage picks it up; expect a steer attempt or an escalation into
      your chat — either is a correct judgment; what may NOT happen is
      silence.
- [ ] `pkill -CONT` the process; when the worker speaks again, a LATER
      silence would raise a NEW item (episodes), but the old one is not
      re-raised.

## Drill 3 — A worker's question reaches your chat via triage (exit criterion)

Spawn a worker whose brief withholds a real decision:

> Brief: "Write notes/faq.md. First ask your manager ONE question that
> the brief cannot answer: should the FAQ tone be formal or playful? Do
> not write anything until answered."

- [ ] The worker goes `awaiting input` (amber). For the first 60s the
      queue stays EMPTY — a fresh question is dialogue (chunk 3 ruling).
- [ ] Past the threshold: `question for you` opens on the queue, and
      triage either ANSWERS it from records (if you ever recorded a tone
      decision — check the steer in the drilldown) or a "Triage escalated
      a question" note lands in your CHAT with a recommendation attached.
- [ ] Reply to Darwin; he should consult `list_attention`, steer the
      worker with your answer, and resolve the item. Check the chip
      trail.

## Drill 4 — A failing required check blocks (exit criterion)

Break the test in the worker's worktree after a completion (or brief a
worker to claim tests pass without them passing), then in chat:

> Run the checks for that worker.

- [ ] Darwin's `run_checks` chip shows the failure; the worker's gauge is
      BLOCKED at ≤30 with "Required check \"test\" failed."
- [ ] The claim row flips to `contradicted` (danger) — and a high-priority
      item appears within a tick.
- [ ] Overturn point (stamp #2): confirm typecheck/test/build as the
      required set, or rule otherwise and have it changed.

## Drill 5 — Evidence goes stale by itself

With a worker green from drill 1, edit ANY file in its worktree from your
terminal (uncommitted is enough):

```bash
echo "// drift" >> ~/.galapagos/worktrees/chunk4-drill/notes/plan.md
```

- [ ] Next tick: the gauge drops to ≤65 `draining`, reason "evidence
      predates the current head/dirty state"; the verified badges fall
      back to `unverified` (expired evidence proves nothing either way).

## Drill 6 — The Bash bypass is caught mid-run, within a tick

While a worker is `running`, plant an out-of-lane file in its WORKTREE
from your terminal (simulating a Bash write past the preventive guard):

```bash
touch ~/.galapagos/worktrees/chunk4-drill/<lane>/src/evil.ts
```

- [ ] Within one tick (30s, or your override): high-priority
      `lane violation` on the queue naming the file — BEFORE any stop.
- [ ] Stop the worker via Darwin: the stop audit does NOT duplicate the
      identical open item.

## Drill 7 — Main-checkout watch (stamp #4 — judge the wording)

While a worker is live on lane `notes/**`:

```bash
echo x >> ~/Dev/chunk4-drill/notes/anything.md   # inside a live lane
echo x >> ~/Dev/chunk4-drill/README.md           # no lane claims this
```

- [ ] The notes file raises ONE normal-priority item worded "possibly
      your own edit"; the README edit raises nothing.
- [ ] Judge the trade live: is one worded item per file-set the right
      noise level for your own mid-run edits? Overturn freely.

## Drill 8 — The queue is workable

- [ ] Resolve one item and Dismiss another from `/`; both move to the
      collapsed "handled" history and the project gauge reacts.
- [ ] Ask Darwin "what needs me right now?" — expect a `list_attention`
      chip and an answer grounded in the queue, not vibes.

## Flip the stamp

All boxes ticked → edit `docs/chunks/4.md` status to COMPLETE (drills
passed <date>), note any overturned decisions, commit.
