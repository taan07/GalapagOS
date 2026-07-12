# Working agreement: tracks, worktrees, and the runtime

Adopted 2026-07-09, after a week of parallel sessions sharing one checkout
produced tangled commits, swept-up WIP, and lost work. Galapagos builds
lane-scoped isolation for its users; its own development now follows the
same doctrine.

## The one rule

**One track = one branch = one git worktree = one session.**

A "track" is a coherent line of work (a feature, a fix round, a doc). It
lives on its own branch, checked out in its own directory, worked by one
session at a time. No two sessions ever share a working tree. Nothing is
ever committed from a directory the track doesn't own.

## Directory map

| Directory | Branch | Role |
|---|---|---|
| `~/Dev/galapagos` | (the track you're actively developing) | primary dev checkout |
| `~/Dev/galapagos-runtime` | `next` — always | serves the daemon (`npm run dev`), never edited by hand |
| `~/Dev/galapagos-<track>` | `feat/<track>` etc. | one per active track |

Create a track: `git worktree add ~/Dev/galapagos-<name> -b feat/<name> main`
Retire a track (after merge): `git worktree remove ~/Dev/galapagos-<name> && git branch -d feat/<name>`

## The runtime and `next`

The daemon runs from `galapagos-runtime`, pinned to the **`next`**
integration branch, via `tsx watch` — it hot-reloads on any file change,
so deploying is a git operation, never a manual restart:

- **Test a track (or several together):** `git -C ~/Dev/galapagos-runtime merge feat/<track>` — the daemon reloads with it.
- **Reset the bench:** `git -C ~/Dev/galapagos-runtime reset --hard main` — `next` is throwaway by design; nothing lives only on `next`.
- `curl localhost:4517/health` tells you exactly what revision/branch is serving (identity is resolved at boot — a branch switch with identical trees keeps the old label until the first real reload).

## `main`

`main` receives **tested work only**, through PRs (one per track). Never
commit directly to main; never merge an untested track to main "to see
it". Testing happens on `next`.

## Commit hygiene

- Never `git add -A` / `git add .` — stage explicit paths. (This is how a
  model-switch feature once got swept into an unrelated WIP checkpoint.)
- Commit messages carry the track's *intent*, not just its mechanics —
  each distinct effort gets its own section in the body.
- Zero untracked files at the end of a work session: commit, or delete.
- Auto-stash tools ("epitaxy: pre-switch") are not a safety net; treat an
  unexpected stash as a smell and resolve it same-day.

## Current tracks and their goals (2026-07-09)

| Track | Goal | State |
|---|---|---|
| `feat/workers-goal-progress` | Worker plan contract: a worker turns its brief into a visible checklist (`worker_steps`), so /workers shows real goal progress. Also carries GitHub-link derivation (remote → web/branch/blob URLs). | in progress |
| `feat/quality-gated-retirement` | Stopping a worker carries intent (`retire`/`abandon`/`force`); retire is refused unless the completion is manager-reviewed; monitor auto-retires clean completions; abandoned work raises attention. | committed, awaiting PR merge |
| `feat/chat-ux` | Port of open-webui chat affordances: markdown rendering of Darwin's replies, visible/steerable message queue, copy buttons. Reference digest in `docs/reference/`. | committed, awaiting PR merge |
| `chore/workflow-doc` | This document. | this commit |

Recently merged to main (2026-07-09): turn-lock/hold-preempt fix,
interactive prompting (ask_user/ask_batch/confirm_understanding cards,
chat-composer-as-free-text), Fable-limit → Opus model switch, lane guard.

## Known debt

- `main` may sit ahead of `origin/main` between pushes — check
  `git branch -vv` before assuming GitHub is current.
- The next big fronts (per the user): the user↔Darwin chat behaviour and
  the /workers page — both have dedicated-track work ahead.
- The sidebar trio (confidence gauge · attention queue · specifics panel)
  is consciously PARKED untouched (2026-07-10 ruling) — it needs its own
  rework track later; nothing ships against it until then.
