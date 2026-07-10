// Pure GitHub URL derivation: turn a git remote URL into web links for the
// completed-worker surface (branch changelog, committed docs). Every function
// returns null rather than guessing — a non-GitHub remote or unparseable URL
// simply yields no link, and the UI states that honestly.

/** `https://github.com/owner/repo` from a remote URL, or null when not GitHub. */
export function githubWebBase(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return null;
  }
  // git@github.com:owner/repo(.git)
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(trimmed);
  if (scp) {
    return `https://github.com/${scp[1]}/${scp[2]}`;
  }
  // ssh://git@github.com/owner/repo(.git) | https://github.com/owner/repo(.git)
  const url = /^(?:ssh:\/\/git@|https?:\/\/)github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
    trimmed,
  );
  if (url) {
    return `https://github.com/${url[1]}/${url[2]}`;
  }
  return null;
}

/** Link to a branch's tree — the changelog view of a worker's branch. */
export function githubBranchUrl(webBase: string, branch: string): string {
  return `${webBase}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
}

/** Link to a file blob at a ref — the committed docs/galapagos record. */
export function githubBlobUrl(webBase: string, ref: string, filePath: string): string {
  const refPart = ref.split("/").map(encodeURIComponent).join("/");
  const pathPart = filePath.split("/").map(encodeURIComponent).join("/");
  return `${webBase}/blob/${refPart}/${pathPart}`;
}
