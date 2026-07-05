# BUG-002 — `list_specifics` reads the vault mirror, not the canonical records store

- **Severity:** high (violates the product's core memory invariant)
- **Status:** open
- **Where:** `src/adapters/agent/manager-tools.ts` (`list_specifics` →
  `listAgreedSpecifics(context.vaultPath, …)`), `src/app/api/specifics/route.ts`

## Defect

Since Chunk 2 the records store is the memory and the Obsidian vault file is a
best-effort mirror: `recordAgreedSpecific` (write-through.ts) deliberately
tolerates a failed mirror write — the record succeeds, `mirrorError` is
reported, nothing throws. Correct.

But the read path never moved. The `list_specifics` tool — whose description
says "List every agreed specific… consult this before proposing, and never
re-ask an already-answered question" — still lists **vault files**, as does the
specifics panel via `/api/specifics`. A specific whose mirror write failed
exists in Darwin's canonical memory but is invisible to the exact tool that
guards against re-asking.

"One memory, two views — never two diverging memories" is violated by the read
side of the tool pair: writes are store-first, reads are mirror-only.

## Symptoms if left unfixed

- Darwin re-asks a question the user already answered — the product's defining
  failure mode, delivered by the product's own tooling — whenever a vault write
  fails (vault path wrong on a new machine, Obsidian sync conflict, permissions,
  disk full) or the vault is simply absent.
- The specifics panel under-reports agreed decisions in the same conditions, so
  the user's trust surface ("did he record that?") lies by omission.
- The divergence is silent and grows: nothing reconciles mirror and store after
  a failed mirror write, so every failure permanently forks the two views.

## Fix sketch

`list_specifics` reads `store.list({ type: "user_answer" })` (+ deferred
`open_question`s if the panel should show them), rendering the same summary
shape. `/api/specifics` does the same via the store. The vault stays write-only
mirror territory: humans read it in Obsidian, the system never treats it as a
source again. Ingestion (`ingest.ts`) remains the one legitimate vault reader.
