// Bounded workspace evidence. Checks and reviewers may only rely on a key
// when every relevant byte was observed within these deliberately conservative
// limits.  We never turn a truncated observation into a green key.
import { createHash } from "node:crypto";
import { lstat, open, readlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { parseStatusPorcelain } from "../../core/git/parsers";

/** Exported so deployments can choose stricter bounds and the UI can report them. */
export type WorkspaceEvidenceLimits = {
  maxUntrackedEntries: number;
  maxUntrackedFileBytes: number;
  maxAggregateUntrackedBytes: number;
  /** Per git stdout stream and total across all streams (which run serially). */
  maxGitOutputBytes: number;
  maxAggregateGitOutputBytes: number;
  maxGitStderrBytes: number;
  maxConcurrentReads: number;
};

/** Defaults: 512 entries, 1 MiB/entry, 8 MiB files, 4 MiB/git stream, 8 MiB aggregate git, 64 KiB stderr, four readers. */
export const DEFAULT_WORKSPACE_EVIDENCE_LIMITS: WorkspaceEvidenceLimits = {
  maxUntrackedEntries: 512,
  maxUntrackedFileBytes: 1 * 1024 * 1024,
  maxAggregateUntrackedBytes: 8 * 1024 * 1024,
  maxGitOutputBytes: 4 * 1024 * 1024,
  maxAggregateGitOutputBytes: 8 * 1024 * 1024,
  maxGitStderrBytes: 64 * 1024,
  maxConcurrentReads: 4,
};

export type WorkspaceEvidenceUsage = {
  untrackedEntries: number;
  untrackedBytes: number;
  unstagedDiffBytes: number;
  stagedDiffBytes: number;
  statusBytes: number;
  gitOutputBytes: number;
  gitStderrBytes: number;
};

export type WorkspaceEvidence = {
  /** Present for compatibility; consumers MUST gate it on available. */
  key: string;
  headSha: string;
  dirty: boolean | null;
  available: boolean;
  reason: string | null;
  usage: WorkspaceEvidenceUsage;
  limits: WorkspaceEvidenceLimits;
};

type BoundedGitOutput = { ok: true; output: Buffer; bytes: number; stderrBytes: number } | { ok: false; reason: string; bytes: number; stderrBytes: number };

function emptyUsage(): WorkspaceEvidenceUsage {
  return { untrackedEntries: 0, untrackedBytes: 0, unstagedDiffBytes: 0, stagedDiffBytes: 0, statusBytes: 0, gitOutputBytes: 0, gitStderrBytes: 0 };
}

function unavailable(
  reason: string,
  limits: WorkspaceEvidenceLimits,
  usage: WorkspaceEvidenceUsage,
  headSha: string | null = null,
  dirty: boolean | null = null,
): WorkspaceEvidence {
  return { key: "indeterminate", headSha: headSha ?? "indeterminate", dirty, available: false, reason, usage, limits };
}

/** Read git stdout incrementally; killing at the cap avoids unbounded patch buffers. */
type GitBudget = { outputBytes: number; stderrBytes: number };

function boundedGit(cwd: string, args: string[], limits: WorkspaceEvidenceLimits, budget: GitBudget): Promise<BoundedGitOutput> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let over: "stream" | "aggregate" | "stderr" | null = null;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      budget.outputBytes += chunk.length;
      if (bytes > limits.maxGitOutputBytes) {
        over = "stream";
        child.kill("SIGTERM");
      } else if (budget.outputBytes > limits.maxAggregateGitOutputBytes) {
        over = "aggregate";
        child.kill("SIGTERM");
      } else {
        chunks.push(chunk);
      }
    });
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      budget.stderrBytes += chunk.length;
      if (stderrBytes > limits.maxGitStderrBytes) { over = "stderr"; child.kill("SIGTERM"); return; }
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => resolve({ ok: false, reason: error.message, bytes, stderrBytes }));
    child.on("close", (code) => {
      if (over) {
        const reason = over === "stream"
          ? `git ${args[0]} stdout exceeded per-stream limit ${limits.maxGitOutputBytes} bytes`
          : over === "aggregate"
            ? `git ${args[0]} stdout exceeded aggregate git limit ${limits.maxAggregateGitOutputBytes} bytes`
            : `git ${args[0]} stderr exceeded limit ${limits.maxGitStderrBytes} bytes`;
        resolve({ ok: false, reason, bytes, stderrBytes });
      } else if (code !== 0) {
        resolve({ ok: false, reason: `git ${args.join(" ")} failed: ${stderr.trim() || `exit ${code}`}`, bytes, stderrBytes });
      } else {
        resolve({ ok: true, output: Buffer.concat(chunks), bytes, stderrBytes });
      }
    });
  });
}

function inside(root: string, relative: string): string | null {
  const candidate = path.resolve(root, relative);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`) ? candidate : null;
}

function sameIdentity(a: import("node:fs").Stats, b: import("node:fs").Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

type EntryHash = { relative: string; kind: "file" | "symlink"; bytes: number; digest: Buffer };

async function readRegularEntry(target: string, relative: string, expected: import("node:fs").Stats, hooks?: WorkspaceEvidenceTestHooks): Promise<EntryHash | string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(target, "r");
    const before = await handle.stat();
    if (!before.isFile() || !sameIdentity(expected, before)) return `untracked file changed before observation: ${relative}`;
    await hooks?.afterOpen?.(relative, target);
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
    let bytesRead = 0;
    let exceeded = false;
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => {
        bytesRead += chunk.length;
        if (bytesRead > expected.size) { exceeded = true; stream.destroy(); return; }
        hash.update(chunk);
      });
      stream.on("end", resolve); stream.on("close", resolve); stream.on("error", reject);
    });
    if (exceeded) return `untracked file grew while observed: ${relative}`;
    const after = await handle.stat();
    const pathAfter = await lstat(target);
    if (!sameIdentity(before, after) || !pathAfter.isFile() || !sameIdentity(before, pathAfter)) return `untracked file changed or was replaced while observed: ${relative}`;
    return { relative, kind: "file", bytes: before.size, digest: hash.digest() };
  } catch {
    return `untracked file disappeared or is unreadable: ${relative}`;
  } finally { await handle?.close().catch(() => {}); }
}

export type WorkspaceEvidenceTestHooks = {
  /** Test-only seam invoked after an FD identity check and before streaming. */
  afterOpen?: (relative: string, target: string) => void | Promise<void>;
};

async function hashUntracked(
  cwd: string,
  paths: string[],
  hash: ReturnType<typeof createHash>,
  limits: WorkspaceEvidenceLimits,
  usage: WorkspaceEvidenceUsage,
  hooks?: WorkspaceEvidenceTestHooks,
): Promise<string | null> {
  if (paths.length > limits.maxUntrackedEntries) {
    return `untracked entry count ${paths.length} exceeds limit ${limits.maxUntrackedEntries}`;
  }
  const regular: { relative: string; target: string; stat: import("node:fs").Stats }[] = [];
  const entries: EntryHash[] = [];
  for (const relative of [...paths].sort((a, b) => a.localeCompare(b))) {
    usage.untrackedEntries += 1;
    const target = inside(cwd, relative);
    if (!target) return `untracked path escapes workspace: ${relative}`;
    let stat;
    try { stat = await lstat(target); } catch { return `untracked path disappeared or is unreadable: ${relative}`; }
    if (stat.isSymbolicLink()) {
      // Do not follow untracked links: link text, not target bytes, is evidence.
      try {
        const link = await readlink(target);
        const bytes = Buffer.byteLength(link);
        if (bytes > limits.maxUntrackedFileBytes) return `untracked symlink ${relative} target exceeds per-entry limit ${limits.maxUntrackedFileBytes}`;
        if (usage.untrackedBytes + bytes > limits.maxAggregateUntrackedBytes) return `untracked evidence aggregate would exceed ${limits.maxAggregateUntrackedBytes} bytes at ${relative}`;
        usage.untrackedBytes += bytes;
        const after = await lstat(target);
        if (!after.isSymbolicLink() || !sameIdentity(stat, after)) return `untracked symlink changed or was replaced while observed: ${relative}`;
        entries.push({ relative, kind: "symlink", bytes, digest: createHash("sha256").update(link).digest() });
      } catch { return `untracked symlink disappeared or is unreadable: ${relative}`; }
      continue;
    }
    if (!stat.isFile()) return `untracked entry is not a regular file: ${relative}`;
    if (stat.size > limits.maxUntrackedFileBytes) return `untracked file ${relative} is ${stat.size} bytes; per-file limit is ${limits.maxUntrackedFileBytes}`;
    if (usage.untrackedBytes + stat.size > limits.maxAggregateUntrackedBytes) return `untracked evidence aggregate would exceed ${limits.maxAggregateUntrackedBytes} bytes at ${relative}`;
    usage.untrackedBytes += stat.size;
    regular.push({ relative, target, stat });
  }
  // A bounded worker pool reduces latency without loosening the aggregate cap.
  // Entries are applied to the parent hash only after all complete, sorted by path.
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limits.maxConcurrentReads), regular.length) }, async () => {
    while (next < regular.length) {
      const entry = regular[next++];
      if (!entry) continue;
      const result = await readRegularEntry(entry.target, entry.relative, entry.stat, hooks);
      if (typeof result === "string") throw new Error(result);
      entries.push(result);
    }
  });
  try { await Promise.all(workers); } catch (error) { return error instanceof Error ? error.message : String(error); }
  for (const entry of entries.sort((a, b) => a.relative.localeCompare(b.relative))) {
    hash.update(entry.relative); hash.update("\0"); hash.update(entry.kind); hash.update("\0"); hash.update(entry.digest); hash.update("\0");
  }
  return null;
}

/**
 * Validate paths already discovered by a workspace inventory. Kept exported
 * for callers that use a richer inventory than porcelain (and for adversarial
 * tests); it shares exactly the observer's no-follow, identity, and limits.
 */
export async function inspectUntrackedEntries(
  cwd: string,
  paths: string[],
  limits: WorkspaceEvidenceLimits = DEFAULT_WORKSPACE_EVIDENCE_LIMITS,
  hooks?: WorkspaceEvidenceTestHooks,
): Promise<{ available: boolean; reason: string | null; usage: WorkspaceEvidenceUsage }> {
  const usage = emptyUsage();
  const invalid = Object.entries(limits).find(([, value]) => !Number.isSafeInteger(value) || value <= 0);
  if (invalid) return { available: false, reason: `invalid workspace evidence limit ${invalid[0]}=${String(invalid[1])}`, usage };
  const issue = await hashUntracked(cwd, paths, createHash("sha256"), limits, usage, hooks);
  return { available: issue === null, reason: issue, usage };
}

export async function observeWorkspaceEvidence(
  cwd: string,
  limits: WorkspaceEvidenceLimits = DEFAULT_WORKSPACE_EVIDENCE_LIMITS,
  hooks?: WorkspaceEvidenceTestHooks,
): Promise<WorkspaceEvidence> {
  const usage = emptyUsage();
  const invalid = Object.entries(limits).find(([, value]) => !Number.isSafeInteger(value) || value <= 0);
  if (invalid) return unavailable(`invalid workspace evidence limit ${invalid[0]}=${String(invalid[1])}`, limits, usage);
  const budget: GitBudget = { outputBytes: 0, stderrBytes: 0 };
  const head = await boundedGit(cwd, ["rev-parse", "--verify", "HEAD"], limits, budget);
  if (!head.ok) return unavailable(head.reason, limits, usage);
  const headSha = head.output.toString("utf8").trim() || "no-head";
  // Serial git streams mean at most one capped output buffer exists at once.
  const unstaged = await boundedGit(cwd, ["diff", "--no-ext-diff", "--binary"], limits, budget);
  const staged = await boundedGit(cwd, ["diff", "--cached", "--no-ext-diff", "--binary"], limits, budget);
  const statusResult = await boundedGit(cwd, ["status", "--porcelain=v1", "-z", "-uall"], limits, budget);
  usage.unstagedDiffBytes = unstaged.bytes; usage.stagedDiffBytes = staged.bytes; usage.statusBytes = statusResult.bytes;
  usage.gitStderrBytes = head.stderrBytes + unstaged.stderrBytes + staged.stderrBytes + statusResult.stderrBytes;
  usage.gitOutputBytes = budget.outputBytes;
  if (!unstaged.ok) return unavailable(unstaged.reason, limits, usage, headSha);
  if (!staged.ok) return unavailable(staged.reason, limits, usage, headSha);
  if (!statusResult.ok) return unavailable(statusResult.reason, limits, usage, headSha);
  const status = parseStatusPorcelain(statusResult.output.toString("utf8"));
  const dirty = status.stagedFiles.length > 0 || status.dirtyFiles.length > 0 || status.untrackedFiles.length > 0;
  if (!dirty) return { key: headSha, headSha, dirty, available: true, reason: null, usage, limits };
  const hash = createHash("sha256");
  hash.update(unstaged.output); hash.update("\0"); hash.update(staged.output); hash.update("\0");
  const issue = await hashUntracked(cwd, status.untrackedFiles.map((entry) => entry.path), hash, limits, usage, hooks);
  if (issue) return unavailable(issue, limits, usage, headSha, dirty);
  return { key: `${headSha}+dirty.${hash.digest("hex").slice(0, 16)}`, headSha, dirty, available: true, reason: null, usage, limits };
}
