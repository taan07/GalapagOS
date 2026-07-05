# BUG-005 — Every dependency ranged `"latest"`

- **Severity:** medium
- **Status:** open
- **Where:** `package.json` (all 8 dependencies, all 8 devDependencies)

## Defect

Every entry in `dependencies` and `devDependencies` is `"latest"` — including
`@anthropic-ai/claude-agent-sdk` (fast-moving, this codebase depends on its
undocumented stream-message shapes), `better-sqlite3` (native module, ABI-bound
to the Node version), and `next`/`react` (major-version breaking changes as a
lifestyle). The lockfile is the only thing pinning reality.

Already demonstrated live: a routine `npm install` in a fresh clone during the
2026-07-05 review rewrote `package-lock.json` with a new dependency tree —
an unreviewed full-stack upgrade as a side effect of installing.

## Symptoms if left unfixed

- Any lockfile regeneration (merge conflict resolution, `npm update`, a fresh
  environment, a well-meaning `npm install` after deleting the lock) silently
  upgrades the entire foundation at once. With `latest` ranges there is no
  semver fence at all — major versions walk straight in.
- The architecture's top-ranked external risk is SDK instability
  (architecture §11; the predecessor project died on an unstable harness
  dependency). `"latest"` on the SDK re-places that exact bet: an SDK breaking
  change lands uninvited and manifests as BUG-004's untested paths failing in
  live turns.
- Chunk implementers on other machines resolve different trees than the one
  the chunk was verified against — "tests green" stops meaning one thing.

## Fix sketch

Pin what's installed: `npm ls --depth=0`, copy the resolved versions into
`package.json` as caret ranges (`^x.y.z`) — exact pin for
`@anthropic-ai/claude-agent-sdk`, upgraded deliberately with a changelog read.
One commit, no code changes.
