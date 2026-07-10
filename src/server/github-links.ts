// Derive a worker's GitHub links from the project's own git config — a plain
// file read, no child process, safe in a route handler. Returns null rather
// than guessing: a non-GitHub remote, a missing config, or a gitdir layout we
// don't recognize simply yields no links, and the UI stays honest about it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  githubBranchUrl,
  githubBlobUrl,
  githubCommitUrl,
  githubWebBase,
} from "../core/git/github-url";
import type { WorkerGithubView } from "../ui/types";

/**
 * The `[remote "origin"] url` from a checkout's .git/config. Handles the
 * worktree case where `.git` is a pointer file (`gitdir: <path>`) by following
 * it one hop to the real gitdir (worktree gitdirs live under
 * <repo>/.git/worktrees/<name>, whose config is two levels up).
 */
export function originUrlFromGitConfig(rootPath: string): string | null {
  const configText = readGitConfig(rootPath);
  if (!configText) {
    return null;
  }
  let inOrigin = false;
  for (const rawLine of configText.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    if (inOrigin) {
      const match = /^url\s*=\s*(.+)$/.exec(line);
      if (match?.[1]) {
        return match[1].trim();
      }
    }
  }
  return null;
}

function readGitConfig(rootPath: string): string | null {
  const dotGit = join(rootPath, ".git");
  try {
    return readFileSync(join(dotGit, "config"), "utf8");
  } catch {
    // .git may be a worktree pointer file rather than a directory.
  }
  try {
    const pointer = readFileSync(dotGit, "utf8");
    const match = /^gitdir:\s*(.+)$/m.exec(pointer);
    if (!match?.[1]) {
      return null;
    }
    // <repo>/.git/worktrees/<name> → the shared config at <repo>/.git/config.
    return readFileSync(join(match[1].trim(), "..", "..", "config"), "utf8");
  } catch {
    return null;
  }
}

/** All the links the drilldown renders, or null when there's no GitHub remote. */
export function deriveWorkerGithub(input: {
  rootPath: string;
  branch: string;
  baseSha: string | null;
  claimFiles: string[];
}): WorkerGithubView | null {
  const remote = originUrlFromGitConfig(input.rootPath);
  const webBase = remote ? githubWebBase(remote) : null;
  if (!webBase) {
    return null;
  }
  const fileUrls: Record<string, string> = {};
  for (const file of input.claimFiles) {
    fileUrls[file] = githubBlobUrl(webBase, input.branch, file);
  }
  return {
    webBase,
    branchUrl: githubBranchUrl(webBase, input.branch),
    baseCommitUrl: input.baseSha ? githubCommitUrl(webBase, input.baseSha) : null,
    fileUrls,
  };
}
