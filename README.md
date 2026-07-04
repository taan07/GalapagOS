# Galapagos

Local-first driver for AI agent orchestration. The user operates at the
direction level; a manager agent absorbs the cognitive load — keeps workers
on-vision, verifies claims against evidence, and escalates only genuine
direction calls. See [docs/vision.md](docs/vision.md).

## Status

Docs-first scaffold. Implementation happens in six self-contained chunks under
[docs/chunks/](docs/chunks/), governed by the
[architecture contract](docs/architecture.md).

## Implementer protocol

Each chunk is one fresh agent session. The entire handoff is:

> Read `docs/vision.md` and `docs/architecture.md`, then implement
> `docs/chunks/<N>.md`.

Rules: the architecture contract overrides chunk briefs on conflict; a chunk is
done only when its exit criterion works end-to-end with real data and its
verification passes; the user reviews and commits between chunks. Consult the
Claude Agent SDK docs (docs.claude.com, Agent SDK section) — never guess SDK
APIs.

## Development

- `npm run dev` — daemon (:4517) + Next.js UI (http://localhost:3005)
- `npm test` — typecheck + node --test suites (no network)
- `npm run spike:resume` — proves session resume across process boundaries
  (makes two small real manager turns on your subscription)

**Run `npm run dev` from your own terminal.** Darwin's sessions spawn your
installed Claude Code binary (`~/.claude/local/claude`, override with
`GALAPAGOS_CLAUDE_BIN`) so they authenticate with your subscription login via
the macOS keychain — sandboxed or headless shells cannot reach it, and turns
fail with "Not logged in".

Environment (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `GALAPAGOS_STATE_DIR` | `~/.galapagos` | Central SQLite operational state |
| `GALAPAGOS_VAULT_PATH` | `/Users/taan/Documents/Obsidian Vault` | Obsidian vault for agreed specifics |
| `GALAPAGOS_MANAGER_MODEL` | `claude-fable-5` | Darwin's model |
| `GALAPAGOS_DAEMON_PORT` | `4517` | Daemon port |
| `GALAPAGOS_CLAUDE_BIN` | `~/.claude/local/claude` | Logged-in Claude Code binary |
| `GALAPAGOS_DEV_ROOT` | `~/Dev` | Folder browsing start + where new projects are created |
