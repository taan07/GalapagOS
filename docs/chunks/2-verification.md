# Chunk 2 — manual verification checklist (user, own terminal)

Auth is keychain-bound: run everything below from your own terminal, not an
agent shell. Setup: `git checkout claude/chunk-2-durable-memory-w3g1cs &&
npm install && npm test` (expect 66/66), then `npm run dev`. The drills only
ever commit `docs/galapagos/` paths in the target project, so a real project
is safe; use a scratch project if you prefer.

**Before anything else, confirm which code is actually running** (a stale
daemon holding :4517 once masqueraded as current for a whole session):
`curl -s localhost:4517/health` — check `revision`/`branch` match your
checkout (`git log --oneline -1`). The daemon startup line prints the same.

## 1. Ingestion on startup — memory didn't reset

- Daemon terminal shows `[records] <slug>: ingested N vault specifics
  (commit: committed)`.
- `/records` shows the old vault specifics as `user_answer` records with
  `source_specific` set.
- Each vault file gained `migrated_to: "<record-id>"`; content otherwise
  untouched.
- `git -C <project> log --oneline -- docs/galapagos` shows one
  `galapagos(records): ingest …` commit.
- **Restart `npm run dev`**: no ingest line, no new commit, same record
  count.

## 2. Goal drill (exit criterion)

State the project goal concretely in chat.

- Turn completes; input stays locked briefly while the distill fork runs;
  possibly a "Distilled 1 record…" note.
- `/records` shows an `active_goal` record (`glp_type: "active_goal"`,
  `written_by: "Galapagos"`, status `active`).
- `git log --oneline -- docs/galapagos` shows a `galapagos(records):
  distill …` commit.
- `sqlite3 ~/.galapagos/state.db "SELECT kind, status, result FROM jobs
  ORDER BY created_at DESC LIMIT 3;"` → distill jobs `done`.

## 3. Write-through

Answer a question so Darwin pins a specific (record_specific chip).

- Specifics panel updates; `/records` shows the `user_answer`; a new vault
  file exists with `migrated_to` already set. One memory, two views.

## 4. Consulted, not re-asked

Ask for a proposal touching an agreed answer.

- A `read_records` chip appears before the proposal; Darwin references the
  agreement instead of re-asking.

## 5. Re-brief drill (simulated crash)

```
sqlite3 ~/.galapagos/state.db "UPDATE manager_turns SET sdk_session_id_after = NULL \
  WHERE session_id IN (SELECT id FROM manager_sessions WHERE status='active');"
```

Then ask: "What's the goal of this project?"

- A collapsed amber chip — "Darwin re-briefed from records" — not a wall of
  text. Expanding shows the reason plus the exact seed.
- Darwin states the goal correctly from records.
- Prior chat history is still visible above the chip.

## 6. Clear-to-blank

Repeat the pointer deletion, expand the fresh chip, click "Clear this
re-brief — start Darwin blank".

- Chip shows "(cleared)"; a note explains records stay on disk; clearing
  again errors politely.
- Ask "What's the goal?" — acceptable: he says he doesn't know, or visibly
  calls read_records first. NOT acceptable: instant confident answer with no
  chip (the blank didn't take).
- Reload the page: chip and cleared state survive.

## 7. Commit hygiene

`touch scratch.txt && git add scratch.txt` in the project, run a turn that
writes a record, then:

- `git status` → scratch.txt still staged, uncommitted.
- `git show --name-only HEAD` → only `docs/galapagos/` paths.

All seven pass → flip the stamp in `docs/chunks/2.md` to COMPLETE.
Likely failure points: step 2's distill fork erroring on auth (job row says
so; the chat turn itself is unaffected), and step 6's "reads records anyway"
behavior, which is doctrine tuning, not a bug.
