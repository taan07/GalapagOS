// The narrow mutating-git surface. Chunk 2: committing the records store in
// the TARGET repo (stage only docs/galapagos/, never anything else; skip and
// surface mid-merge/rebase — never block the turn, never stage user files).
// Chunk 3 extends it exactly as far as `worktree add`/`worktree remove` for
// worker worktrees under <stateDir>/worktrees/<project-slug>/<lane-slug>/ —
// NEVER inside the target repo. Tags arrive with the bloodline chunk.
//
// mergeBranch is the one operation that mutates the target repo's tree (not
// just docs/galapagos/): landing a worker branch into the main checkout. It
// exists only behind the user's explicit say-so (see merge_worker / the
// manager doctrine) and self-heals on conflict — it aborts and restores the
// checkout rather than leaving the repo mid-merge.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { RECORDS_DIR } from "../records/store";

const execFileAsync = promisify(execFile);

export type CommitRecordsResult =
  | { status: "committed"; sha: string }
  | { status: "nothing_to_commit" }
  | { status: "skipped"; reason: string };

async function git(projectRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function inProgressOperation(projectRoot: string): string | null {
  const gitDir = path.join(projectRoot, ".git");
  if (existsSync(path.join(gitDir, "MERGE_HEAD"))) {
    return "merge in progress";
  }
  if (
    existsSync(path.join(gitDir, "rebase-merge")) ||
    existsSync(path.join(gitDir, "rebase-apply"))
  ) {
    return "rebase in progress";
  }
  if (existsSync(path.join(gitDir, "CHERRY_PICK_HEAD"))) {
    return "cherry-pick in progress";
  }
  return null;
}

/**
 * Commit changes under docs/galapagos/ in the target repo. Uses a pathspec
 * commit (`git commit -- docs/galapagos`) so anything the user has staged
 * outside the records dir is left exactly as it was — staged, uncommitted.
 */
export async function commitRecords(
  projectRoot: string,
  message: string,
): Promise<CommitRecordsResult> {
  try {
    const operation = inProgressOperation(projectRoot);
    if (operation) {
      return { status: "skipped", reason: `target repo has a ${operation}` };
    }

    const dirty = await git(projectRoot, ["status", "--porcelain", "--", RECORDS_DIR]);
    if (!dirty.trim()) {
      return { status: "nothing_to_commit" };
    }

    await git(projectRoot, ["add", "-A", "--", RECORDS_DIR]);
    await git(projectRoot, ["commit", "-m", message, "--", RECORDS_DIR]);
    const sha = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();
    return { status: "committed", sha };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "skipped", reason };
  }
}

export type MergeResult =
  | { status: "merged"; sha: string; into: string }
  | { status: "conflict"; files: string[]; into: string }
  | { status: "failed"; reason: string };

/**
 * Merge a worker branch into the target repo's current checkout. Always a
 * merge commit (--no-ff) so every landing is one visible, revertable node in
 * history. On conflict the merge is aborted and the working tree restored —
 * the user's repo is never left mid-merge — and the conflicting files come
 * back for the user to resolve by hand. The worktree and branch are left
 * intact; merging integrates commits, it does not retire the worker.
 */
export async function mergeBranch(input: {
  projectRoot: string;
  branch: string;
  message: string;
}): Promise<MergeResult> {
  try {
    const operation = inProgressOperation(input.projectRoot);
    if (operation) {
      return { status: "failed", reason: `the target repo has a ${operation} — resolve it first` };
    }
    try {
      await git(input.projectRoot, ["rev-parse", "--verify", `refs/heads/${input.branch}`]);
    } catch {
      return { status: "failed", reason: `branch "${input.branch}" does not exist in the target repo` };
    }
    const head = (await git(input.projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const into = head === "HEAD" ? "(detached HEAD)" : head;

    try {
      await git(input.projectRoot, ["merge", "--no-ff", "-m", input.message, input.branch]);
    } catch (error) {
      // A merge now in progress means real conflicts — abort so the user's
      // checkout is exactly as it was, and hand back the conflicting paths.
      if (inProgressOperation(input.projectRoot) === "merge in progress") {
        const conflicted = await git(input.projectRoot, [
          "diff",
          "--name-only",
          "--diff-filter=U",
        ]).catch(() => "");
        const files = conflicted
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        await git(input.projectRoot, ["merge", "--abort"]).catch(() => {});
        return { status: "conflict", files, into };
      }
      // Refused before starting (e.g. local changes would be overwritten):
      // git's stderr is the actionable message — surface it verbatim.
      const stderr = (error as { stderr?: string }).stderr;
      return {
        status: "failed",
        reason: (stderr && stderr.trim()) || (error instanceof Error ? error.message : String(error)),
      };
    }

    const sha = (await git(input.projectRoot, ["rev-parse", "HEAD"])).trim();
    return { status: "merged", sha, into };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Canonical worker worktree location (architecture §6). */
export function workerWorktreePath(
  stateDir: string,
  projectSlug: string,
  laneSlug: string,
): string {
  return path.join(path.resolve(stateDir), "worktrees", projectSlug, laneSlug);
}

/**
 * The placement guard both worktree mutations run behind: the path must live
 * under <stateDir>/worktrees/ and must NOT be inside the target repo, which
 * stays clean of orchestration artifacts. Violations throw — they are
 * programming errors, not operational conditions to report and continue past.
 */
function assertWorktreePlacement(input: {
  projectRoot: string;
  worktreePath: string;
  stateDir: string;
}): void {
  const worktreesRoot = path.join(path.resolve(input.stateDir), "worktrees");
  const resolved = path.resolve(input.worktreePath);
  if (resolved !== worktreesRoot && !resolved.startsWith(`${worktreesRoot}${path.sep}`)) {
    throw new Error(
      `Refusing worktree outside ${worktreesRoot}: ${resolved}. Worker worktrees live only under the state dir.`,
    );
  }
  const projectRoot = path.resolve(input.projectRoot);
  if (resolved === projectRoot || resolved.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error(
      `Refusing worktree inside the target repo (${projectRoot}): ${resolved}. The target repo stays clean of orchestration artifacts.`,
    );
  }
}

export type WorktreeResult =
  | { status: "created"; worktreePath: string; branch: string }
  | { status: "removed"; worktreePath: string }
  | { status: "failed"; reason: string };

/**
 * Create a worker worktree with its own branch at the lane's base sha.
 * Operational failures (directory already exists from an earlier lane,
 * branch name taken, bad sha) come back as { status: "failed" } with git's
 * reason — the manager reads it and picks a different lane name.
 */
export async function addWorktree(input: {
  projectRoot: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
  stateDir: string;
}): Promise<WorktreeResult> {
  assertWorktreePlacement(input);
  if (existsSync(input.worktreePath)) {
    return {
      status: "failed",
      reason: `Worktree directory already exists at ${input.worktreePath} — a previous lane with this name left its work there. Pick a different lane name.`,
    };
  }
  try {
    await git(input.projectRoot, [
      "worktree",
      "add",
      input.worktreePath,
      "-b",
      input.branch,
      input.baseSha,
    ]);
    return { status: "created", worktreePath: input.worktreePath, branch: input.branch };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Remove a worker worktree. Deliberately NOT called on worker stop — the
 * worktree is the work product and stays inspectable; this exists to clean
 * up a half-created worktree when a spawn fails partway. --force because the
 * cleanup target may hold a dirty tree nobody will ever resume. Pass the
 * branch addWorktree created so it is deleted too — a leftover branch would
 * make every future spawn under the same lane name fail on "branch already
 * exists", permanently burning the name.
 */
export async function removeWorktree(input: {
  projectRoot: string;
  worktreePath: string;
  stateDir: string;
  branch?: string;
}): Promise<WorktreeResult> {
  assertWorktreePlacement(input);
  try {
    await git(input.projectRoot, ["worktree", "remove", "--force", input.worktreePath]);
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  if (input.branch) {
    // Best-effort: the branch may not exist if the add failed before -b.
    await git(input.projectRoot, ["branch", "-D", input.branch]).catch(() => {});
  }
  return { status: "removed", worktreePath: input.worktreePath };
}
