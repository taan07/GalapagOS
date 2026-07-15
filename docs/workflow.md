# Working agreement: tracks, worktrees, and the runtime bench

Adopted 2026-07-09 after parallel sessions sharing one checkout produced
tangled commits, swept-up work, and lost changes.

## The rule

**One track = one branch = one git worktree = one session.** A track is one
coherent feature, fix, or documentation change. It owns its worktree; no other
session edits or commits there.

| Directory | Branch | Role |
|---|---|---|
| `~/Dev/galapagos` | `main` | primary checkout; never a shared scratchpad |
| `~/Dev/galapagos-runtime` | `next`, permanently | user-owned deployment bench |
| `~/Dev/galapagos-<track>` | `feat/<track>` etc. | isolated development track |

Create a track with:

```sh
git worktree add ~/Dev/galapagos-<track> -b feat/<track> main
```

After its PR merges, retire it with `git worktree remove` followed by
`git branch -d`. Never commit from a checkout the track does not own. Stage
explicit paths rather than `git add .` or `git add -A`; keep commits scoped to
one intent and leave the worktree clean.

## Test in the track

Use Bun for GalapagOS dependencies and top-level scripts:

```sh
cd ~/Dev/galapagos-<track>
bun install --frozen-lockfile
rm -rf dist-node
bun run test
bun run build
git diff --check
```

`bun install --frozen-lockfile` is a clean-track verification command. A
dependency change must update both `package.json` and `bun.lock`. GalapagOS
still supervises npm, pnpm, Yarn, and Bun repositories, so do not rewrite
npm-specific fixtures or historical handoffs that truthfully describe their
original commands.

## Deploy to localhost

The user's permanent processes run from `~/Dev/galapagos-runtime` on `next`:
the daemon on port 4517 under `tsx watch`, and the Next UI on port 3005. They
reload when files in that checkout change.

**Deploying means a Git merge into the runtime checkout. Nothing else.** Never
edit, commit, copy files into, check out another branch in, start, stop,
restart, or kill processes from `~/Dev/galapagos-runtime`.

Deploy a tested track with exactly:

```sh
git -C ~/Dev/galapagos-runtime merge feat/<track>
```

If and only if the merge changed `package.json` or `bun.lock`, update the
running bench's installed dependencies with:

```sh
cd ~/Dev/galapagos-runtime
bun install
```

Do not use `bun install --frozen-lockfile` as the running-bench install step.
Batch compatible commits into one tested merge when possible so daemon-side
watch reloads do not repeatedly interrupt active work.

## Verify what is live

Before claiming a deployment, verify both services:

```sh
curl -s localhost:4517/health
curl -s -o /dev/null -w "%{http_code}\n" localhost:3005
```

Health must report `"branch":"next"` and the expected revision, and the UI
must return 200. A UI-only merge does not reload the daemon, so its health
revision may legitimately remain on the preceding daemon-side commit even
though the web watcher has reloaded.

If a change does not appear, first confirm each listener's working directory:

```sh
lsof -nP -iTCP:4517 -sTCP:LISTEN
lsof -a -p <daemon-pid> -d cwd
lsof -nP -iTCP:3005 -sTCP:LISTEN
lsof -a -p <web-pid> -d cwd
git -C ~/Dev/galapagos-runtime log --oneline -3
```

Both working directories must be `~/Dev/galapagos-runtime`. If either process
belongs to another checkout, stop and tell the user; do not work around it or
kill it. For a UI-only change, ask the user to hard-reload the browser and
inspect the existing web-process output for compile errors.

## Main and bench reset

`main` receives tested work through one PR per track. Never commit directly to
`main`, and never use `next` as the only home of a change.

Only the user may hard-reset the runtime bench. The normal non-destructive way
to re-align `next` after PRs merge is:

```sh
git -C ~/Dev/galapagos-runtime merge main
```

## Known product boundary

The sidebar trio (confidence gauge, attention queue, and specifics panel) is
consciously parked under the 2026-07-10 ruling. It needs its own rework track;
unrelated tracks must not silently redesign it.
