# BUG-007 — Batch of smaller defects

- **Severity:** low (individually minor; grouped so none is forgotten)
- **Status:** open

Each item below is independent; check them off individually as fixed.

## 007a — Dead `GET /events` SSE surface

- **Where:** `src/daemon/main.ts` (`GET /events`, `broadcast`, `eventClients`).
- **Defect:** The daemon maintains a broadcast SSE channel and pushes
  `turn_complete`/`turn_error` to it, but no client ever connects — the UI
  reads its stream from the per-request `POST /manager/message` response, not
  `/events`. Architecture §1 lists `GET /events` as the live-stream channel;
  the UI never adopted it.
- **Symptom if unfixed:** A half-wired surface in a codebase whose contract
  bans them ("no half-wired surfaces"). It reads as working infrastructure and
  invites Chunk 3+ to build worker-event streaming on a channel with no
  consumer, or to duplicate it. Decide: wire the UI to `/events` for
  cross-tab/liveness updates, or delete it until a consumer exists.

## 007b — `manager_sessions.sdk_session_id` column never written

- **Where:** `src/adapters/db/schema.ts`, `repos/manager.ts`.
- **Defect:** The resume pointer is tracked per-turn in
  `manager_turns.sdk_session_id_after` (correct, per architecture §5). The
  `manager_sessions.sdk_session_id` column is created but never read or written.
- **Symptom if unfixed:** Dead schema — a reader assumes it holds the session's
  live pointer and builds on a column that is always NULL. Either populate it as
  a documented denormalization or drop it from the schema.

## 007c — Merge/rebase detection assumes `.git` is a directory

- **Where:** `src/adapters/git/mutating-runner.ts` (`inProgressOperation`).
- **Defect:** It checks `path.join(projectRoot, ".git", "MERGE_HEAD")` etc. In a
  linked worktree, `.git` is a **file** pointing at the real gitdir, so these
  `existsSync` checks silently return "no operation in progress."
- **Symptom if unfixed:** The safety guard that skips records commits during a
  merge/rebase is blind in worktrees. Chunk 3 runs workers **in worktrees** and
  Chunk 6 checkpoints there — precisely where a commit during a conflicted
  rebase could entangle records with a half-finished operation. Resolve the real
  gitdir (`git rev-parse --git-dir`) instead of assuming a directory.

## 007d — Non-atomic record writes

- **Where:** `src/adapters/records/store.ts` (`update` → `writeFileSync` in
  place; `create` is `wx` so less exposed), `vault/specifics.ts`.
- **Defect:** Updates overwrite the record file in place. A crash or full disk
  mid-write leaves a truncated/corrupt record — in the store whose entire reason
  to exist is surviving crashes and being the memory of record.
- **Symptom if unfixed:** A corrupted record fails to parse and is silently
  dropped by `parseFile` (returns null on non-record shape), so a crash at the
  wrong instant can make an agreed answer or a decision vanish from memory with
  no error. Write to a temp file in the same dir and `renameSync` over the
  target (atomic on POSIX).

## 007e — Hardcoded personal defaults in cross-platform source

- **Where:** `src/config.ts` (`GALAPAGOS_VAULT_PATH` default
  `/Users/taan/Documents/Obsidian Vault`), `src/adapters/system/dialogs.ts`
  (macOS-only `osascript`/`open`).
- **Defect:** A specific user's home path is the shipped default, and the folder
  chooser throws on non-macOS. The README's env-var table presents the app as
  configurable/portable without stating the macOS-only reality.
- **Symptom if unfixed:** On any non-taan machine the vault default points at a
  nonexistent path, so the vault mirror silently no-ops (compounding BUG-002),
  and project registration via the chooser is impossible off macOS. Fine for a
  personal tool — but then say "macOS, single-user" in the README, and derive
  the vault default from `os.homedir()` so it is at least wrong in a
  self-consistent way.
