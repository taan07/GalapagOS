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
  "remote",
  "rev-parse",
  "status",
  "symbolic-ref",
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
  if (command === "remote" && rest[0] !== "get-url") {
    throw new Error(`Refusing to run mutating git remote command: git ${args.join(" ")}`);
  }
  // symbolic-ref READS with one ref name; a second positional arg writes it.
  if (command === "symbolic-ref" && rest.filter((arg) => !arg.startsWith("-")).length > 1) {
    throw new Error(`Refusing to run mutating git symbolic-ref command: git ${args.join(" ")}`);
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

/**
 * The origin remote's URL, read on demand — a remote can change, so nothing
 * caches it in the DB. Null when there is no remote (a local-only repo is a
 * normal, honest state, not an error).
 */
export async function getRemoteUrl(
  cwd: string,
  runner: GitCommandRunner = new LocalGitCommandRunner(),
): Promise<string | null> {
  try {
    const output = await runner.runGit(["remote", "get-url", "origin"], cwd);
    return output.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The repo's default branch (where records commit), best-effort: origin's
 * HEAD when known, else "main". Wrong only in exotic setups, and a wrong ref
 * yields a 404 link — never fabricated content.
 */
export async function getDefaultBranch(
  cwd: string,
  runner: GitCommandRunner = new LocalGitCommandRunner(),
): Promise<string> {
  try {
    const output = await runner.runGit(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      cwd,
    );
    const short = output.trim(); // "origin/main"
    const slash = short.indexOf("/");
    return slash > 0 ? short.slice(slash + 1) : short || "main";
  } catch {
    return "main";
  }
}
