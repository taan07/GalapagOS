import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type GalapagosConfig = {
  stateDir: string;
  vaultPath: string;
  managerModel: string;
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
    daemonPort,
    devRoot: path.resolve(expandHome(env.GALAPAGOS_DEV_ROOT ?? "~/Dev")),
    claudeBinPath,
  };
}

export const config = loadConfig();
