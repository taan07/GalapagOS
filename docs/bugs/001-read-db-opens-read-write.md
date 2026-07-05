# BUG-001 — Next route handlers open SQLite read-write and run migrations

- **Severity:** high (architecture-contract violation)
- **Status:** open
- **Where:** `src/server/read-db.ts` → `openDb(config.stateDir)`

## Defect

Architecture §1 says reads go straight to SQLite with "Next route handlers
open the db read-only", and the file's own comment says "handlers only
SELECT — all writes go through the daemon." But `readDb()` calls
`openDb(config.stateDir)` without `{ readonly: true }`, and `openDb` defaults
to read-write **and executes `SCHEMA_SQL`** on every non-readonly open
(`src/adapters/db/db.ts`).

So the web tier holds a write connection to the operational store, and starting
`next dev` without the daemon silently creates the database and runs migrations
from the wrong process. The read-only mechanism already exists
(`openDb(dir, { readonly: true })`) and is simply not used.

## Symptoms if left unfixed

- Two processes own schema DDL. When a later chunk changes the schema, whichever
  process starts first migrates — a stale Next build can migrate a database out
  from under a newer daemon (the exact class of "stale code masquerading as
  current" that Chunk 2's verification already got burned by once).
- A bug in any route handler can write to the operational store, and nothing
  structural prevents it. The "daemon owns all writes" invariant is enforced by
  hope, not by the connection mode.
- Starting the web UI alone fabricates an empty `state.db`, making a
  misconfigured `GALAPAGOS_STATE_DIR` look like healthy-but-empty state instead
  of failing loudly.

## Fix sketch

`readDb()` opens with `{ readonly: true }`. Handle the
database-does-not-exist-yet case explicitly (surface "daemon has not created
state yet" — honest missing state, not fabricated empty state). Optionally
`db.pragma("query_only = ON")` as a second belt.
