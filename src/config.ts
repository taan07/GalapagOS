import os from "node:os";
import path from "node:path";

export type GalapagosConfig = {
  stateDir: string;
  vaultPath: string;
  managerModel: string;
  daemonPort: number;
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

  return {
    stateDir,
    vaultPath,
    managerModel: env.GALAPAGOS_MANAGER_MODEL ?? "claude-fable-5",
    daemonPort,
  };
}

export const config = loadConfig();
