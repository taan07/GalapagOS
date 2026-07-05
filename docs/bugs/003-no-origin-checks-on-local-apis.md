# BUG-003 — Daemon and Next APIs accept cross-origin requests from any webpage

- **Severity:** high (must land before Chunk 3's workers merge)
- **Status:** open
- **Where:** `src/daemon/main.ts` (all routes), Next route handlers under
  `src/app/api/`

## Defect

The daemon binds 127.0.0.1 (good) but neither it nor the Next routes validate
`Origin` or `Host`. Browsers allow any webpage to *send* a cross-origin POST to
localhost (CORS only blocks reading the response, and `text/plain`/no-cors
fire-and-forget POSTs go through; the JSON body parse on our side does not
check content-type). DNS-rebinding widens the same hole.

So any webpage the user visits can, in the background:

- `POST http://127.0.0.1:4517/manager/message` — inject arbitrary prompts into
  Darwin, who runs `permissionMode: "dontAsk"` with `Read`/`Glob`/`Grep` over
  the filesystem and tools that write records and **commit to the user's
  repos**, on the user's paid subscription.
- `POST /projects` / `/projects/create` — register directories or git-init
  folders under `~/Dev`.
- `POST /system/choose-folder` — pop native dialogs.
- Interrupt or clear-rebrief active sessions.

## Symptoms if left unfixed

- Drive-by subscription burn: a malicious or compromised page can silently run
  manager turns in a loop.
- Prompt injection with a write path: injected turns can make Darwin write and
  auto-commit poisoned records into the target repo's `docs/galapagos/` — the
  store every future session re-briefs from. That is persistent memory
  poisoning of the component the whole product trusts as ground truth.
- The moment Chunk 3 merges, the same unauthenticated API spawns **workers with
  Edit/Write/Bash in worktrees**. The blast radius goes from "poison records"
  to "arbitrary code execution on the user's machine from a webpage." This bug
  is the gate on that merge.

## Fix sketch

In the daemon's request handler: reject any request whose `Host` is not
`127.0.0.1:<port>`/`localhost:<port>` and any request bearing an `Origin`
header not in the allowlist (`http://localhost:3005`, `http://127.0.0.1:3005`)
— absent `Origin` (curl, the Next server proxying server-side) is fine. Apply
the same check in Next route handlers or, better, a shared bearer token: daemon
generates a per-boot secret file under `GALAPAGOS_STATE_DIR`, Next server reads
it and attaches it when proxying; browsers can never obtain it. Either measure
alone kills the webpage vector; the token also survives DNS rebinding.
