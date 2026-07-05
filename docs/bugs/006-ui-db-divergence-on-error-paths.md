# BUG-006 — Chat UI diverges from SQLite truth on error paths

- **Severity:** low (cosmetic today, philosophy violation; worsens with workers)
- **Status:** open
- **Where:** `src/ui/app.tsx` (`sendNow`, `turnsToChatItems` usage), together
  with `src/adapters/agent/manager-session.ts` error handling

## Defect

The DB is the source of truth for conversation, but the chat client trusts its
own optimistic memory:

1. **Ghost turns.** When a turn fails (`resultWasError`), the session layer
   correctly deletes the streamed assistant/tool turns from SQLite — but the UI
   already appended them via SSE events and never reconciles. The user sees
   text that, per the record, Darwin never said; a reload silently changes
   history.
2. **No post-turn reconciliation.** After a turn completes, the client keeps
   its accumulated optimistic items instead of refetching
   `/api/manager/history`, so any server-side divergence (deletions,
   compaction reordering, rebrief turn-moves) persists until a manual reload.
3. **Index keys.** Chat items render with `key={index}` on an append-and-mutate
   list — adjacent-item state bleed waiting to happen once items get richer
   (worker chips, digest cards in Chunks 3–5).

## Symptoms if left unfixed

- The trust surface lies: a product whose doctrine is "observed vs. claimed"
  shows claimed (client memory) over observed (the store) exactly when things
  go wrong — auth failures, interrupts, resume mismatches.
- User reports become unreproducible: what they saw in the failed session no
  longer exists after reload, so "Darwin said X then it vanished" bugs can't be
  triaged.
- Chunk 3+ multiplies stream event types (worker events, attention rows) on
  the same optimistic-append pattern; divergence stops being cosmetic when the
  items are actionable (e.g. a "clear re-brief" button targeting a turn the DB
  deleted).

## Fix sketch

On `turn_error` / stream end, refetch history for the active project and
replace `items` wholesale (the server is truth; the optimistic view is only
for in-flight latency). Key items by turn id (fall back to a synthetic id for
in-flight optimistic items). This also deletes the ad-hoc client-side rebrief
patching in `handleClearRebrief`.
