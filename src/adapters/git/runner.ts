// Ported from the prior prototype's git-truth adapter (read-only observation).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeGitObservation } from "../../core/git/parsers";
import type {
  GitCommandRunner,
  GitObservation,
  RawGitObservationOutput,
} from "../../core/git/types";

const execFileAsync = promisify(execFile);

const READ_ONLY_GIT_COMMANDS = new Set([
  "branch",
  "diff",
  "log",
  "rev-parse",
  "status",
  "worktree",
]);

function assertReadOnlyGitArgs(args: readonly string[]): void {
  const [command, ...rest] = args;

  if (!command || !READ_ONLY_GIT_COMMANDS.has(command)) {
    throw new Error(`Refusing to run unsupported git command: git ${args.join(" ")}`);
  }

  if (command === "worktree" && rest[0] !== "list") {
    throw new Error(`Refusing to run mutating git worktree command: git ${args.join(" ")}`);
  }
}

export class LocalGitCommandRunner implements GitCommandRunner {
  async runGit(args: readonly string[], cwd: string): Promise<string> {
    assertReadOnlyGitArgs(args);

    try {
      const { stdout } = await execFileAsync("git", [...args], {
        cwd,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${message}`);
    }
  }
}

async function collectRawGitObservation(
  cwd: string,
  runner: GitCommandRunner,
): Promise<RawGitObservationOutput> {
  const repoRoot = await runner.runGit(["rev-parse", "--show-toplevel"], cwd);
  const observationCwd = repoRoot.trim() || cwd;

  const [activeBranch, headSha, worktreeListPorcelain, branchVerbose, statusPorcelain, unstagedNumstat, stagedNumstat] =
    await Promise.all([
      runner.runGit(["branch", "--show-current"], observationCwd),
      runner.runGit(["rev-parse", "--verify", "HEAD"], observationCwd),
      runner.runGit(["worktree", "list", "--porcelain"], observationCwd),
      runner.runGit(["branch", "--no-color", "--verbose", "--verbose"], observationCwd),
      runner.runGit(["status", "--porcelain=v1", "-z", "--branch"], observationCwd),
      runner.runGit(["diff", "--numstat", "--find-renames"], observationCwd),
      runner.runGit(["diff", "--cached", "--numstat", "--find-renames"], observationCwd),
    ]);

  return {
    repoRoot,
    activeBranch,
    headSha,
    worktreeListPorcelain,
    branchVerbose,
    statusPorcelain,
    unstagedNumstat,
    stagedNumstat,
  };
}

export async function observeGitRepository(
  cwd: string,
  runner: GitCommandRunner = new LocalGitCommandRunner(),
): Promise<GitObservation> {
  const raw = await collectRawGitObservation(cwd, runner);
  return normalizeGitObservation(raw);
}

export async function recentLog(
  cwd: string,
  runner: GitCommandRunner = new LocalGitCommandRunner(),
  limit = 15,
): Promise<string> {
  return runner.runGit(["log", "--oneline", "--decorate", `-${limit}`], cwd);
}
