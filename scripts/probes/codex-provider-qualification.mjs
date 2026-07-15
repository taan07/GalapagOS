#!/usr/bin/env node
/**
 * Disposable Codex provider qualification probe.
 *
 * It deliberately never calls `codex login`, never reads another CODEX_HOME,
 * and removes API/access-token variables before invoking the bundled CLI.
 * Set KEEP_CODEX_PROBE_STATE=1 only for local protocol debugging; do not
 * commit the resulting directory.
 */
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const KEEP_STATE = process.env.KEEP_CODEX_PROBE_STATE === "1";
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const isolatedHome = mkdtempSync(join(tmpdir(), "galapagos-codex-home-"));
const CWD = join(isolatedHome, "empty-project");
const SCHEMA_DIR = join(isolatedHome, "app-server-schema");

const redact = (value) => String(value)
  .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
  .replace(/\b(sk|sess|eyJ)[A-Za-z0-9_.-]{12,}\b/g, "[REDACTED_TOKEN]")
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");

const safeEnv = () => {
  const env = { ...process.env, CODEX_HOME: isolatedHome };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_ACCESS_TOKEN;
  return env;
};

const command = (args, options = {}) => {
  const result = spawnSync(CODEX_BIN, args, {
    cwd: CWD,
    env: safeEnv(),
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
  });
  return {
    args,
    exitCode: result.status,
    signal: result.signal,
    stdout: redact(result.stdout || ""),
    stderr: redact(result.stderr || ""),
    error: result.error ? redact(result.error.message) : null,
  };
};

function schemaFacts() {
  const files = readdirSync(SCHEMA_DIR, { recursive: true })
    .filter((file) => String(file).endsWith(".json"))
    .map(String)
    .sort();
  const lifecycleSchemas = files.filter((file) => /(?:ModelList|Thread(?:Start|Resume)|Turn(?:Start|Interrupt)|Initialize)/.test(file));
  const inspectionSchemas = files.filter((file) => /(?:ConfigRead|HooksList|ListMcpServerStatus|PluginList|SkillsList)/.test(file));
  return {
    jsonFileCount: files.length,
    lifecycleSchemas,
    inspectionSchemas,
  };
}

function authenticationState(login) {
  const text = `${login.stdout}\n${login.stderr}`;
  if (/not logged in|not authenticated|no active (login|session)|logged out/i.test(text)) return "unavailable";
  if (/logged in|authenticated|chatgpt/i.test(text) && login.exitCode === 0) return "available";
  return "indeterminate";
}

function appServer() {
  const child = spawn(CODEX_BIN, ["app-server", "--strict-config"], {
    cwd: CWD,
    env: safeEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  let stderr = "";
  let nextId = 1;
  const pending = new Map();
  let buffer = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { events.push({ unparsable: redact(line) }); continue; }
      events.push(message);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });

  const request = (method, params, timeout = 15_000) => new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ id, timeout: true, method });
    }, timeout);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
  });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  const close = () => new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  });

  return { request, notify, close, events, stderr: () => redact(stderr) };
}

async function liveProbe() {
  const server = appServer();
  const initialize = await server.request("initialize", {
    clientInfo: { name: "galapagos-codex-qualification", version: "0.1.0" },
    capabilities: {},
  });
  server.notify("initialized", {});
  const models = await server.request("model/list", {});
  const close = await server.close();
  return { initialize, models, close, notifications: server.events, stderr: server.stderr() };
}

function summariseRpc(value) {
  // Keep protocol structure for the report while avoiding account-specific or token-bearing fields.
  return JSON.parse(redact(JSON.stringify(value)));
}

async function main() {
  mkdirSync(CWD);
  writeFileSync(join(isolatedHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
  const initiallyPresent = readdirSync(isolatedHome).sort();
  const version = command(["--version"]);
  const login = command(["login", "status"]);
  const auth = authenticationState(login);
  const schema = command(["app-server", "generate-json-schema", "--out", SCHEMA_DIR]);

  const report = {
    probeVersion: 1,
    binary: { command: CODEX_BIN, version },
    isolation: {
      homeKind: "mkdtemp under system temp directory",
      cwdKind: "new empty directory inside isolated CODEX_HOME",
      initialEntries: initiallyPresent,
      config: 'cli_auth_credentials_store = "keyring"',
      credentialEnvironmentRemoved: ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"],
      noLoginAttempted: true,
    },
    login,
    authentication: auth,
    schema,
    schemaFacts: schema.exitCode === 0 ? schemaFacts() : null,
    live: null,
    usage: { turnsAttempted: 0, turnsCompleted: 0, note: "No model turns are issued by this probe." },
  };

  // Initialization and model/list are read-only protocol calls. Do not begin a
  // thread here: the qualification brief caps model use and requires a human
  // review of the generated schema before any live-turn extension.
  if (auth === "available") report.live = summariseRpc(await liveProbe());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (KEEP_STATE) process.stderr.write(`Retained isolated state: ${isolatedHome}\n`);
  else rmSync(isolatedHome, { recursive: true, force: true });
}

main().catch((error) => {
  process.stderr.write(`${redact(error.stack || error.message)}\n`);
  if (!KEEP_STATE) rmSync(isolatedHome, { recursive: true, force: true });
  process.exitCode = 1;
});
