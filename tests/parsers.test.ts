import test from "node:test";
import assert from "node:assert/strict";
import {
  createDirtyFingerprint,
  normalizeGitObservation,
  parseBranchVerbose,
  parseNumstat,
  parseStatusPorcelain,
  parseWorktreeListPorcelain,
} from "../src/core/git/parsers";

test("parses git worktree list porcelain output", () => {
  const worktrees = parseWorktreeListPorcelain(`worktree /repo/main
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo/feature
HEAD 2222222222222222222222222222222222222222
branch refs/heads/codex/git-truth-adapter

worktree /repo/detached
HEAD 3333333333333333333333333333333333333333
detached
`);

  assert.deepEqual(worktrees, [
    {
      id: "/repo/main",
      path: "/repo/main",
      branch: "main",
      headSha: "1111111111111111111111111111111111111111",
      isMainWorktree: true,
      status: "main",
      prunableReason: null,
    },
    {
      id: "/repo/feature",
      path: "/repo/feature",
      branch: "codex/git-truth-adapter",
      headSha: "2222222222222222222222222222222222222222",
      isMainWorktree: false,
      status: "linked",
      prunableReason: null,
    },
    {
      id: "/repo/detached",
      path: "/repo/detached",
      branch: null,
      headSha: "3333333333333333333333333333333333333333",
      isMainWorktree: false,
      status: "detached",
      prunableReason: null,
    },
  ]);
});

test("parses verbose branch output with active marker and upstream state", () => {
  const branches = parseBranchVerbose(`* codex/git-truth-adapter 95f2abc [origin/codex/git-truth-adapter: ahead 2, behind 1] implement adapter
+ codex/scaffold          8ab3def [origin/codex/scaffold] scaffold app
  main                    1234567 [origin/main: behind 3] baseline`);

  assert.deepEqual(branches, [
    {
      name: "codex/git-truth-adapter",
      headSha: "95f2abc",
      isActive: true,
      isLinkedWorktree: false,
      upstream: "origin/codex/git-truth-adapter",
      aheadBehind: { ahead: 2, behind: 1 },
      lastCommitSummary: "implement adapter",
    },
    {
      name: "codex/scaffold",
      headSha: "8ab3def",
      isActive: false,
      isLinkedWorktree: true,
      upstream: "origin/codex/scaffold",
      aheadBehind: null,
      lastCommitSummary: "scaffold app",
    },
    {
      name: "main",
      headSha: "1234567",
      isActive: false,
      isLinkedWorktree: false,
      upstream: "origin/main",
      aheadBehind: { ahead: 0, behind: 3 },
      lastCommitSummary: "baseline",
    },
  ]);
});

test("parses detached branch verbose output", () => {
  const branches = parseBranchVerbose("* (no branch) f1a9c28 detached worktree commit\n  main 1234567 baseline");

  assert.deepEqual(branches, [
    {
      name: "(no branch)",
      headSha: "f1a9c28",
      isActive: true,
      isLinkedWorktree: false,
      upstream: null,
      aheadBehind: null,
      lastCommitSummary: "detached worktree commit",
    },
    {
      name: "main",
      headSha: "1234567",
      isActive: false,
      isLinkedWorktree: false,
      upstream: null,
      aheadBehind: null,
      lastCommitSummary: "baseline",
    },
  ]);
});

test("parses porcelain status into staged dirty and untracked buckets", () => {
  const status = parseStatusPorcelain(
    [
      "## codex/git-truth-adapter...origin/codex/git-truth-adapter [ahead 1]",
      " M docs/loops/progress/git-truth-adapter.md",
      "M  src/git-truth/index.ts",
      "A  tests/parsers.test.ts",
      "R  src/new-name.ts",
      "src/old-name.ts",
      "?? package.json",
      "",
    ].join("\0"),
  );

  assert.equal(status.branch, "codex/git-truth-adapter");
  assert.equal(status.upstream, "origin/codex/git-truth-adapter");
  assert.deepEqual(status.aheadBehind, { ahead: 1, behind: 0 });
  assert.deepEqual(
    status.dirtyFiles.map((file) => file.path),
    ["docs/loops/progress/git-truth-adapter.md"],
  );
  assert.deepEqual(
    status.stagedFiles.map((file) => [file.path, file.originalPath]),
    [
      ["src/git-truth/index.ts", null],
      ["tests/parsers.test.ts", null],
      ["src/new-name.ts", "src/old-name.ts"],
    ],
  );
  assert.deepEqual(
    status.untrackedFiles.map((file) => file.path),
    ["package.json"],
  );
});

test("parses numstat including binary files", () => {
  assert.deepEqual(parseNumstat("12\t3\tsrc/git-truth/index.ts\n-\t-\tassets/snapshot.png\n"), [
    {
      path: "src/git-truth/index.ts",
      added: 12,
      deleted: 3,
      isBinary: false,
    },
    {
      path: "assets/snapshot.png",
      added: null,
      deleted: null,
      isBinary: true,
    },
  ]);
});

test("dirty fingerprint is stable and changes when observed status changes", () => {
  const base = {
    headSha: "1111111",
    branch: "main",
    status: parseStatusPorcelain("## main\0 M docs/a.md\0"),
    diffSummary: {
      unstaged: parseNumstat("1\t0\tdocs/a.md\n"),
      staged: [],
      unstagedRaw: "1\t0\tdocs/a.md\n",
      stagedRaw: "",
    },
  };

  const same = createDirtyFingerprint(base);
  const sameAgain = createDirtyFingerprint(base);
  const changed = createDirtyFingerprint({
    ...base,
    status: parseStatusPorcelain("## main\0 M docs/b.md\0"),
  });

  assert.equal(same, sameAgain);
  assert.notEqual(same, changed);
});

test("normalizes a full raw observation", () => {
  const observed = normalizeGitObservation(
    {
      repoRoot: "/repo/main\n",
      activeBranch: "main\n",
      headSha: "1111111111111111111111111111111111111111\n",
      worktreeListPorcelain: `worktree /repo/main
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main
`,
      branchVerbose: "* main 1111111 [origin/main] initial commit\n",
      statusPorcelain: "## main...origin/main\0 M docs/a.md\0?? docs/b.md\0",
      unstagedNumstat: "1\t0\tdocs/a.md\n",
      stagedNumstat: "",
    },
    "2026-06-20T00:00:00.000Z",
  );

  assert.equal(observed.repoRoot, "/repo/main");
  assert.equal(observed.activeBranch, "main");
  assert.equal(observed.headSha, "1111111111111111111111111111111111111111");
  assert.equal(observed.worktrees.length, 1);
  assert.equal(observed.branches.length, 1);
  assert.equal(observed.status.dirtyFiles.length, 1);
  assert.equal(observed.status.untrackedFiles.length, 1);
  assert.equal(observed.diffSummary.unstaged.length, 1);
  assert.match(observed.dirtyFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(observed.observedAt, "2026-06-20T00:00:00.000Z");
});
