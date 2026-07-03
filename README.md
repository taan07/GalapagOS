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

## Development (after Chunk 1)

- `npm run dev` — daemon (:4517) + Next.js UI
- `npm test` — typecheck + node --test suites
