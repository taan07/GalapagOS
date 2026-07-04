import test from "node:test";
import assert from "node:assert/strict";
import { LocalGitCommandRunner, observeGitRepository } from "../src/adapters/git/runner";
import type { GitCommandRunner } from "../src/core/git/types";

class FixtureGitRunner implements GitCommandRunner {
  readonly commands: string[] = [];

  async runGit(args: readonly string[], cwd: string): Promise<string> {
    this.commands.push(`git ${args.join(" ")} @ ${cwd}`);

    switch (args.join(" ")) {
      case "rev-parse --show-toplevel":
        return "/repo/main\n";
      case "branch --show-current":
        return "main\n";
      case "rev-parse --verify HEAD":
        return "1111111111111111111111111111111111111111\n";
      case "worktree list --porcelain":
        return "worktree /repo/main\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n";
      case "branch --no-color --verbose --verbose":
        return "* main 1111111 [origin/main] initial commit\n";
      case "status --porcelain=v1 -z --branch":
        return "## main...origin/main\0";
      case "diff --numstat --find-renames":
      case "diff --cached --numstat --find-renames":
        return "";
      default:
        throw new Error(`Unexpected fixture command: git ${args.join(" ")}`);
    }
  }
}

test("observeGitRepository only asks the runner for read-only git observations", async () => {
  const runner = new FixtureGitRunner();
  const observation = await observeGitRepository("/repo/main", runner);

  assert.equal(observation.repoRoot, "/repo/main");
  assert.deepEqual(runner.commands, [
    "git rev-parse --show-toplevel @ /repo/main",
    "git branch --show-current @ /repo/main",
    "git rev-parse --verify HEAD @ /repo/main",
    "git worktree list --porcelain @ /repo/main",
    "git branch --no-color --verbose --verbose @ /repo/main",
    "git status --porcelain=v1 -z --branch @ /repo/main",
    "git diff --numstat --find-renames @ /repo/main",
    "git diff --cached --numstat --find-renames @ /repo/main",
  ]);
});

test("LocalGitCommandRunner rejects unsupported or mutating git commands before execution", async () => {
  const runner = new LocalGitCommandRunner();

  await assert.rejects(
    () => runner.runGit(["worktree", "add", "../other", "main"], "/repo/main"),
    /Refusing to run mutating git worktree command/,
  );
  await assert.rejects(
    () => runner.runGit(["checkout", "main"], "/repo/main"),
    /Refusing to run unsupported git command/,
  );
});
