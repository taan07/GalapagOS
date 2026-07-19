# Workspace evidence limits

Workspace evidence is intentionally bounded: it is an honesty mechanism, not
a best-effort checksum that can consume arbitrary daemon memory or follow a
worker's links outside its worktree. The defaults are exported from
`src/adapters/evidence/workspace.ts` and are included in every worker-changes
response:

- 512 untracked entries;
- 1 MiB per untracked regular file or symlink target text;
- 8 MiB aggregate untracked evidence;
- 4 MiB stdout for each serial git stream, 8 MiB aggregate stdout, and 64 KiB stderr;
- at most four untracked files read concurrently.

The observer streams file bytes through hashes, uses opened handles and
identity checks before/after reading, and hashes untracked symlink text without
following it. A limit, special file, unreadable/disappeared path, replacement
race, or git cap yields `available: false` with usage and a reason. That state
is indeterminate: checks, audit links, confidence inputs, and judgment legs
must treat prior evidence as stale or unknown; it never creates a partial key.
