# Working agreement: tracks, worktrees, and the runtime bench

## The rule

**One track = one branch = one git worktree = one session.** A track is a
coherent feature, fix, or documentation change. It owns its worktree and no
other session edits or commits there.

## Directory map

| Directory | Branch | Role |
|---|---|---|
| `~/Dev/galapagos` | primary development checkout | source for new tracks |
| `~/Dev/galapagos-runtime` | `next`, permanently | user-owned deployment bench |
| `~/Dev/galapagos-<track>` | `feat/<track>` etc. | isolated development track |

Create a track with `git worktree add ~/Dev/galapagos-<name> -b feat/<name> main`.
After its merge, retire it with `git worktree remove ~/Dev/galapagos-<name>`
and `git branch -d feat/<name>`.

## The permanent runtime bench

`~/Dev/galapagos-runtime` is permanently checked out on `next`. It is a
deployment-only, user-owned checkout. A track session must never manually
edit it, check out another branch there, or start, stop, or restart its
processes.

Deploy only by merging a tested track into `next`; the runtime's existing
watch process reloads the merge. Do not use branch switches, copied files, or
manual restarts as deployment mechanisms. Only the user may hard-reset
`next`.

Before accepting a bench result, verify both the listener and its working
directory: identify the process listening on port 4517, then inspect that
process's `cwd`; it must be `~/Dev/galapagos-runtime`. Confirm
`curl localhost:4517/health` reports the expected `next` branch and revision.
If either the port, cwd, branch, or revision differs, stop and ask the runtime
owner to correct it rather than changing the bench.

## Dependencies and verification

Use Bun for Galapagos's own dependencies and top-level scripts. After a
`package.json` change, run `bun install` in the track that made the change and
commit the resulting `bun.lock`. Do not run it as a routine preflight. Use
`bun install --frozen-lockfile` only to verify a committed lockfile from a
clean install.

A dependency-changing worker lane must explicitly cover both `package.json`
and its selected lockfile (`bun.lock`, `bun.lockb`, `pnpm-lock.yaml`,
`yarn.lock`, or `package-lock.json`). Do not weaken lane globs globally to
make dependency changes fit.

Track-local verification is safe without touching the runtime:

- `bun run test`
- `bun run build`
- `git diff --check`

Do not rewrite npm-specific worker-project behavior or historical handoffs:
Galapagos still supervises repositories that use npm.

## Main and commits

`main` receives tested work through one PR per track. Never commit directly to
`main`, and never use the runtime bench as an editing checkout. Stage explicit
paths, keep each commit to one intent, and leave no accidental untracked work.
