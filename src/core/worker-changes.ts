// Pure composition for the /workers "the work" card (track F): commit-log
// parsing and the check-view assembly whose `fresh` flag is the feature's
// entire epistemic claim — a passing run counts as green ONLY against the
// worktree's exact current key. Structural types keep core free of adapter
// imports.

export type CheckRunLike = {
  status: "passed" | "failed";
  summary: string;
  head_sha: string;
  created_at: string;
};

export type CheckView = {
  key: string;
  status: "passed" | "failed";
  summary: string;
  fresh: boolean;
  createdAt: string;
};

/**
 * One view per check key that has EVER run for this scope, in the caller's
 * canonical key order. `fresh` is a plain equality against the live workspace
 * key: any commit or uncommitted byte since the run reads as stale — a green
 * check against code that has since changed is not proof of anything.
 */
export function checkViewsFrom(
  keys: readonly string[],
  latest: ReadonlyMap<string, CheckRunLike>,
  workspaceKey: string,
): CheckView[] {
  return keys.flatMap((key) => {
    const run = latest.get(key);
    if (!run) {
      return [];
    }
    return [
      {
        key,
        status: run.status,
        summary: run.summary,
        fresh: run.head_sha === workspaceKey,
        createdAt: run.created_at,
      },
    ];
  });
}

/**
 * Parse `git log --format=%h%x00%s` output. %s is the subject line — git
 * strips newlines from it, so line-per-record then NUL-per-field never tears.
 */
export function parseCommitLog(output: string): { sha: string; subject: string }[] {
  return output
    .split("\n")
    .filter((line) => line.includes("\0"))
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\0");
      return { sha, subject };
    });
}
