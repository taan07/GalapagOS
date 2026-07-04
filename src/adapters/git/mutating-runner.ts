// The ONLY git mutation Chunk 2 is allowed: committing the records store in
// the TARGET repo. The surface stays as narrow as project-init (architecture
// §5): stage only paths under docs/galapagos/, never anything else; if the
// repo is mid-merge/rebase or the commit fails, skip and surface — never
// block the turn, never stage user files. Tags/worktrees arrive in later
// chunks.
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
