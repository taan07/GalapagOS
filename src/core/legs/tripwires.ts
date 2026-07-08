// The tripwires leg (user-confirmed 2026-07-05): deterministic
// test-integrity patterns over what the worker actually changed. The threat
// model comes from documented production reward hacks (see
// docs/research/confidence-engine-evidence.md): patching the test machinery
// (conftest.py, jest configs, the package.json test script), faking passes
// (sys.exit(0), always-true equality), neutering suites (mass skips,
// assertion deletion), and the softer case of a worker editing the very
// tests that judge its own code. PURE: callers supply parsed diffs; no fs,
// no git, no model calls — this brain never guesses, it pattern-matches.
import type { TripwireFinding } from "../confidence/types";

export type ChangedFileDiff = {
  /** Repo-relative posix path. */
  path: string;
  /** Content of added lines (no leading '+'); untracked files are all-added. */
  addedLines: string[];
  /** Content of removed lines (no leading '-'). */
  removedLines: string[];
};

/** Files that ARE the judging machinery — editing them can fake a pass. */
const CHECK_MACHINERY_PATTERNS: RegExp[] = [
  /(^|\/)conftest\.py$/,
  /(^|\/)pytest\.ini$/,
  /(^|\/)tox\.ini$/,
  /(^|\/)jest\.config\.[cm]?[jt]s$/,
  /(^|\/)jest\.config\.json$/,
  /(^|\/)vitest\.config\.[cm]?[jt]s$/,
  /(^|\/)\.mocharc(\.[a-z]+)?$/,
  /(^|\/)ava\.config\.[cm]?js$/,
  /(^|\/)karma\.conf(ig)?\.[cm]?js$/,
  // Command indirection (adversarial review 2026-07-05, C2): checks often
  // run through build tools whose edit can fake any pass.
  /(^|\/)Makefile$/,
  /(^|\/)justfile$/i,
  /(^|\/)Taskfile\.ya?ml$/,
];

const TEST_FILE_PATTERNS: RegExp[] = [
  /(^|\/)(tests?|__tests__|spec)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.(py|go|rb|ts|js)$/,
  /(^|\/)test_[^/]*\.py$/,
  /Tests?\.(java|kt|swift|cs)$/,
];

const SKIP_MARKER = /\b(it|test|describe|xit|xdescribe)\.skip\s*\(|\bx(it|describe|test)\s*\(|@unittest\.skip|pytest\.mark\.skip|@pytest\.mark\.skip|\bt\.Skip\s*\(|raise\s+(unittest\.)?SkipTest/;

// Focus markers make the runner execute ONLY the focused test and silently
// skip the rest of the suite — a pass that asserts almost nothing
// (adversarial review 2026-07-05, C3).
const FOCUS_MARKER = /\b(it|test|describe)\s*\.\s*only\s*\(|\bf(it|describe)\s*\(/;

const HARD_EXIT = /\b(process\.exit|sys\.exit|os\._exit)\s*\(\s*0?\s*\)/;

const ASSERTION = /\bassert\b|\bexpect\s*\(|\.should\b|assert(Equal|True|False|In|Raises)/;

// Assertions that assert nothing: literal-equals-itself, assert(true), and
// friends. Used to spot deleted-real/added-junk masking (adversarial review
// 2026-07-05, H4) — semantic gutting beyond these patterns is the critic's
// and watchdog's job, stated in the leg doc.
const TRIVIAL_ASSERTION =
  /expect\s*\(\s*(true|false|\d+|'[^']*'|"[^"]*")\s*\)\s*\.\s*(?:to(?:Be|Equal|StrictEqual)|toBe)\s*\(\s*\1\s*\)|\bassert\s*\(\s*(?:true|1)\s*\)|\bassert\s+True\b|\bassertTrue\s*\(\s*(?:true|True)\s*\)/;

export function isTestPath(path: string): boolean {
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(path));
}

export function isCheckMachineryPath(path: string): boolean {
  return CHECK_MACHINERY_PATTERNS.some((pattern) => pattern.test(path));
}

/** Did a package.json change touch the scripts that run the checks? */
function touchesCheckScripts(file: ChangedFileDiff): boolean {
  if (!/(^|\/)package\.json$/.test(file.path)) {
    return false;
  }
  const scriptKey = /"(test|typecheck|lint|build)"\s*:/;
  return [...file.addedLines, ...file.removedLines].some((line) => scriptKey.test(line));
}

export type TripwireContext = {
  /**
   * Files the check scripts execute through (extracted from the worktree's
   * package.json script values by the adapter) — editing an indirection
   * target can fake any pass without touching package.json itself
   * (adversarial review 2026-07-05, C2).
   */
  checkScriptTargets?: string[];
};

/**
 * Run every tripwire over the changed-file diffs. Findings are facts about
 * the change set, not accusations — an "alert" blocks until a human or the
 * critic clears it; a "warn" lowers and points the critic's attention.
 */
export function detectTripwires(
  files: ChangedFileDiff[],
  context: TripwireContext = {},
): TripwireFinding[] {
  const findings: TripwireFinding[] = [];

  const scriptTampered = files.filter(touchesCheckScripts);
  if (scriptTampered.length > 0) {
    findings.push({
      id: "check-script-modified",
      severity: "alert",
      label:
        "The package.json scripts that RUN the checks were modified — a rewritten test script can fake any pass",
      paths: scriptTampered.map((file) => file.path),
    });
  }

  const targets = new Set(
    (context.checkScriptTargets ?? []).map((target) => target.replace(/^\.\//, "")),
  );
  const targetTampered = files.filter((file) => targets.has(file.path));
  if (targetTampered.length > 0) {
    findings.push({
      id: "check-script-target-modified",
      severity: "alert",
      label:
        "A file the check scripts execute through was modified — an early exit in the runner script can fake any pass",
      paths: targetTampered.map((file) => file.path),
    });
  }

  const machinery = files.filter((file) => isCheckMachineryPath(file.path));
  if (machinery.length > 0) {
    findings.push({
      id: "check-machinery-modified",
      severity: "alert",
      label:
        "Test-runner configuration was modified — patched machinery (conftest.py, jest/vitest config) can fake passes",
      paths: machinery.map((file) => file.path),
    });
  }

  const hardExits = files.filter(
    (file) => isTestPath(file.path) && file.addedLines.some((line) => HARD_EXIT.test(line)),
  );
  if (hardExits.length > 0) {
    findings.push({
      id: "exit-in-tests",
      severity: "alert",
      label:
        "A hard process exit was added inside test files — exiting 0 before assertions run is a documented pass-faking exploit",
      paths: hardExits.map((file) => file.path),
    });
  }

  const alwaysEqual = files.filter(
    (file) =>
      file.addedLines.some((line) => /__eq__/.test(line)) &&
      file.addedLines.some((line) => /return\s+True/.test(line)),
  );
  if (alwaysEqual.length > 0) {
    findings.push({
      id: "always-equal",
      severity: "alert",
      label:
        "A custom __eq__ returning True was added — always-equal objects are a documented exploit against equality assertions",
      paths: alwaysEqual.map((file) => file.path),
    });
  }

  const skipsByFile = files
    .map((file) => ({
      file,
      skips: isTestPath(file.path)
        ? file.addedLines.filter((line) => SKIP_MARKER.test(line)).length
        : 0,
    }))
    .filter((entry) => entry.skips > 0);
  const totalSkips = skipsByFile.reduce((sum, entry) => sum + entry.skips, 0);
  if (totalSkips > 0) {
    findings.push({
      id: "tests-skipped",
      severity: totalSkips >= 3 ? "alert" : "warn",
      label: `${totalSkips} skip marker${totalSkips === 1 ? "" : "s"} added to tests — skipped tests pass by not running`,
      paths: skipsByFile.map((entry) => entry.file.path),
    });
  }

  // One focus marker silences the whole rest of the suite — always an alert.
  const focused = files.filter(
    (file) => isTestPath(file.path) && file.addedLines.some((line) => FOCUS_MARKER.test(line)),
  );
  if (focused.length > 0) {
    findings.push({
      id: "tests-focused",
      severity: "alert",
      label:
        "A .only/f-focus marker was added to tests — the runner executes only the focused test and silently skips the entire rest of the suite",
      paths: focused.map((file) => file.path),
    });
  }

  const trivialAdds = files.filter(
    (file) =>
      isTestPath(file.path) &&
      file.addedLines.some((line) => TRIVIAL_ASSERTION.test(line)),
  );
  if (trivialAdds.length > 0) {
    findings.push({
      id: "trivial-assertions",
      severity: "warn",
      label:
        "Assertions that assert nothing (literal-equals-itself, assert(true)) were added to tests — junk assertions can mask deleted real ones",
      paths: trivialAdds.map((file) => file.path),
    });
  }

  const assertionLoss = files
    .map((file) => {
      if (!isTestPath(file.path)) {
        return { file, lost: 0 };
      }
      const removed = file.removedLines.filter((line) => ASSERTION.test(line)).length;
      const added = file.addedLines.filter((line) => ASSERTION.test(line)).length;
      return { file, lost: removed - added };
    })
    .filter((entry) => entry.lost > 0);
  const totalLost = assertionLoss.reduce((sum, entry) => sum + entry.lost, 0);
  if (totalLost > 0) {
    findings.push({
      id: "assertions-deleted",
      severity: totalLost >= 3 ? "alert" : "warn",
      label: `${totalLost} assertion${totalLost === 1 ? "" : "s"} net-deleted from tests — a suite can be passed by weakening it`,
      paths: assertionLoss.map((entry) => entry.file.path),
    });
  }

  const testFiles = files.filter((file) => isTestPath(file.path));
  const codeFiles = files.filter(
    (file) => !isTestPath(file.path) && !isCheckMachineryPath(file.path),
  );
  if (testFiles.length > 0 && codeFiles.length > 0) {
    findings.push({
      id: "judge-tests-edited",
      severity: "warn",
      label:
        "The worker edited both code and the tests that judge it — legitimate for TDD, but the passing evidence is partly self-authored",
      paths: testFiles.map((file) => file.path),
    });
  }

  return findings;
}

/**
 * Parse `git diff -U0` output into per-file added/removed lines. Pure string
 * processing, exported for direct testing. Handles renames and deletions by
 * preferring the b/ path and falling back to a/; strips git's C-style quotes
 * around non-ASCII paths (the pattern set is ASCII, so matching survives).
 *
 * Header lines (`--- `/`+++ `) are honored only OUTSIDE hunks (adversarial
 * review 2026-07-05, M9): inside a hunk, an added content line beginning
 * "++ " renders as "+++ …" and previously hijacked the current file path,
 * detaching a malicious hunk from its real file. `@@` opens a hunk;
 * `diff --git` closes it.
 */
export function parseUnifiedDiff(diffText: string): ChangedFileDiff[] {
  const files: ChangedFileDiff[] = [];
  let current: ChangedFileDiff | null = null;
  let inHunk = false;

  const cleanPath = (raw: string): string => {
    let path = raw.trim();
    if (path.startsWith('"') && path.endsWith('"')) {
      path = path.slice(1, -1);
    }
    return path.replace(/^[ab]\//, "");
  };

  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      const source = line.slice(4);
      if (!current && source !== "/dev/null") {
        current = { path: cleanPath(source), addedLines: [], removedLines: [] };
        files.push(current);
      }
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const target = line.slice(4);
      if (target !== "/dev/null") {
        const path = cleanPath(target);
        if (!current) {
          current = { path, addedLines: [], removedLines: [] };
          files.push(current);
        } else {
          current.path = path; // renames: the b/ side is where content lives now
        }
      }
      continue;
    }
    if (!current || !inHunk) {
      continue;
    }
    if (line.startsWith("+")) {
      current.addedLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      current.removedLines.push(line.slice(1));
    }
  }
  return files;
}
