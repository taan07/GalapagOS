# Bug tracker — deep review findings (2026-07-05)

Defects found in a full-code review of Chunks 1–2 (branch state: `main` at the
Chunk 2 merge; Chunk 3 under separate verification on its own branch). One file
per bug; update `status` in place as each is fixed (`open` → `fixed`, with the
fixing commit referenced). Ordered by severity.

| # | Title | Severity | Status |
|---|-------|----------|--------|
| [BUG-001](001-read-db-opens-read-write.md) | Next route handlers open SQLite read-write and run migrations | high | open |
| [BUG-002](002-list-specifics-reads-mirror-not-store.md) | `list_specifics` reads the vault mirror, not the canonical records store | high | open |
| [BUG-003](003-no-origin-checks-on-local-apis.md) | Daemon and Next APIs accept cross-origin requests from any webpage | high | open |
| [BUG-004](004-manager-turn-loop-untested.md) | `runManagerTurn` / distill / daemon HTTP layer have zero automated coverage | medium | open |
| [BUG-005](005-deps-pinned-latest.md) | Every dependency ranged `"latest"` | medium | open |
| [BUG-006](006-ui-db-divergence-on-error-paths.md) | Chat UI diverges from SQLite truth on error paths | low | open |
| [BUG-007](007-minor-defects-batch.md) | Batch: dead `/events` surface, dead column, worktree-blind merge detection, non-atomic record writes, hardcoded personal defaults | low | open |

Not a bug, recorded for context: Chunk 3 absent from `main` is intentional —
it lives on its own branch pending the user's manual verification drills.
