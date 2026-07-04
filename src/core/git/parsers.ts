import { createHash } from "node:crypto";
import type {
  GitAheadBehind,
  GitBranchObservation,
  GitDiffFileSummary,
  GitDiffSummary,
  GitFileStatus,
  GitObservation,
  GitStatusObservation,
  GitWorktreeObservation,
  GitWorktreeStatus,
  RawGitObservationOutput,
} from "./types";

function nullWhenEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function stringValue(value: string | true | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function shortBranchName(ref: string | null): string | null {
  if (ref === null) {
    return null;
  }

  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function parseWorktreeListPorcelain(output: string): GitWorktreeObservation[] {
  const records = output
    .trim()
    .split(/\n{2,}/)
    .map((record) => record.trim())
    .filter(Boolean);

  return records.map((record, index) => {
    const lines = record.split("\n");
    const values = new Map<string, string | true>();

    for (const line of lines) {
      const separatorIndex = line.indexOf(" ");
      if (separatorIndex === -1) {
        values.set(line, true);
      } else {
        values.set(line.slice(0, separatorIndex), line.slice(separatorIndex + 1));
      }
    }

    const path = values.get("worktree");
    if (typeof path !== "string" || path.length === 0) {
      throw new Error(`Invalid git worktree record: missing worktree path in ${JSON.stringify(record)}`);
    }

    const isBare = values.has("bare");
    const isDetached = values.has("detached");
    const prunable = values.get("prunable");
    const isPrunable = values.has("prunable");
    const status: GitWorktreeStatus = isPrunable
      ? "prunable"
      : isBare
        ? "bare"
        : isDetached
          ? "detached"
          : index === 0
            ? "main"
            : "linked";

    return {
      id: path,
      path,
      branch: shortBranchName(stringValue(values.get("branch"))),
      headSha: stringValue(values.get("HEAD")),
      isMainWorktree: index === 0,
      status,
      prunableReason: typeof prunable === "string" ? prunable : null,
    };
  });
}

function parseAheadBehind(text: string): GitAheadBehind | null {
  const aheadMatch = text.match(/ahead (\d+)/);
  const behindMatch = text.match(/behind (\d+)/);
  const ahead = aheadMatch ? Number.parseInt(aheadMatch[1] ?? "0", 10) : 0;
  const behind = behindMatch ? Number.parseInt(behindMatch[1] ?? "0", 10) : 0;

  return ahead > 0 || behind > 0 ? { ahead, behind } : null;
}

function parseUpstreamDetails(details: string): {
  upstream: string | null;
  aheadBehind: GitAheadBehind | null;
} {
  const [upstreamPart, ...stateParts] = details.split(":");
  const upstream = nullWhenEmpty(upstreamPart);
  const state = stateParts.join(":");

  return {
    upstream,
    aheadBehind: state.length > 0 ? parseAheadBehind(state) : null,
  };
}

export function parseBranchVerbose(output: string): GitBranchObservation[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const marker = line[0];
      const isActive = marker === "*";
      const isLinkedWorktree = marker === "+";
      const content = marker === "*" || marker === "+" ? line.slice(1).trimStart() : line.trimStart();
      const match = content.match(/^((?:\(no branch\))|\S+)\s+([0-9a-fA-F]+)(?:\s+\[([^\]]+)])?(?:\s+(.*))?$/);

      if (!match) {
        throw new Error(`Invalid git branch verbose line: ${JSON.stringify(line)}`);
      }

      const [, name = "", headSha = "", upstreamDetails = "", lastCommitSummary = ""] = match;
      const parsedUpstream = upstreamDetails.length > 0 ? parseUpstreamDetails(upstreamDetails) : null;

      return {
        name,
        headSha,
        isActive,
        isLinkedWorktree,
        upstream: parsedUpstream?.upstream ?? null,
        aheadBehind: parsedUpstream?.aheadBehind ?? null,
        lastCommitSummary: nullWhenEmpty(lastCommitSummary),
      };
    });
}

function parseStatusBranchLine(line: string): Pick<GitStatusObservation, "branch" | "upstream" | "aheadBehind"> {
  const body = line.slice(3);
  const [branchPart = "", relationPart = ""] = body.split("...");
  const branch = branchPart === "HEAD (no branch)" ? null : nullWhenEmpty(branchPart);

  if (relationPart.length === 0) {
    return { branch, upstream: null, aheadBehind: null };
  }

  const relationMatch = relationPart.match(/^([^\s]+)(?:\s+\[(.*)])?$/);
  if (!relationMatch) {
    return { branch, upstream: nullWhenEmpty(relationPart), aheadBehind: null };
  }

  const [, upstream = "", state = ""] = relationMatch;
  return {
    branch,
    upstream: nullWhenEmpty(upstream),
    aheadBehind: state.length > 0 ? parseAheadBehind(state) : null,
  };
}

function createFileStatus(record: string, originalPath: string | null): GitFileStatus {
  if (record.length < 4) {
    throw new Error(`Invalid git status record: ${JSON.stringify(record)}`);
  }

  return {
    indexStatus: record[0] ?? " ",
    worktreeStatus: record[1] ?? " ",
    path: record.slice(3),
    originalPath,
  };
}

export function parseStatusPorcelain(output: string): GitStatusObservation {
  const tokens = output.split("\0").filter((token) => token.length > 0);
  const firstFileIndex = tokens.findIndex((token) => !token.startsWith("## "));
  const branchLines = (firstFileIndex === -1 ? tokens : tokens.slice(0, firstFileIndex)).filter((token) =>
    token.startsWith("## "),
  );
  const files = firstFileIndex === -1 ? [] : tokens.slice(firstFileIndex);
  const branchInfo =
    branchLines.length > 0
      ? parseStatusBranchLine(branchLines[0] ?? "## ")
      : { branch: null, upstream: null, aheadBehind: null };

  const stagedFiles: GitFileStatus[] = [];
  const dirtyFiles: GitFileStatus[] = [];
  const untrackedFiles: GitFileStatus[] = [];
  const ignoredFiles: GitFileStatus[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const record = files[index] ?? "";
    const indexStatus = record[0] ?? " ";
    const worktreeStatus = record[1] ?? " ";
    const hasOriginalPath = indexStatus === "R" || indexStatus === "C";
    const originalPath = hasOriginalPath ? (files[index + 1] ?? null) : null;
    const fileStatus = createFileStatus(record, originalPath);

    if (hasOriginalPath) {
      index += 1;
    }

    if (indexStatus === "?" && worktreeStatus === "?") {
      untrackedFiles.push(fileStatus);
      continue;
    }

    if (indexStatus === "!" && worktreeStatus === "!") {
      ignoredFiles.push(fileStatus);
      continue;
    }

    if (indexStatus !== " " && indexStatus !== "?" && indexStatus !== "!") {
      stagedFiles.push(fileStatus);
    }

    if (worktreeStatus !== " " && worktreeStatus !== "?" && worktreeStatus !== "!") {
      dirtyFiles.push(fileStatus);
    }
  }

  return {
    ...branchInfo,
    stagedFiles,
    dirtyFiles,
    untrackedFiles,
    ignoredFiles,
  };
}

export function parseNumstat(output: string): GitDiffFileSummary[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [addedRaw = "", deletedRaw = "", ...pathParts] = line.split("\t");
      const isBinary = addedRaw === "-" || deletedRaw === "-";

      return {
        path: pathParts.join("\t"),
        added: isBinary ? null : Number.parseInt(addedRaw, 10),
        deleted: isBinary ? null : Number.parseInt(deletedRaw, 10),
        isBinary,
      };
    });
}

export function createDirtyFingerprint(input: {
  headSha: string | null;
  branch: string | null;
  status: GitStatusObservation;
  diffSummary: GitDiffSummary;
}): string {
  const fingerprintPayload = {
    headSha: input.headSha,
    branch: input.branch,
    stagedFiles: input.status.stagedFiles,
    dirtyFiles: input.status.dirtyFiles,
    untrackedFiles: input.status.untrackedFiles,
    ignoredFiles: input.status.ignoredFiles,
    diffSummary: input.diffSummary,
  };

  return createHash("sha256").update(stableStringify(fingerprintPayload)).digest("hex");
}

export function normalizeGitObservation(raw: RawGitObservationOutput, observedAt = new Date().toISOString()): GitObservation {
  const status = parseStatusPorcelain(raw.statusPorcelain);
  const diffSummary: GitDiffSummary = {
    unstaged: parseNumstat(raw.unstagedNumstat),
    staged: parseNumstat(raw.stagedNumstat),
    unstagedRaw: raw.unstagedNumstat,
    stagedRaw: raw.stagedNumstat,
  };
  const activeBranch = nullWhenEmpty(raw.activeBranch) ?? status.branch;
  const headSha = nullWhenEmpty(raw.headSha);

  return {
    repoRoot: raw.repoRoot.trim(),
    activeBranch,
    headSha,
    worktrees: parseWorktreeListPorcelain(raw.worktreeListPorcelain),
    branches: parseBranchVerbose(raw.branchVerbose),
    status,
    diffSummary,
    dirtyFingerprint: createDirtyFingerprint({
      headSha,
      branch: activeBranch,
      status,
      diffSummary,
    }),
    observedAt,
  };
}
