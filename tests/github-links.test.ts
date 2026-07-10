import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveWorkerGithub, originUrlFromGitConfig } from "../src/server/github-links";

/** A fake checkout: .git/config with the given remote url (or none). */
function fixtureCheckout(remoteUrl: string | null): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "glp-gh-"));
  mkdirSync(path.join(root, ".git"));
  const remote = remoteUrl
    ? `[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
    : "";
  writeFileSync(
    path.join(root, ".git", "config"),
    `[core]\n\trepositoryformatversion = 0\n${remote}`,
  );
  return root;
}

test("originUrlFromGitConfig reads the origin url; absence yields null", () => {
  const root = fixtureCheckout("git@github.com:taan07/GalapagOS.git");
  assert.equal(originUrlFromGitConfig(root), "git@github.com:taan07/GalapagOS.git");

  assert.equal(originUrlFromGitConfig(fixtureCheckout(null)), null);
  assert.equal(originUrlFromGitConfig(mkdtempSync(path.join(os.tmpdir(), "glp-empty-"))), null);
});

test("a worktree's pointer .git file resolves to the shared config", () => {
  const repo = fixtureCheckout("https://github.com/taan07/GalapagOS.git");
  // Simulate `git worktree add`: .git is a file pointing at the repo's
  // .git/worktrees/<name> gitdir; config lives two levels up.
  const gitdir = path.join(repo, ".git", "worktrees", "track");
  mkdirSync(gitdir, { recursive: true });
  const worktree = mkdtempSync(path.join(os.tmpdir(), "glp-wt-"));
  writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitdir}\n`);

  assert.equal(originUrlFromGitConfig(worktree), "https://github.com/taan07/GalapagOS.git");
});

test("deriveWorkerGithub composes branch, base-commit, and claim-file links", () => {
  const root = fixtureCheckout("git@github.com:taan07/GalapagOS.git");
  const github = deriveWorkerGithub({
    rootPath: root,
    branch: "galapagos/worker/auth-ui",
    baseSha: "b".repeat(40),
    claimFiles: ["src/auth/login.ts"],
  });
  assert.ok(github);
  assert.equal(github.webBase, "https://github.com/taan07/GalapagOS");
  assert.equal(github.branchUrl, `${github.webBase}/tree/galapagos/worker/auth-ui`);
  assert.equal(github.baseCommitUrl, `${github.webBase}/commit/${"b".repeat(40)}`);
  assert.equal(
    github.fileUrls["src/auth/login.ts"],
    `${github.webBase}/blob/galapagos/worker/auth-ui/src/auth/login.ts`,
  );
});

test("a non-GitHub remote yields null links, never a guess", () => {
  const root = fixtureCheckout("git@gitlab.com:owner/repo.git");
  assert.equal(
    deriveWorkerGithub({ rootPath: root, branch: "b", baseSha: null, claimFiles: [] }),
    null,
  );
});
