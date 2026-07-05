import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
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
import {
  runManagerTurn,
  type ManagerTurnEvent,
  type RebriefTurnPayload,
} from "../adapters/agent/manager-session";
import {
  appendTurn,
  compactSession,
  getOrCreateActiveSession,
  getTurn,
  updateTurnContent,
} from "../adapters/db/repos/manager";
import { createWorkerRuntime } from "../adapters/agent/worker-runtime";
import { commitRecords } from "../adapters/git/mutating-runner";
import { ingestVaultSpecifics } from "../adapters/records/ingest";
import { createRecordsStore } from "../adapters/records/store";
import { chooseFolder, revealFolder } from "../adapters/system/dialogs";

const db = openDb(config.stateDir);
// The only module-level state: live SSE clients, per-project busy flags, the
// in-flight turn kill switches, and the worker runtime's live session
// handles. Everything durable lives in SQLite as it lands.
const busyProjects = new Set<string>();
const eventClients = new Set<http.ServerResponse>();
const activeTurnControllers = new Map<string, AbortController>();
const workers = createWorkerRuntime({
  db,
  config,
  broadcast: (event) => broadcast(event),
});

const execFileAsync = promisify(execFile);

// Which code is this process actually running? Learned the hard way: a stale
// daemon once masqueraded as current through a whole verification session.
const codeIdentity = { revision: "unknown", branch: "unknown" };
async function resolveCodeIdentity(): Promise<void> {
  try {
    // npm scripts run from the package root, which is the galapagos checkout.
    const git = (args: string[]) =>
      execFileAsync("git", args, { cwd: process.cwd(), encoding: "utf8" });
    codeIdentity.revision = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim();
    codeIdentity.branch = (await git(["branch", "--show-current"])).stdout.trim() || "(detached)";
  } catch {
    // Not a git checkout (packaged install) — "unknown" is the honest answer.
  }
}

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
      // Pure silence here once cost an hour of "did ingestion even run?" —
      // say so when there were specifics and they're all already migrated.
      if (result.skipped > 0) {
        console.log(
          `[records] ${project.slug}: ${result.skipped} vault specific${result.skipped === 1 ? "" : "s"} already migrated`,
        );
      }
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
    // One kill switch per phase: interrupting the turn must not also kill the
    // distill pass that follows (the user chose to keep it), but a second
    // triple-Esc during distillation aborts the fork too.
    const turnController = new AbortController();
    activeTurnControllers.set(projectId, turnController);
    const outcome = await runManagerTurn({
      db,
      config,
      project,
      userText: text,
      emit,
      abortController: turnController,
      workers,
    });

    // Post-turn distillation runs while the stream (and the busy flag) is
    // still held: the manager session must never be forked concurrently with
    // a new user turn. The fork's records land before the input unlocks.
    // Interrupted turns still distill — partial exchanges can hold durable
    // agreements, and the records commit must happen regardless.
    if (outcome.completed || outcome.interrupted) {
      const distillController = new AbortController();
      activeTurnControllers.set(projectId, distillController);
      const distill = await runDistillJob({
        db,
        config,
        project,
        sessionId: outcome.sessionId,
        sdkSessionId: outcome.sdkSessionId,
        abortController: distillController,
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
    activeTurnControllers.delete(projectId);
    busyProjects.delete(projectId);
    res.end();
  }
}

/** Triple-Esc in the UI lands here: kill whatever phase is in flight. */
async function handleInterrupt(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const projectId = asString(body.projectId);
  if (!projectId) {
    sendJson(res, 400, { error: "projectId is required." });
    return;
  }
  const controller = activeTurnControllers.get(projectId);
  if (!controller) {
    sendJson(res, 409, { error: "No turn in flight for this project." });
    return;
  }
  controller.abort();
  sendJson(res, 200, { ok: true });
}

/**
 * Deliberately clear a re-brief: the user chose to drop even the
 * record-seeded context, so the active session is retired and the next turn
 * starts from a truly blank session (records stay on disk; Darwin only knows
 * them again if he reads them with his tools).
 */
async function handleClearRebrief(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const projectId = asString(body.projectId);
  const turnId = asString(body.turnId);
  if (!projectId || !turnId) {
    sendJson(res, 400, { error: "projectId and turnId are required." });
    return;
  }
  const project = getProject(db, projectId);
  if (!project) {
    sendJson(res, 404, { error: `Unknown project: ${projectId}` });
    return;
  }
  if (busyProjects.has(projectId)) {
    sendJson(res, 409, { error: "Darwin is mid-turn — wait for it to finish before clearing." });
    return;
  }

  const turn = getTurn(db, turnId);
  let payload: RebriefTurnPayload | null = null;
  if (turn && turn.role === "system") {
    try {
      const parsed = JSON.parse(turn.content) as RebriefTurnPayload;
      payload = parsed.kind === "rebrief" ? parsed : null;
    } catch {
      payload = null;
    }
  }
  if (!turn || !payload) {
    sendJson(res, 404, { error: "That turn is not a re-brief." });
    return;
  }
  if (payload.clearedAt) {
    sendJson(res, 409, { error: "This re-brief was already cleared." });
    return;
  }
  const activeSession = getOrCreateActiveSession(db, projectId);
  if (turn.session_id !== activeSession.id) {
    sendJson(res, 409, {
      error: "Only the current session's re-brief can be cleared — this one was already superseded.",
    });
    return;
  }

  updateTurnContent(
    db,
    turn.id,
    JSON.stringify({ ...payload, clearedAt: new Date().toISOString() }),
  );
  const fresh = compactSession(db, projectId, activeSession.id, { seededFromRecords: false });
  const note = appendTurn(db, {
    sessionId: fresh.id,
    role: "system",
    content: JSON.stringify({
      kind: "note",
      text: "Re-brief cleared — Darwin starts the next turn from a blank context. The committed records remain on disk; he will only know them again if he reads them with his tools.",
    }),
  });
  sendJson(res, 200, { ok: true, sessionId: fresh.id, noteTurnId: note.id });
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

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;
}

async function handleSpawnWorker(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const projectId = asString(body.projectId);
  const laneName = asString(body.laneName);
  const allowedGlobs = asStringArray(body.allowedGlobs);
  const briefTitle = asString(body.briefTitle);
  const brief = asString(body.brief);
  if (!projectId || !laneName || !allowedGlobs || !briefTitle || !brief) {
    sendJson(res, 400, {
      error: "projectId, laneName, allowedGlobs, briefTitle, and brief are required.",
    });
    return;
  }
  const project = getProject(db, projectId);
  if (!project) {
    sendJson(res, 404, { error: `Unknown project: ${projectId}` });
    return;
  }
  // A present-but-invalid forbiddenGlobs must be an error, not a silently
  // dropped constraint — the caller asked for a narrower lane than they get.
  const forbiddenGlobs = asStringArray(body.forbiddenGlobs);
  if (body.forbiddenGlobs !== undefined && !forbiddenGlobs) {
    sendJson(res, 400, { error: "forbiddenGlobs must be an array of strings when provided." });
    return;
  }
  const model = asString(body.model);
  const outcome = await workers.spawn({
    project,
    laneName,
    allowedGlobs,
    ...(forbiddenGlobs ? { forbiddenGlobs } : {}),
    briefTitle,
    brief,
    ...(model ? { model } : {}),
  });
  if (!outcome.ok) {
    sendJson(res, 409, { error: outcome.reason });
    return;
  }
  sendJson(res, 201, { worker: outcome });
}

async function handleSteerWorker(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workerId: string,
): Promise<void> {
  const body = await readBody(req);
  const message = asString(body.message);
  if (!message) {
    sendJson(res, 400, { error: "message is required." });
    return;
  }
  const outcome = workers.steer(workerId, message);
  if (!outcome.ok) {
    sendJson(res, 409, { error: outcome.reason });
    return;
  }
  sendJson(res, 200, { ok: true });
}

async function handleStopWorker(res: http.ServerResponse, workerId: string): Promise<void> {
  const outcome = await workers.stop(workerId);
  if (!outcome.ok) {
    sendJson(res, 409, { error: outcome.reason });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    status: outcome.status,
    violations: outcome.violations,
    hasDigest: outcome.hasDigest,
    auditError: outcome.auditError,
  });
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
      revision: codeIdentity.revision,
      branch: codeIdentity.branch,
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
  if (route === "POST /manager/interrupt") {
    void handleInterrupt(req, res).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if (route === "POST /manager/rebrief/clear") {
    void handleClearRebrief(req, res).catch((error) => {
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
  if (route === "POST /workers") {
    void handleSpawnWorker(req, res).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  const workerAction = /^\/workers\/([^/]+)\/(steer|stop)$/.exec(url.pathname);
  if (req.method === "POST" && workerAction) {
    const [, workerId, action] = workerAction;
    if (workerId && action === "steer") {
      void handleSteerWorker(req, res, workerId).catch((error) => {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (workerId && action === "stop") {
      void handleStopWorker(res, workerId).catch((error) => {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
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

void (async () => {
  // Workers whose rows say "live" after a restart are orphans — their
  // sessions died with the old process. Reconcile BEFORE accepting requests:
  // otherwise a status check in the gap reports a dead worker as running and
  // a spawn is refused by a corpse's still-active lane. Guarded — boot must
  // survive a reconcile failure (and still run vault ingestion after it).
  try {
    const orphans = await workers.reconcileOrphans();
    if (orphans > 0) {
      console.log(`[workers] reconciled ${orphans} orphaned worker${orphans === 1 ? "" : "s"} after restart`);
    }
  } catch (error) {
    console.error(
      `[workers] orphan reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  await resolveCodeIdentity();
  server.listen(config.daemonPort, "127.0.0.1", () => {
    console.log(
      `galapagos daemon listening on http://127.0.0.1:${config.daemonPort} (rev: ${codeIdentity.revision} on ${codeIdentity.branch}, state: ${config.stateDir}, model: ${config.managerModel})`,
    );
    // Idempotent per-project vault ingestion on every start (chunk 2 brief);
    // ingestProjectVault never rejects (fully guarded internally).
    void (async () => {
      for (const project of listProjects(db)) {
        await ingestProjectVault(project);
      }
    })();
  });
})();
