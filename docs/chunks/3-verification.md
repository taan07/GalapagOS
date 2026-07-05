# Chunk 3 — manual verification checklist (user, own terminal)

Auth is keychain-bound: run everything below from your own terminal. Setup:
`git checkout claude/chunk-3-workers-lanes-vl5mh8 && npm install && npm test`
(expect 115/115), then `npm run dev`. Workers write ONLY inside their own
worktrees under `~/.galapagos/worktrees/` and the daemon commits only
`docs/galapagos/` in the target repo, so a real project is safe; a scratch
project is fine too.

The mechanics below were already proven with a real worker session in the
implementing agent's sandbox (see the stamp in `docs/chunks/3.md`); what
these drills add is the chat-driven flow through Darwin, the `/workers`
page, and your own machine's auth path.

## 1. Spawn drill (exit criterion, part 1)

In chat, give Darwin a small, concrete, file-scoped task and ask him to
spawn a worker on it (e.g. "add a WORKERS.md note — lane docs only").

- Darwin uses `spawn_worker` (chip in chat) with a narrow lane; if your task
  is vague, expect interrogation first — that is the product working.
- `/workers` shows the worker with lane name, a `running` pill, and liveness
  ticking ("Ns ago").
- `ls ~/.galapagos/worktrees/<project-slug>/` shows the lane directory;
  `git -C <project> status` stays clean; `git -C <project> log --oneline --
  docs/galapagos` gained one `worker brief for lane …` commit.
- The drilldown streams events live: assistant text, tool chips, results.

## 2. Steer mid-run (exit criterion, part 2)

While the worker runs, tell Darwin to redirect it (add a constraint, change
a detail).

- A `steer_worker` chip in chat; a "steered by Darwin" entry in the
  `/workers` event stream; the worker visibly adjusts course in later
  events without restarting.

## 3. Overlap rejection

Ask Darwin to spawn a second worker whose files overlap the first lane
(e.g. "another worker on the same directory").

- The spawn is refused; Darwin relays the reason naming both globs and the
  active lane. No second worktree appears.

## 4. Violation drill (exit criterion, part 3)

Drop an out-of-lane file into the worker's worktree yourself, simulating
the Bash bypass:
`touch ~/.galapagos/worktrees/<project-slug>/<lane-slug>/out-of-lane.txt`
Then ask Darwin to stop the worker.

- `stop_worker` chip reports the violation; `sqlite3 ~/.galapagos/state.db
  "SELECT kind, priority, status FROM attention_items"` shows an open
  `lane_violation` row with priority `high`.
- The `/workers` drilldown shows the violation row in the danger hue.
- The worker's status flips to `stopped`, the worktree still exists (work
  stays reviewable), and a fresh spawn on the same files now succeeds
  (lane retired) — though the same lane NAME is refused while the old
  worktree directory remains.

## 5. Completion honesty

- If the worker finished with a fenced `galapagos-completion` block: the
  drilldown shows the digest card (narrative, before/after, claims with
  evidence badges — `manual` tinted amber). `worker_status` via Darwin says
  a report was parsed, and the status pill reads `idle`.
- If a turn ended WITHOUT a block (the worker asked a question or hit a
  blocker): the pill reads `awaiting input` — steer it with the answer.
- If it was stopped mid-task without one: an `unstructured_completion`
  attention row exists and the drilldown says "No completion report — this
  worker is not done, whatever its transcript says."

## 6. Daemon restart reconciliation

Spawn a worker, kill `npm run dev` mid-run, start it again.

- Daemon log: `[workers] reconciled 1 orphaned worker after restart`.
- `/workers` shows it `stopped` with a "Daemon restarted — the live worker
  session was lost" error event; its lane is retired; work up to the kill
  is still in the worktree.

## 7. Target repo hygiene (standing invariant)

After all drills: `git -C <project> status` is clean;
`git -C <project> log --oneline` contains only your own commits plus
`galapagos(records): …` ones; nothing under the project references the
worktrees.

All seven pass → flip the stamp in `docs/chunks/3.md` to COMPLETE, and
while you're there, rule on the implementer decisions listed in that stamp
(especially the hybrid completion-report timing and read-only /workers).
Likely failure points: step 1 needs your terminal's keychain auth (agent
shells worked in the build sandbox, but your machine's `claude /login`
state is the real path); step 4's re-spawn nuance — the lane retires but
the worktree directory persists by design, so reusing the exact lane name
is refused with an explanation.
