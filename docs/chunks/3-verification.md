# Chunk 3 — practical drill runbook (user, own terminal)

Ten drills, ~30 minutes. Everything is copy-paste: messages go to Darwin in
the chat, commands go in a second terminal. The mechanics were already
proven with real worker sessions in the build sandbox (stamp in
`docs/chunks/3.md`); what these drills verify is the chat-driven flow, the
`/workers` page, and your machine's keychain auth path.

**Safety:** workers write only inside `~/.galapagos/worktrees/`, and the
daemon commits only `docs/galapagos/` in the target repo. These drills use
a throwaway project anyway, so nothing real is ever at risk.

## Drill 0 — Setup

```bash
cd ~/Dev/galapagos
git checkout claude/chunk-3-workers-lanes-vl5mh8
npm install && npm test        # expect 116/116
npm run dev                    # from YOUR terminal — auth is keychain-bound
```

Open http://localhost:3005, click **+ Add project → Create**, name it
`chunk3-drill`. Keep two things visible: the chat, and a second browser tab
on **/workers** (open it NOW, before any worker exists — drill 1 checks
that a spawn appears live without a reload).

- [ ] /workers shows the honest empty state ("No workers yet…").

## Drill 1 — Spawn via chat, watch it live (exit criterion 1/3)

Paste to Darwin:

> Spawn a worker now, this is a drill — don't interrogate me first. Lane
> name: "notes", allowed globs: ["notes/**"]. Brief title: "Seed the notes
> folder". Brief: "Create notes/plan.md containing a five-line outline for
> a todo app. Commit it to your branch. Then end with your completion
> report."

Expect, in order:

- [ ] A `spawn_worker` chip in chat naming the lane, worktree, branch, and
      brief record.
- [ ] The worker **appears on the already-open /workers tab without a
      reload**, pill `spawning` → `running`, liveness ticking ("3s ago").
- [ ] The drilldown streams live: assistant text, tool chips
      (Write/Bash), then a `turn result` and a green **digest card**
      (narrative, claims with evidence badges) with the pill at `idle`.

Then in the terminal:

```bash
ls ~/.galapagos/worktrees/chunk3-drill/     # → notes/  (the worktree)
git -C ~/Dev/chunk3-drill status            # → clean
git -C ~/Dev/chunk3-drill log --oneline     # → "…worker brief for lane notes" + your init commit
cat ~/Dev/chunk3-drill/docs/galapagos/briefs/*.md | head -20   # lane echoed in the record
git -C ~/.galapagos/worktrees/chunk3-drill/notes log --oneline # worker's commit on its branch
```

- [ ] Worktree outside the project; target repo clean; brief committed;
      the work lives on `galapagos/worker/notes`, NOT on your project's main.

## Drill 2 — awaiting_input + steer (exit criterion 2/3)

Paste to Darwin:

> Spawn a worker. Lane name: "notes two", allowed globs: ["notes2/**"].
> Brief title: "One decision note". Brief: "You will create one file,
> notes2/decision.md. FIRST, end your turn by asking me exactly one
> question — English or Thai for the note? — with NO completion block. Do
> not write anything until answered."

- [ ] When the worker's question turn ends, its pill reads **`awaiting
      input` (amber)** — not `idle`. This is decision #8 working: a
      block-less turn end means "waiting on the manager".

Now paste to Darwin:

> Steer that worker: English. Then let it finish.

- [ ] A `steer_worker` chip in chat; a **"steered by Darwin"** entry
      appears in the drilldown stream between turns (decision #4).
- [ ] The worker resumes without restarting, writes the file, and the pill
      lands on `idle` with a digest card.

## Drill 3 — Lanes are exclusive

Paste to Darwin:

> Spawn another worker on lane "everything", allowed globs: ["notes/**"].

- [ ] Refused. Darwin relays the rejection naming BOTH globs and the
      active lane ("notes"). No third worktree appears in
      `~/.galapagos/worktrees/chunk3-drill/`.

(If drill 1's worker already stopped, its lane is retired and this spawn
would rightly succeed — run drill 3 while a lane is still active.)

## Drill 4 — The preventive guard, live

Paste to Darwin:

> Spawn a worker. Lane name: "guard test", allowed globs: ["guarded/**"].
> Brief title: "Guard probe". Brief: "First, try to Write to README.md at
> the repository root and report verbatim what happens. Then create
> guarded/ok.md with one line, commit, and end with your completion
> report."

- [ ] In the drilldown, the Write on README.md returns a **denial**: "…is
      outside your lane — it matches none of your lane's allowed globs
      (guarded/**)…". The worker reports it and proceeds in-lane.
- [ ] `git -C ~/Dev/chunk3-drill status` — still clean; README untouched.

## Drill 5 — WebFetch (user-confirmed ruling)

Paste to Darwin:

> Spawn a worker. Lane name: "docs fetch", allowed globs: ["fetched/**"].
> Brief title: "Fetch probe". Brief: "WebFetch https://example.com and
> write its page title into fetched/title.md. Commit, then end with your
> completion report."

- [ ] A **WebFetch tool chip** appears in the event stream (the visible
      fetch trail is the mitigation we accepted), the file lands in-lane,
      digest parses.

## Drill 6 — Bash bypass caught at stop (exit criterion 3/3)

Plant an out-of-lane file INSIDE drill 1's worktree — at its root, outside
the `notes/**` glob (this simulates what a worker could do with Bash):

```bash
touch ~/.galapagos/worktrees/chunk3-drill/notes/rogue.txt
```

Paste to Darwin:

> Stop the "notes" worker.

- [ ] The `stop_worker` chip reports the violation:
      `rogue.txt (not_allowed)`, raised as a high-priority attention item.
- [ ] The /workers drilldown shows the violation row in the danger hue.
- [ ] `sqlite3 ~/.galapagos/state.db "SELECT kind, priority, status FROM
      attention_items"` → an open `lane_violation` with priority `high`.
- [ ] The worker is `stopped`; the worktree still exists (work stays
      reviewable — decision #2).

## Drill 7 — The Stop button (user-confirmed escape hatch)

Use the drilldown **Stop worker** button on drill 2's (or 4's/5's) worker
instead of asking Darwin.

- [ ] The button reports the same outcome shape Darwin's stop does (audit
      result + digest presence), the lane retires, and the attention
      semantics are IDENTICAL to a chat-driven stop — check
      `attention_items` again; no extra or different rows from the UI path.
- [ ] Ask Darwin "what's the status of that worker?" — `worker_status`
      shows it stopped; chat and UI agree.

## Drill 8 — Stop without a report = not done

If every worker so far delivered a digest, spawn one more and stop it
mid-task (button or chat) before it finishes.

- [ ] An `unstructured_completion` attention row appears, and the
      drilldown says "No completion report — this worker is not done,
      whatever its transcript says."

## Drill 9 — Daemon restart reconciliation

Spawn a worker on a fresh lane; while it is `running`, Ctrl-C `npm run
dev`, then start it again.

- [ ] Daemon log on boot: `[workers] reconciled 1 orphaned worker after
      restart` — printed BEFORE "listening" (decision #7).
- [ ] /workers shows it `stopped` with the "Daemon restarted — the live
      worker session was lost" error event; its lane is retired (a new
      spawn on the same globs succeeds — same NAME is refused while the
      old worktree directory remains, by design).
- [ ] Its half-done work is still in the worktree.

## Drill 10 — Final hygiene sweep

```bash
git -C ~/Dev/chunk3-drill status             # clean
git -C ~/Dev/chunk3-drill log --oneline      # only init + galapagos(records) commits
ls ~/Dev/chunk3-drill                        # no worktrees, no orchestration files
sqlite3 ~/.galapagos/state.db "SELECT status, COUNT(*) FROM workers GROUP BY status"
```

- [ ] Target repo clean; every worker row in an honest terminal state;
      all worktrees under `~/.galapagos/worktrees/` only.

---

# Round 2 — after the post-drill fixes (2026-07-05)

Round 1 passed drills 1–4, 6–9 and the sweep; its four findings are fixed
on this branch. Pull, `npm install && npm test` (expect 120/120), restart
`npm run dev`, confirm `/health` reports your checkout's revision. Then:

## R2-1. Timestamps spot-check (finding 0)

With any worker streaming, compare an event's time in the drilldown and a
record's created date on /records against your system clock.

- [ ] Times match your local clock and timezone, not UTC.

## R2-2. Drill 5 re-run, sharpened (finding 1)

Re-run drill 5 (WebFetch probe, NEW lane name — e.g. "docs fetch two").

- [ ] EVERY fetch appears in the stream: a `WebFetch` chip, a
      `server_tool_use`-style chip, or a Bash `curl` chip — whichever way
      your CLI executes it, the trail is visible.
- [ ] Open the digest card and check each claim's evidence badge: a claim
      about fetched content backed by a real fetch may say `diff`/`manual`;
      if the worker could NOT fetch, its narrative must SAY so — content
      presented as fetched with no fetch chip anywhere is a FAIL (report
      it; that's a worker-honesty defect, not a pipeline one).

## R2-3. Stop, then continue (findings 2 + 3, the ruled path)

Spawn a worker on a real multi-step task (new lane name). Mid-task, stop
it with the /workers Stop button.

- [ ] The stream shows "Stopped by the user, via the workers page" — NOT
      `error_during_execution`. Status pill: `stopped`, not `failed`.
- [ ] Ask Darwin to CONTINUE that work (phrase it lazily: "pick that back
      up, and also …"). He uses `resume_worker` — not a new spawn — the
      drilldown's new worker shows "continues <predecessor>", the SAME
      worktree path, and the lane is active again.
- [ ] Ask Darwin to spawn a fresh worker reusing the OLD lane name: he
      relays a clean rejection (no failed row in `sqlite3 … "SELECT status
      FROM workers"`).

## R2-4. The lazy request (item 4 — Darwin's brief-writing IS the gate)

Say to Darwin, verbatim or in your own lazy words:

> make a little page that lists the notes files, nothing fancy

Zero lane/glob/brief detail. Judge what he does:

- [ ] He consults records (read_records chip), asks AT MOST a couple of
      sharp questions if genuinely warranted — none is also acceptable —
      and never asks you for lane names or globs.
- [ ] Before spawning he states, in one line, the lane name, globs, and
      brief title he's about to use.
- [ ] The lane name is fresh (non-colliding); the globs are the narrowest
      sensible scope; open the worker_brief record on /records — it reads
      as a real hand-off: goal, concrete deliverables, constraints, out of
      scope, done-criteria with self-verification.
- [ ] The worker completes WITHOUT needing a steer to understand the task.

Your judgment of that brief's quality is the acceptance test — if you
wouldn't hand that brief to a contractor, the item fails; report what was
missing.

---

# Round 3 — the decision channel and worker dexterity (2026-07-05)

Pull, `npm install && npm test` (expect 130/130), restart `npm run dev`,
confirm `/health` shows your revision. Then:

## R3-1. The questionnaire (ask_user)

Tell Darwin something that forces a real fork, e.g.:

> I want the notes page to support sorting — you pick what matters, but
> ask me anything that changes the product.

- [ ] A decision card appears IN CHAT: clickable options, each with a
      practical implication, plus a free-text field. Darwin's turn waits.
- [ ] Click an option (or type a note) — Darwin continues in the same
      turn, acts on the answer, and records it (record_specific chip).
- [ ] Reload the page mid-decision: the card re-renders and still answers.
- [ ] Let one time out (10 min) or triple-Esc: the card settles honestly
      ("deferred"/"interrupted") and Darwin does NOT guess.

## R3-2. The amendment gate (amend_lane)

Spawn a worker on a narrow lane, then mid-task tell Darwin the task also
needs one file outside it (or engineer the brief so the worker asks).

- [ ] Darwin proposes the amendment via an accept/deny card naming the
      globs and his reason — NOTHING changes until you click.
- [ ] Accept: the drilldown shows the "LANE AMENDED" steer, the worker can
      now edit the file, and the worker_brief record on /records carries
      the approved-by note.
- [ ] Deny one too: the lane stays unchanged and Darwin adjusts the plan.

## R3-3. Hold, then release

While a worker runs, click **Hold** in its drilldown (or ask Darwin to
hold it).

- [ ] The worker replies with exactly where it is; pill turns
      `awaiting input`; the lane stays active (an overlapping spawn is
      still refused).
- [ ] Ask Darwin to continue it — an ordinary steer releases it. No stop,
      no audit, no attention items.

## R3-4. Steer acknowledgment

Ask Darwin to steer a busy worker with a change of direction.

- [ ] Darwin's steer chip shows the worker's REPLY (or an honest "no
      response within the wait window"), and what he tells you reflects
      the reply, not just "delivered".

## R3-5. Loud denials

Brief a worker to attempt WebSearch three times (a drill brief may say so
explicitly).

- [ ] The stream shows each denial; after the third, ONE `tool_denied`
      attention row exists (`sqlite3 ~/.galapagos/state.db "SELECT kind,
      title FROM attention_items WHERE kind='tool_denied'"`).

---

**All of round 2 passes →** flip the stamp in `docs/chunks/3.md` to
COMPLETE. Every decision in the stamp is now user-ruled. Then delete
`~/Dev/chunk3-drill` and its state rows if you want, and the branch merges
to main (chunk 4 rebases on it).

**Likely failure points:** drill 1 needs your keychain auth (`claude
/login` state) — a "Not logged in" turn error means the daemon wasn't
started from your own terminal; drill 3 only rejects while the first lane
is still ACTIVE; drill 6's `rogue.txt` must land at the worktree ROOT
(inside `…/worktrees/chunk3-drill/notes/`, next to the `notes/` subdir,
not inside it).
