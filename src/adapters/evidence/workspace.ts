// The workspace evidence key: the exact state a check ran against, and the
// string evidence_runs.head_sha stores. `<sha>` for a clean tree,
// `<sha>+dirty.<hash>` for a dirty one — so freshness is a plain equality
// check and ANY commit or uncommitted edit since the run makes the evidence
// stale (architecture §9).
//
// The dirty hash is CONTENT-AWARE (adversarial review 2026-07-05, finding
// C1): the original key hashed status paths and numstat line COUNTS, so a
// worker could swap the content of an already-modified line — or rewrite an
// untracked file outright — without moving the key, keeping stale verdicts
// "fresh". The key now hashes the full unstaged and staged patch text plus a
// content hash of every untracked file: no byte changes without the key
// changing.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseStatusPorcelain } from "../../core/git/parsers";
import type { GitCommandRunner } from "../../core/git/types";
import { LocalGitCommandRunner } from "../git/runner";

export type WorkspaceEvidence = {
  /** The composite evidence key — what evidence_runs.head_sha stores. */
  key: string;
  /** The bare commit sha, for display. */
  headSha: string;
  dirty: boolean;
};

export async function observeWorkspaceEvidence(
  cwd: string,
  runner: GitCommandRunner = new LocalGitCommandRunner(),
): Promise<WorkspaceEvidence> {
  const headSha = (await runner.runGit(["rev-parse", "--verify", "HEAD"], cwd)).trim() || "no-head";
  const [unstagedPatch, stagedPatch, porcelainOutput] = await Promise.all([
    runner.runGit(["diff"], cwd),
    runner.runGit(["diff", "--cached"], cwd),
    runner.runGit(["status", "--porcelain=v1", "-z", "-uall"], cwd),
  ]);
  const status = parseStatusPorcelain(porcelainOutput);
  const dirty =
    status.stagedFiles.length > 0 ||
    status.dirtyFiles.length > 0 ||
    status.untrackedFiles.length > 0;
  if (!dirty) {
    return { key: headSha, headSha, dirty };
  }

  const hash = createHash("sha256");
  hash.update(unstagedPatch);
  hash.update("\0");
  hash.update(stagedPatch);
  hash.update("\0");
  // Untracked content is invisible to git diff — hash every file's bytes so
  // rewriting an untracked file always moves the key.
  for (const entry of [...status.untrackedFiles].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path);
    hash.update("\0");
    try {
      hash.update(readFileSync(path.join(cwd, entry.path)));
    } catch {
      hash.update("unreadable"); // deletion/permission change still moves the key
    }
    hash.update("\0");
  }

  return {
    key: `${headSha}+dirty.${hash.digest("hex").slice(0, 16)}`,
    headSha,
    dirty,
  };
}
