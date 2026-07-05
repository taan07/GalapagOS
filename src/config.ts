import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Mirrors the Agent SDK's EffortLevel — validated here so a typo in the
 * env var fails the daemon at boot, not silently mid-spawn. */
export const WORKER_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type WorkerEffort = (typeof WORKER_EFFORT_LEVELS)[number];

export type GalapagosConfig = {
  stateDir: string;
  vaultPath: string;
  managerModel: string;
  /**
   * Model for post-turn distillation forks. Distillation is extraction, not
   * judgment — it must not double the subscription cost of every chat turn.
   */
  distillModel: string;
  /** Model worker sessions run on — workers do real implementation work. */
  workerModel: string;
  /** Reasoning effort for worker sessions (user-confirmed: high). */
  workerEffort: WorkerEffort;
  /**
   * Model for event-driven triage sessions. Triage is judgment over a small
   * attention batch, not implementation — it runs cheap by default and the
   * user can raise it.
   */
  triageModel: string;
  /** Monitor loop cadence. The tick makes zero LLM calls at any interval. */
  monitorIntervalMs: number;
  /** A running worker silent beyond this raises stale_worker attention. */
  staleWorkerSeconds: number;
  /** Hard wall for one check command — a hung test run must not wedge run_checks. */
  checkTimeoutMs: number;
  daemonPort: number;
  /** Where new projects are created and where folder browsing starts. */
  devRoot: string;
  /**
   * Path to the user's logged-in Claude Code binary. The SDK's bundled
   * runtime cannot read Claude Code's keychain credentials (they are bound
   * to the binary that created them), so agent sessions must spawn the real
   * installed binary to run on the subscription.
   */
  claudeBinPath: string | undefined;
};

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${raw} — expected a positive integer.`);
  }
  return value;
}

function parseWorkerEffort(value: string | undefined): WorkerEffort {
  if (value === undefined) {
    return "high";
  }
  if ((WORKER_EFFORT_LEVELS as readonly string[]).includes(value)) {
    return value as WorkerEffort;
  }
  throw new Error(
    `Invalid GALAPAGOS_WORKER_EFFORT: ${value} — expected one of ${WORKER_EFFORT_LEVELS.join(", ")}.`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GalapagosConfig {
  const stateDir = path.resolve(expandHome(env.GALAPAGOS_STATE_DIR ?? "~/.galapagos"));
  const vaultPath = path.resolve(
    expandHome(env.GALAPAGOS_VAULT_PATH ?? "/Users/taan/Documents/Obsidian Vault"),
  );
  const daemonPort = Number.parseInt(env.GALAPAGOS_DAEMON_PORT ?? "4517", 10);
  if (!Number.isInteger(daemonPort) || daemonPort <= 0 || daemonPort > 65535) {
    throw new Error(`Invalid GALAPAGOS_DAEMON_PORT: ${env.GALAPAGOS_DAEMON_PORT}`);
  }

  const defaultClaudeBin = path.join(os.homedir(), ".claude", "local", "claude");
  const claudeBinPath = env.GALAPAGOS_CLAUDE_BIN
    ? path.resolve(expandHome(env.GALAPAGOS_CLAUDE_BIN))
    : existsSync(defaultClaudeBin)
      ? defaultClaudeBin
      : undefined;

  return {
    stateDir,
    vaultPath,
    managerModel: env.GALAPAGOS_MANAGER_MODEL ?? "claude-fable-5",
    distillModel: env.GALAPAGOS_DISTILL_MODEL ?? "claude-haiku-4-5",
    // Workers: Opus 4.8 at high effort (user-confirmed 2026-07-05).
    workerModel: env.GALAPAGOS_WORKER_MODEL ?? "claude-opus-4-8",
    workerEffort: parseWorkerEffort(env.GALAPAGOS_WORKER_EFFORT),
    triageModel: env.GALAPAGOS_TRIAGE_MODEL ?? "claude-haiku-4-5",
    monitorIntervalMs: parsePositiveInt(
      "GALAPAGOS_MONITOR_INTERVAL_MS",
      env.GALAPAGOS_MONITOR_INTERVAL_MS,
      30_000,
    ),
    staleWorkerSeconds: parsePositiveInt(
      "GALAPAGOS_STALE_WORKER_SECONDS",
      env.GALAPAGOS_STALE_WORKER_SECONDS,
      300,
    ),
    checkTimeoutMs: parsePositiveInt(
      "GALAPAGOS_CHECK_TIMEOUT_MS",
      env.GALAPAGOS_CHECK_TIMEOUT_MS,
      600_000,
    ),
    daemonPort,
    devRoot: path.resolve(expandHome(env.GALAPAGOS_DEV_ROOT ?? "~/Dev")),
    claudeBinPath,
  };
}

export const config = loadConfig();
