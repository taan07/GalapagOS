// I/O for the tripwires leg: gather what the worker actually changed —
// committed AND uncommitted vs the lane base, plus untracked files — as
// parsed per-file diffs, then run the pure detector. Read-only git.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { TripwireFinding } from "../../core/confidence/types";
import {
  detectTripwires,
  parseUnifiedDiff,
  type ChangedFileDiff,
} from "../../core/legs/tripwires";
import { parseStatusPorcelain } from "../../core/git/parsers";
import { LocalGitCommandRunner } from "../git/runner";

const UNTRACKED_READ_LIMIT = 64 * 1024;

/**
 * Collect per-file diffs of everything the worker changed since the lane
 * base: `git diff -U0 <base>` covers tracked changes (committed and
 * uncommitted alike — exactly what the detective audit covers), and
 * untracked files are read from disk as all-added lines (bounded; binary
 * content is skipped — the patterns are text).
 */
export async function collectChangedFileDiffs(
  worktreePath: string,
  baseSha: string,
): Promise<ChangedFileDiff[]> {
  const runner = new LocalGitCommandRunner();
  const [diffOutput, porcelainOutput] = await Promise.all([
    runner.runGit(["diff", "-U0", baseSha], worktreePath),
    runner.runGit(["status", "--porcelain=v1", "-z", "-uall"], worktreePath),
  ]);

  const files = parseUnifiedDiff(diffOutput);
  const seen = new Set(files.map((file) => file.path));

  for (const entry of parseStatusPorcelain(porcelainOutput).untrackedFiles) {
    if (!entry.path || seen.has(entry.path)) {
      continue;
    }
    try {
      const content = readFileSync(path.join(worktreePath, entry.path), "utf8").slice(
        0,
        UNTRACKED_READ_LIMIT,
      );
      if (content.includes("\0")) {
        continue;
      }
      files.push({ path: entry.path, addedLines: content.split("\n"), removedLines: [] });
    } catch {
      // Unreadable untracked file: the audit already lists its path; the
      // content patterns simply cannot fire for it.
    }
  }
  return files;
}

export type TripwireResult =
  | { available: true; tripwires: TripwireFinding[] }
  | { available: false; reason: string };

/** The whole leg in one call — used by the evidence adapter and the monitor. */
export async function runTripwires(
  worktreePath: string,
  baseSha: string,
): Promise<TripwireResult> {
  try {
    const files = await collectChangedFileDiffs(worktreePath, baseSha);
    return { available: true, tripwires: detectTripwires(files) };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
