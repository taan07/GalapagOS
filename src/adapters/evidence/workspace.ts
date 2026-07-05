// The workspace evidence key: the exact state a check ran against, and the
// string evidence_runs.head_sha stores. `<sha>` for a clean tree,
// `<sha>+dirty.<fingerprint>` for a dirty one — so freshness is a plain
// equality check and ANY commit or uncommitted edit since the run makes the
// evidence stale (architecture §9: evidence that predates a head/dirty-state
// change drains). Built on the ported git-truth observer — never ad hoc.
import { observeGitRepository } from "../git/runner";
import type { GitCommandRunner } from "../../core/git/types";

export type WorkspaceEvidence = {
  /** The composite evidence key — what evidence_runs.head_sha stores. */
  key: string;
  /** The bare commit sha, for display. */
  headSha: string;
  dirty: boolean;
};

export async function observeWorkspaceEvidence(
  cwd: string,
  runner?: GitCommandRunner,
): Promise<WorkspaceEvidence> {
  const observation = await (runner
    ? observeGitRepository(cwd, runner)
    : observeGitRepository(cwd));
  const headSha = observation.headSha ?? "no-head";
  const dirty =
    observation.status.stagedFiles.length > 0 ||
    observation.status.dirtyFiles.length > 0 ||
    observation.status.untrackedFiles.length > 0;
  return {
    key: dirty ? `${headSha}+dirty.${observation.dirtyFingerprint.slice(0, 16)}` : headSha,
    headSha,
    dirty,
  };
}
