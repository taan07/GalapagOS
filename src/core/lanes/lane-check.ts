// Pure lane logic (architecture §7). A lane is allowed_globs / forbidden_globs
// (picomatch) — this module answers two questions and nothing else:
// which changed files violate a lane, and whether two lanes' allowed globs
// could claim the same file. No fs, no git — callers supply the file lists.
import picomatch from "picomatch";

export type LaneContract = {
  allowedGlobs: string[];
  forbiddenGlobs: string[];
};

export type LaneViolation = {
  path: string;
  /** not_allowed = matched by no allowed glob; forbidden = matched a forbidden glob. */
  reason: "not_allowed" | "forbidden";
  /** The forbidden glob that matched, when reason is "forbidden". */
  glob?: string;
};

// dot: true — lanes govern ALL files, dotfiles included; a worker editing
// .github/workflows outside its lane is exactly what this must catch.
const MATCH_OPTIONS = { dot: true } as const;

/** Normalize to the repo-relative posix form globs are written against. */
function normalizePath(filePath: string): string {
  let normalized = filePath.replace(/\\/g, "/").trim();
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized.replace(/^\/+/, "");
}

/**
 * Check a list of changed files against a lane contract. Forbidden globs win
 * over allowed ones; a file matched by no allowed glob is out of lane.
 */
export function checkLane(changedFiles: string[], contract: LaneContract): LaneViolation[] {
  const allowed = contract.allowedGlobs.map((glob) => picomatch(glob, MATCH_OPTIONS));
  const forbidden = contract.forbiddenGlobs.map((glob) => ({
    glob,
    matches: picomatch(glob, MATCH_OPTIONS),
  }));

  const violations: LaneViolation[] = [];
  for (const file of changedFiles) {
    const candidate = normalizePath(file);
    if (!candidate) {
      continue;
    }
    const forbiddenHit = forbidden.find((entry) => entry.matches(candidate));
    if (forbiddenHit) {
      violations.push({ path: candidate, reason: "forbidden", glob: forbiddenHit.glob });
      continue;
    }
    if (!allowed.some((matches) => matches(candidate))) {
      violations.push({ path: candidate, reason: "not_allowed" });
    }
  }
  return violations;
}

/**
 * Could two allowed globs ever claim the same file? Deliberately
 * conservative: literal-vs-glob pairs are answered exactly with picomatch;
 * glob-vs-glob pairs overlap when either static base directory contains the
 * other (exact glob intersection is not decidable cheaply, and refusing a
 * spawn is the safe error — the manager narrows the lane and retries).
 */
export function globsCouldOverlap(a: string, b: string): boolean {
  const globA = normalizePath(a);
  const globB = normalizePath(b);
  const scanA = picomatch.scan(globA);
  const scanB = picomatch.scan(globB);

  if (!scanA.isGlob && !scanB.isGlob) {
    return globA === globB;
  }
  if (!scanA.isGlob) {
    return picomatch(globB, MATCH_OPTIONS)(globA);
  }
  if (!scanB.isGlob) {
    return picomatch(globA, MATCH_OPTIONS)(globB);
  }

  const baseA = scanA.base;
  const baseB = scanB.base;
  return (
    baseA === "" ||
    baseB === "" ||
    baseA === baseB ||
    baseA.startsWith(`${baseB}/`) ||
    baseB.startsWith(`${baseA}/`)
  );
}

export type LaneOverlap = {
  /** Glob from the candidate lane. */
  candidateGlob: string;
  /** Glob from the existing lane it collides with. */
  existingGlob: string;
};

/** First overlapping allowed-glob pair between two lanes, or null. */
export function findLaneOverlap(
  candidateAllowedGlobs: string[],
  existingAllowedGlobs: string[],
): LaneOverlap | null {
  for (const candidateGlob of candidateAllowedGlobs) {
    for (const existingGlob of existingAllowedGlobs) {
      if (globsCouldOverlap(candidateGlob, existingGlob)) {
        return { candidateGlob, existingGlob };
      }
    }
  }
  return null;
}
