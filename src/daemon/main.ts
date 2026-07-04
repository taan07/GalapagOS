import http from "node:http";
import { config } from "../config";
import { openDb } from "../adapters/db/db";
import {
  createNewProject,
  getProject,
  listProjects,
  registerProject,
  type ProjectRow,
} from "../adapters/db/repos/projects";
import { runDistillJob } from "../adapters/agent/distill";
import { runManagerTurn, type ManagerTurnEvent } from "../adapters/agent/manager-session";
import { commitRecords } from "../adapters/git/mutating-runner";
import { ingestVaultSpecifics } from "../adapters/records/ingest";
import { createRecordsStore } from "../adapters/records/store";
import { chooseFolder, revealFolder } from "../adapters/system/dialogs";

const db = openDb(config.stateDir);
// The only module-level state: live SSE clients and per-project busy flags.
// Everything durable lives in SQLite.
const busyProjects = new Set<string>();
const eventClients = new Set<http.ServerResponse>();

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function startSse(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
}

function sseWrite(res: http.ServerResponse, event: unknown): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(event: unknown): void {
  for (const client of eventClients) {
    sseWrite(client, event);
  }
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("Request body is not valid JSON.");
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Import Chunk-1-era vault specifics into the project's records store.
 * Idempotent (migrated files are stamped), so it runs on every daemon start
 * and after every registration — Darwin's memory must not reset or fork when
 * the store arrives, and a second start must not re-import.
 */
async function ingestProjectVault(project: ProjectRow): Promise<void> {
  try {
    const store = createRecordsStore(project.root_path, project.slug);
    const result = ingestVaultSpecifics({
      store,
      vaultPath: config.vaultPath,
      projectSlug: project.slug,
    });
    if (result.ingested.length === 0) {
      return;
    }
    const commit = await commitRecords(
      project.root_path,
      `galapagos(records): ingest ${result.ingested.length} vault specific${result.ingested.length === 1 ? "" : "s"}`,
    );
    console.log(
      `[records] ${project.slug}: ingested ${result.ingested.length} vault specifics (commit: ${commit.status})`,
    );
  } catch (error) {
    console.error(
      `[records] vault ingestion failed for ${project.slug}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function handleManagerMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const projectId = asString(body.projectId);
  const text = asString(body.text);
  if (!projectId || !text) {
    sendJson(res, 400, { error: "projectId and text are required." });
    return;
  }
  const project = getProject(db, projectId);
  if (!project) {
    sendJson(res, 404, { error: `Unknown project: ${projectId}` });
    return;
  }
  if (busyProjects.has(projectId)) {
    sendJson(res, 409, { error: "Darwin is already working on a turn for this project.", busy: true });
    return;
  }

  busyProjects.add(projectId);
  startSse(res);
  const emit = (event: ManagerTurnEvent) => {
    sseWrite(res, event);
    if (event.type === "turn_complete" || event.type === "turn_error") {
      broadcast({ ...event, projectId });
    }
  };

  try {
    const outcome = await runManagerTurn({ db, config, project, userText: text, emit });

    // Post-turn distillation runs while the stream (and the busy flag) is
    // still held: the manager session must never be forked concurrently with
    // a new user turn. The fork's records land before the input unlocks.
    if (outcome.completed) {
      const distill = await runDistillJob({
        db,
        config,
        project,
        sessionId: outcome.sessionId,
        sdkSessionId: outcome.sdkSessionId,
      });
      sseWrite(res, {
        type: "distilled",
        recordsWritten: distill.recordsWritten,
        committed: distill.commit.status === "committed",
        ...(distill.commit.status === "skipped"
          ? { commitSkippedReason: distill.commit.reason }
          : {}),
        ...(distill.error ? { error: distill.error } : {}),
      });
    }
  } catch (error) {
    sseWrite(res, {
      type: "turn_error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    busyProjects.delete(projectId);
    res.end();
  }
}

async function handleRegisterProject(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const rootPath = asString(body.rootPath);
  if (!rootPath) {
    sendJson(res, 400, { error: "rootPath is required." });
    return;
  }
  try {
    const project = await registerProject(db, {
      rootPath,
      name: asString(body.name),
      initGit: body.initGit === true,
    });
    await ingestProjectVault(project);
    sendJson(res, 201, { project });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const needsGitInit = /never manages a project without history/.test(message);
    sendJson(res, needsGitInit ? 409 : 400, { error: message, needsGitInit });
  }
}

async function handleCreateProject(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const name = asString(body.name);
  if (!name) {
    sendJson(res, 400, { error: "name is required." });
    return;
  }
  try {
    const project = await createNewProject(db, { name, devRoot: config.devRoot });
    await ingestProjectVault(project);
    sendJson(res, 201, { project });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, /already exists/.test(message) ? 409 : 400, { error: message });
  }
}

async function handleChooseFolder(res: http.ServerResponse): Promise<void> {
  try {
    const result = await chooseFolder(config.devRoot);
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /health") {
    sendJson(res, 200, {
      ok: true,
      service: "galapagos-daemon",
      model: config.managerModel,
      devRoot: config.devRoot,
    });
    return;
  }
  if (route === "GET /projects") {
    sendJson(res, 200, { projects: listProjects(db) });
    return;
  }
  if (route === "POST /projects") {
    void handleRegisterProject(req, res).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if (route === "POST /system/choose-folder") {
    void handleChooseFolder(res);
    return;
  }
  if (route === "POST /system/reveal-dev-root") {
    void revealFolder(config.devRoot)
      .then(() => sendJson(res, 200, { ok: true }))
      .catch((error) =>
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }),
      );
    return;
  }
  if (route === "POST /projects/create") {
    void handleCreateProject(req, res).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if (route === "POST /manager/message") {
    void handleManagerMessage(req, res).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if (route === "GET /events") {
    startSse(res);
    eventClients.add(res);
    req.on("close", () => {
      eventClients.delete(res);
    });
    return;
  }

  sendJson(res, 404, { error: `No route: ${route}` });
});

server.listen(config.daemonPort, "127.0.0.1", () => {
  console.log(
    `galapagos daemon listening on http://127.0.0.1:${config.daemonPort} (state: ${config.stateDir}, model: ${config.managerModel})`,
  );
  // Idempotent per-project vault ingestion on every start (chunk 2 brief).
  void (async () => {
    for (const project of listProjects(db)) {
      await ingestProjectVault(project);
    }
  })();
});
