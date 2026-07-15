// The check runner (chunk 4): run a project's configured check commands in
// the RIGHT directory — a worker's checks run in its worktree, never the
// main checkout — and write evidence_runs rows keyed to the workspace state
// at run time. Check commands are auto-detected from the target repo's
// package.json scripts (user-confirmed 2026-07-05). The selected package
// manager runs the known key; a key with no script is honestly reported "not
// configured" and writes no row.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GalapagosConfig } from "../../config";
import { oneLine } from "../../core/text";
import type { GalapagosDb } from "../db/db";
import { CHECK_KEYS, createEvidenceRun, type CheckKey, type EvidenceRunRow } from "../db/repos/evidence";
import { observeWorkspaceEvidence } from "../evidence/workspace";

export type CheckOutcome =
  | { key: CheckKey; status: "passed" | "failed"; summary: string; run: EvidenceRunRow }
  | { key: CheckKey; status: "not_configured"; summary: string }
  | { key: CheckKey; status: "error"; summary: string };

export type RunChecksResult = {
  cwd: string;
  /** The workspace evidence key the runs are stored under. */
  evidenceKey: string | null;
  outcomes: CheckOutcome[];
};

export type CheckPackageManager = "bun" | "pnpm" | "yarn" | "npm";

export type CheckRunner = {
  manager: CheckPackageManager;
  command: string;
  argsBeforeKey: string[];
};

export type CheckRunnerDetection =
  | { status: "resolved"; runner: CheckRunner }
  | { status: "indeterminate"; reason: string };

type PackageManifest = {
  scripts?: Record<string, unknown>;
  packageManager?: unknown;
};

const CHECK_RUNNERS: Record<CheckPackageManager, CheckRunner> = {
  bun: { manager: "bun", command: "bun", argsBeforeKey: ["run"] },
  pnpm: { manager: "pnpm", command: "pnpm", argsBeforeKey: ["run"] },
  yarn: { manager: "yarn", command: "yarn", argsBeforeKey: ["run"] },
  npm: { manager: "npm", command: "npm", argsBeforeKey: ["run"] },
};

function readPackageManifest(cwd: string): PackageManifest | null {
  try {
    return JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")) as PackageManifest;
  } catch {
    return null;
  }
}

function managerFromPackageManagerField(value: unknown): CheckPackageManager | null {
  if (typeof value !== "string") {
    return null;
  }
  const manager = /^(bun|pnpm|yarn|npm)(?:@|$)/.exec(value.trim())?.[1];
  return manager === "bun" || manager === "pnpm" || manager === "yarn" || manager === "npm"
    ? manager
    : null;
}

/**
 * Select the target project's package manager without guessing between
 * conflicting lockfiles. A valid root packageManager declaration is explicit
 * intent and wins; otherwise exactly one lockfile family is required. A bare
 * package.json retains npm as the backwards-compatible final fallback.
 */
export function detectCheckRunner(cwd: string): CheckRunnerDetection {
  const manifest = readPackageManifest(cwd);
  if (!manifest) {
    return { status: "indeterminate", reason: `No readable ${path.join(cwd, "package.json")}.` };
  }

  const declared = managerFromPackageManagerField(manifest.packageManager);
  if (declared) {
    return { status: "resolved", runner: CHECK_RUNNERS[declared] };
  }
  if (Object.prototype.hasOwnProperty.call(manifest, "packageManager")) {
    return {
      status: "indeterminate",
      reason: `package.json declares an unsupported or malformed packageManager (${JSON.stringify(manifest.packageManager)}); expected bun, pnpm, yarn, or npm with an optional version.`,
    };
  }

  const lockfileManagers = new Set<CheckPackageManager>();
  if (existsSync(path.join(cwd, "bun.lock")) || existsSync(path.join(cwd, "bun.lockb"))) {
    lockfileManagers.add("bun");
  }
  if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
    lockfileManagers.add("pnpm");
  }
  if (existsSync(path.join(cwd, "yarn.lock"))) {
    lockfileManagers.add("yarn");
  }
  if (existsSync(path.join(cwd, "package-lock.json"))) {
    lockfileManagers.add("npm");
  }

  if (lockfileManagers.size === 1) {
    const manager = Array.from(lockfileManagers)[0];
    if (!manager) {
      return { status: "indeterminate", reason: "Could not read the selected package-manager lockfile." };
    }
    return { status: "resolved", runner: CHECK_RUNNERS[manager] };
  }
  if (lockfileManagers.size > 1) {
    return {
      status: "indeterminate",
      reason: `Conflicting package-manager lockfiles (${Array.from(lockfileManagers).join(", ")}) with no valid packageManager declaration.`,
    };
  }
  return { status: "resolved", runner: CHECK_RUNNERS.npm };
}

/** Which of the four check keys the repo's package.json actually offers. */
export function configuredCheckKeys(cwd: string): CheckKey[] {
  const scripts = readPackageManifest(cwd)?.scripts ?? {};
  return CHECK_KEYS.filter((key) => typeof scripts[key] === "string");
}

function execCheck(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string; timedOut: boolean; spawnError: string | null }> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`;
        if (!error) {
          resolve({ code: 0, output, timedOut: false, spawnError: null });
          return;
        }
        const errno = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
        if (errno.code === "ENOENT") {
          resolve({ code: null, output, timedOut: false, spawnError: `${command} not found` });
          return;
        }
        resolve({
          code: typeof errno.code === "number" ? errno.code : child.exitCode,
          output,
          timedOut: errno.killed === true && child.exitCode === null,
          spawnError: null,
        });
      },
    );
  });
}

function lastMeaningfulLine(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "(no output)";
}

/**
 * Run the requested checks sequentially (parallel checks fight over ports,
 * caches, and build dirs) and persist one evidence row per executed check.
 * The evidence key is observed before EACH run — a build step that dirties
 * the tree must not stamp later runs with a state that no longer exists.
 */
export async function runChecks(input: {
  db: GalapagosDb;
  config: GalapagosConfig;
  projectId: string;
  projectSlug: string;
  /** Where the checks execute: the worker's worktree or the project root. */
  cwd: string;
  workerId?: string | null;
  /** Which checks to run; omitted = every configured one. */
  keys?: string[];
}): Promise<RunChecksResult> {
  const configured = configuredCheckKeys(input.cwd);
  const requested: CheckKey[] =
    input.keys && input.keys.length > 0
      ? (input.keys.filter((key): key is CheckKey =>
          (CHECK_KEYS as readonly string[]).includes(key),
        ) as CheckKey[])
      : configured;

  const outcomes: CheckOutcome[] = [];
  let lastEvidenceKey: string | null = null;
  const runner = detectCheckRunner(input.cwd);

  if (runner.status === "indeterminate") {
    return {
      cwd: input.cwd,
      evidenceKey: null,
      outcomes: requested.map((key) => ({
        key,
        status: "error" as const,
        summary: `Could not select a package manager for "${key}": ${runner.reason}`,
      })),
    };
  }

  const logDir = path.join(input.config.stateDir, "check-logs", input.projectSlug);

  for (const key of requested) {
    if (!configured.includes(key)) {
      outcomes.push({
        key,
        status: "not_configured",
        summary: `No "${key}" script in ${path.join(input.cwd, "package.json")} — not run, no evidence written.`,
      });
      continue;
    }

    let evidenceKey: string;
    try {
      const workspace = await observeWorkspaceEvidence(input.cwd);
      evidenceKey = workspace.key;
      lastEvidenceKey = workspace.key;
    } catch (error) {
      outcomes.push({
        key,
        status: "error",
        summary: `Could not observe the workspace state before "${key}": ${error instanceof Error ? error.message : String(error)} — check skipped, evidence without a key is not evidence.`,
      });
      continue;
    }

    const startedAt = Date.now();
    const args = [...runner.runner.argsBeforeKey, key];
    const commandDisplay = [runner.runner.command, ...args].join(" ");
    const result = await execCheck(runner.runner.command, args, input.cwd, input.config.checkTimeoutMs);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (result.spawnError) {
      outcomes.push({
        key,
        status: "error",
        summary: `Could not run "${key}": ${result.spawnError}.`,
      });
      continue;
    }

    const passed = result.code === 0 && !result.timedOut;
    const summary = passed
      ? `passed in ${seconds}s`
      : result.timedOut
        ? `timed out after ${seconds}s (limit ${Math.round(input.config.checkTimeoutMs / 1000)}s)`
        : `exit ${result.code ?? "?"} in ${seconds}s — ${oneLine(lastMeaningfulLine(result.output), 160)}`;

    let logPath: string | null = null;
    try {
      mkdirSync(logDir, { recursive: true });
      logPath = path.join(
        logDir,
        `${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}-${key}-${randomUUID().slice(0, 8)}.log`,
      );
      writeFileSync(
        logPath,
        [
          `command: ${commandDisplay}`,
          `cwd: ${input.cwd}`,
          `evidence key: ${evidenceKey}`,
          `exit: ${result.timedOut ? "timeout" : (result.code ?? "?")}`,
          "",
          result.output,
        ].join("\n"),
        { flag: "wx" },
      );
    } catch {
      logPath = null; // The row still lands — a lost log never loses the evidence.
    }

    const run = createEvidenceRun(input.db, {
      projectId: input.projectId,
      workerId: input.workerId ?? null,
      checkKey: key,
      status: passed ? "passed" : "failed",
      summary,
      logPath,
      headSha: evidenceKey,
    });
    outcomes.push({ key, status: passed ? "passed" : "failed", summary, run });
  }

  return { cwd: input.cwd, evidenceKey: lastEvidenceKey, outcomes };
}

export function renderRunChecksResult(result: RunChecksResult): string {
  const lines = [
    `Checks ran in ${result.cwd}${result.evidenceKey ? ` (evidence key ${result.evidenceKey.slice(0, 20)})` : ""}:`,
  ];
  if (result.outcomes.length === 0) {
    lines.push(
      "No checks to run — the repo's package.json declares none of: typecheck, lint, test, build.",
    );
  }
  for (const outcome of result.outcomes) {
    lines.push(`- ${outcome.key}: ${outcome.status} — ${outcome.summary}`);
  }
  return lines.join("\n");
}
