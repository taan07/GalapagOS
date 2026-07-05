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

**All ten pass →** flip the stamp in `docs/chunks/3.md` to COMPLETE, and
rule on the remaining implementer decisions in that stamp (especially #1,
the hybrid completion-report timing — drill 2 showed you its behavior).
Then delete `~/Dev/chunk3-drill` and its state rows if you want, or keep
it as a scratch project.

**Likely failure points:** drill 1 needs your keychain auth (`claude
/login` state) — a "Not logged in" turn error means the daemon wasn't
started from your own terminal; drill 3 only rejects while the first lane
is still ACTIVE; drill 6's `rogue.txt` must land at the worktree ROOT
(inside `…/worktrees/chunk3-drill/notes/`, next to the `notes/` subdir,
not inside it).
