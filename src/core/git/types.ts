export type GitWorktreeStatus = "linked" | "main" | "bare" | "detached" | "prunable";

export interface GitWorktreeObservation {
  id: string;
  path: string;
  branch: string | null;
  headSha: string | null;
  isMainWorktree: boolean;
  status: GitWorktreeStatus;
  prunableReason: string | null;
}

export interface GitAheadBehind {
  ahead: number;
  behind: number;
}

export interface GitBranchObservation {
  name: string;
  headSha: string;
  isActive: boolean;
  isLinkedWorktree: boolean;
  upstream: string | null;
  aheadBehind: GitAheadBehind | null;
  lastCommitSummary: string | null;
}

export interface GitFileStatus {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitStatusObservation {
  branch: string | null;
  upstream: string | null;
  aheadBehind: GitAheadBehind | null;
  stagedFiles: GitFileStatus[];
  dirtyFiles: GitFileStatus[];
  untrackedFiles: GitFileStatus[];
  ignoredFiles: GitFileStatus[];
}

export interface GitDiffFileSummary {
  path: string;
  added: number | null;
  deleted: number | null;
  isBinary: boolean;
}

export interface GitDiffSummary {
  unstaged: GitDiffFileSummary[];
  staged: GitDiffFileSummary[];
  unstagedRaw: string;
  stagedRaw: string;
}

export interface GitObservation {
  repoRoot: string;
  activeBranch: string | null;
  headSha: string | null;
  worktrees: GitWorktreeObservation[];
  branches: GitBranchObservation[];
  status: GitStatusObservation;
  diffSummary: GitDiffSummary;
  dirtyFingerprint: string;
  observedAt: string;
}

export interface RawGitObservationOutput {
  repoRoot: string;
  activeBranch: string;
  headSha: string;
  worktreeListPorcelain: string;
  branchVerbose: string;
  statusPorcelain: string;
  unstagedNumstat: string;
  stagedNumstat: string;
}

export interface GitCommandRunner {
  runGit(args: readonly string[], cwd: string): Promise<string>;
}
