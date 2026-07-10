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
  isUsageLimitError,
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
import { createDecisionBroker } from "../adapters/agent/decisions";
import { sweepPendingDecisionTurns } from "../adapters/db/repos/manager";
import {
  createWorkerRuntime,
  type LaneViolationNotice,
} from "../adapters/agent/worker-runtime";
import { runTriageJob } from "../adapters/agent/triage";
import { runWatchdogReview } from "../adapters/legs/watchdog";
import { runCriticReview } from "../adapters/legs/critic";
import { getAttentionItem, resolveAttentionItem } from "../adapters/db/repos/attention";
import { commitRecords } from "../adapters/git/mutating-runner";
import { ingestVaultSpecifics } from "../adapters/records/ingest";
import { createRecordsStore } from "../adapters/records/store";
import { chooseFolder, revealFolder } from "../adapters/system/dialogs";
import { createMonitor } from "./monitor";

const db = openDb(config.stateDir);
// The only module-level state: live SSE clients, per-project busy flags, the
// in-flight turn kill switches, and the worker runtime's live session
// handles. Everything durable lives in SQLite as it lands.
const busyProjects = new Set<string>();
// Post-turn distillation in flight, per project. Distill no longer holds the
// busy flag (the user's chat unlocks the moment the turn completes) — but the
// manager session must never be forked concurrently with a new turn, so the
// NEXT turn awaits this promise instead of the user eating a 409.
const distillsInFlight = new Map<string, Promise<void>>();
const eventClients = new Set<http.ServerResponse>();
const activeTurnControllers = new Map<string, AbortController>();
// Per-project manager-model override, set when the user hits "change to Opus"
// after Fable's usage limit. In-memory on purpose: a daemon restart drops it,
// so Darwin retries on Fable once the limit window has likely reset.
const managerModelOverrides = new Map<string, string>();
// A lane violation that arrives while Darwin is mid-turn: the worker is
// already frozen, so we hold the latest stray here and wake Darwin the instant
// the turn lock frees — never forking his session.
const pendingLaneWakes = new Map<string, LaneViolationNotice>();
const workers = createWorkerRuntime({
  db,
  config,
  broadcast: (event) => broadcast(event),
  // A worker caught writing outside its lane is frozen by the runtime; here we
  // wake Darwin to course-correct it (fire-and-forget — never block the
  // worker's event loop on a manager turn).
  onLaneViolation: (notice) => {
    void wakeManagerForLaneViolation(notice);
  },
});
const decisions = createDecisionBroker();
// The monitor tick makes zero LLM calls; triage is the event-driven session
// it triggers only when new open attention items exist (architecture §7).
const monitor = createMonitor({
  db,
  config,
  broadcast: (event) => broadcast(event),
  // The judgment legs (user-confirmed 2026-07-05): watchdog reads the
  // transcript, the critic judges the diff against the brief — both on
  // fresh single-shot sessions, both persisted as jobs rows.
  runWatchdog: ({ worker, lane, digestId }) =>
    runWatchdogReview({ db, config, worker, lane, digestId }),
  runCritic: ({ worker, lane, digestId }) => {
    const project = getProject(db, worker.project_id);
    if (!project) {
      return Promise.resolve({ ran: false, error: `unknown project ${worker.project_id}` });
    }
    return runCriticReview({ db, config, project, worker, lane, digestId });
  },
  // Quality-gated retirement: the tick just proved the completion clean, so
  // the stop is ungated ("force"); the reason lands in the stream's stopped
  // marker so the retirement reads honestly.
  retireWorker: async (workerId, reason) => {
    const outcome = await workers.stop(workerId, reason, { intent: "force" });
    if (!outcome.ok) {
      console.error(`[monitor] auto-retire of ${workerId} refused: ${outcome.reason}`);
    }
  },
  runTriage: async (project) => {
    const outcome = await runTriageJob({
      db,
      config,
      project,
      workers,
      broadcast: (event) => broadcast(event),
    });
    if (outcome.error) {
      console.error(`[triage] ${project.slug}: ${outcome.error}`);
    } else if (outcome.ran) {
      console.log(
        `[triage] ${project.slug}: worked ${outcome.itemsInBatch} item${outcome.itemsInBatch === 1 ? "" : "s"} (${outcome.actions.length} action${outcome.actions.length === 1 ? "" : "s"})`,
      );
    }
  },
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

  // An explicit model (the "change to Opus" retry) switches this project's
  // manager model for good — a limited Fable stays limited, so every later
  // turn defaults to the override until the daemon restarts.
  const requestedModel = asString(body.model);
  if (requestedModel) {
    managerModelOverrides.set(projectId, requestedModel);
  }
  const activeManagerModel = managerModelOverrides.get(projectId) ?? config.managerModel;
  const effectiveConfig =
    activeManagerModel === config.managerModel
      ? config
      : { ...config, managerModel: activeManagerModel };

  busyProjects.add(projectId);
  // Everything below releases ONLY what this request owns: by the time a
  // late finally runs, the busy flag and kill switch may already belong to
  // the user's next turn.
  let busyReleased = false;
  const releaseBusy = () => {
    if (!busyReleased) {
      busyReleased = true;
      busyProjects.delete(projectId);
    }
  };
  let myController: AbortController | null = null;
  const armController = (controller: AbortController) => {
    myController = controller;
    activeTurnControllers.set(projectId, controller);
  };
  startSse(res);
  const emit = (event: ManagerTurnEvent) => {
    sseWrite(res, event);
    // Decision cards ride the daemon broadcast too: the needs-you cue (tab
    // badge + notification) must fire even when the asking turn's stream
    // belongs to a tab the user isn't looking at.
    if (
      event.type === "turn_complete" ||
      event.type === "turn_error" ||
      event.type === "decision_request" ||
      event.type === "decision_settled"
    ) {
      broadcast({ ...event, projectId });
    }
  };

  try {
    // The previous turn's distillation may still be running. The fork
    // invariant stands — the manager session is never forked concurrently
    // with a live turn — but the wait moved server-side: the message is
    // accepted and queues here instead of bouncing off a 409.
    const pendingDistill = distillsInFlight.get(projectId);
    if (pendingDistill) {
      await pendingDistill;
    }

    // One kill switch per phase: interrupting the turn must not also kill the
    // distill pass that follows (the user chose to keep it), but a second
    // triple-Esc during distillation aborts the fork too.
    const turnController = new AbortController();
    armController(turnController);
    const outcome = await runManagerTurn({
      db,
      config: effectiveConfig,
      project,
      userText: text,
      emit,
      abortController: turnController,
      workers,
      decisions,
    });

    // Post-turn distillation no longer holds the input lock: the turn is
    // over, so the chat unlocks NOW. The stream stays open to deliver the
    // distilled note, and distillsInFlight serializes the next turn against
    // the fork. Interrupted turns still distill — partial exchanges can hold
    // durable agreements, and the records commit must happen regardless.
    if (outcome.completed || outcome.interrupted) {
      const distillController = new AbortController();
      armController(distillController);
      const distillPromise = (async () => {
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
      })();
      // Register the guard (swallowed copy — a distill failure must not
      // reject the next turn's wait) BEFORE releasing the busy flag, so
      // there is no instant where a new turn sees neither lock.
      const guard = distillPromise.catch(() => {});
      distillsInFlight.set(projectId, guard);
      releaseBusy();
      try {
        await distillPromise;
      } finally {
        if (distillsInFlight.get(projectId) === guard) {
          distillsInFlight.delete(projectId);
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sseWrite(res, {
      type: "turn_error",
      message,
      limitReached: isUsageLimitError(message),
      model: effectiveConfig.managerModel,
    });
  } finally {
    if (myController && activeTurnControllers.get(projectId) === myController) {
      activeTurnControllers.delete(projectId);
    }
    releaseBusy();
    res.end();
    // A worker may have strayed and frozen while this turn ran — handle it now
    // that Darwin is free.
    drainPendingLaneWake(projectId);
  }
}

/**
 * Wake Darwin to course-correct a worker that stepped outside its lane and was
 * frozen by the runtime. The freeze already stopped the bleeding, so if a user
 * turn is in flight we do NOT fork the session — we hold the stray and drain it
 * when the lock frees. Otherwise we run an autonomous manager turn seeded with
 * the violation. Fire-and-forget; never throws.
 */
async function wakeManagerForLaneViolation(notice: LaneViolationNotice): Promise<void> {
  const project = getProject(db, notice.projectId);
  if (!project) {
    return;
  }
  const fileList = notice.violations.map((v) => `${v.path} (${v.reason})`).join(", ");
  const noteText = `A worker in lane "${notice.laneName}" stepped outside its lane and was frozen automatically — Darwin is course-correcting.`;
  const seed =
    `SYSTEM — automatic lane guard.\n\n` +
    `Worker ${notice.workerId} (lane "${notice.laneName}") wrote outside its allowed globs and has been FROZEN (held) automatically. Out-of-lane changes: ${fileList}.\n\n` +
    `The worker is paused and will not write further. Course-correct it now:\n` +
    `1. Call worker_status ${notice.workerId} to see its lane contract, recent events, and the stray files. Also check list_attention for any OTHER frozen workers.\n` +
    `2. Then decide and act:\n` +
    `   - Stray by mistake: steer_worker to tell it to revert those exact files and stay strictly within its lane, then continue.\n` +
    `   - Off-brief or unsalvageable: stop_worker.\n` +
    `   - The stray is legitimate and the lane is simply too narrow: do NOT amend the lane on your own here — steer the worker to keep holding, and tell the user in your reply that the lane needs widening for ${fileList} so they can approve it in conversation.\n` +
    `Do not leave the worker frozen without a decision.`;

  if (busyProjects.has(project.id)) {
    // Latest stray wins; the durable lane_violation attention items already
    // record every one. Handled when the current turn's finally drains it.
    pendingLaneWakes.set(project.id, notice);
    broadcast({ type: "manager_note", projectId: project.id, text: noteText });
    broadcast({ type: "attention_changed", projectId: project.id });
    return;
  }

  busyProjects.add(project.id);
  broadcast({ type: "manager_note", projectId: project.id, text: noteText });
  try {
    // Respect the fork invariant: never start a turn while the previous turn's
    // distillation fork is still running. Turn-lock decoupled distill from the
    // busy flag, so a free busy flag does not mean the session is idle.
    const pendingDistill = distillsInFlight.get(project.id);
    if (pendingDistill) {
      await pendingDistill;
    }
    // Honor the project's manager-model override (e.g. the user switched Darwin
    // to Opus after a Fable limit) so the autonomous turn uses the live model.
    const activeManagerModel = managerModelOverrides.get(project.id) ?? config.managerModel;
    const effectiveConfig =
      activeManagerModel === config.managerModel
        ? config
        : { ...config, managerModel: activeManagerModel };
    const turnController = new AbortController();
    activeTurnControllers.set(project.id, turnController);
    const outcome = await runManagerTurn({
      db,
      config: effectiveConfig,
      project,
      userText: seed,
      emit: (event) => {
        // Autonomous turns have no chat stream — the broadcast is the ONLY
        // path a decision card (e.g. the amend_lane gate) reaches the user.
        if (
          event.type === "turn_complete" ||
          event.type === "turn_error" ||
          event.type === "decision_request" ||
          event.type === "decision_settled"
        ) {
          broadcast({ ...event, projectId: project.id });
        }
      },
      abortController: turnController,
      workers,
      decisions,
    });
    if (outcome.completed || outcome.interrupted) {
      const distillController = new AbortController();
      activeTurnControllers.set(project.id, distillController);
      await runDistillJob({
        db,
        config,
        project,
        sessionId: outcome.sessionId,
        sdkSessionId: outcome.sdkSessionId,
        abortController: distillController,
      });
    }
  } catch (error) {
    console.error(
      `[lane-guard] autonomous course-correction failed for ${project.slug}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    activeTurnControllers.delete(project.id);
    busyProjects.delete(project.id);
    // Another worker may have strayed during this turn — drain it.
    drainPendingLaneWake(project.id);
  }
}

/** Wake Darwin for a stray that queued while the project was busy, if any. */
function drainPendingLaneWake(projectId: string): void {
  const pending = pendingLaneWakes.get(projectId);
  if (pending) {
    pendingLaneWakes.delete(projectId);
    void wakeManagerForLaneViolation(pending);
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
  const outcome = await workers.steer(workerId, message, { awaitResponse: false });
  if (!outcome.ok) {
    sendJson(res, 409, { error: outcome.reason });
    return;
  }
  sendJson(res, 200, { ok: true });
}

async function handleHoldWorker(res: http.ServerResponse, workerId: string): Promise<void> {
  const outcome = await workers.hold(workerId, "the user, via the workers page");
  if (!outcome.ok) {
    sendJson(res, 409, { error: outcome.reason });
    return;
  }
  sendJson(res, 200, { ok: true, response: outcome.response });
}

/**
 * The UI's answer to a chat decision (ask_user / amend_lane gate). The busy
 * flag deliberately does NOT block this route — the pending decision IS the
 * busy turn waiting on the user.
 */
async function handleDecisionAnswer(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const decisionId = asString(body.decisionId);
  if (!decisionId) {
    sendJson(res, 400, { error: "decisionId is required." });
    return;
  }
  const selections = asStringArray(body.selections) ?? [];
  const custom = typeof body.custom === "string" ? body.custom : "";
  // Batch answers carry per-field selected labels, keyed by field id.
  const responses: Record<string, string[]> = {};
  if (body.responses && typeof body.responses === "object") {
    for (const [fieldId, value] of Object.entries(body.responses as Record<string, unknown>)) {
      const labels = asStringArray(value);
      if (labels) {
        responses[fieldId] = labels;
      }
    }
  }
  if (!decisions.answer(decisionId, { selections, responses, custom })) {
    sendJson(res, 409, {
      error: "That decision is no longer pending — it was answered, timed out, or belongs to an ended turn.",
    });
    return;
  }
  sendJson(res, 200, { ok: true });
}

async function handleStopWorker(res: http.ServerResponse, workerId: string): Promise<void> {
  // The user's Stop button is the ungated escape hatch — never quality-gated.
  const outcome = await workers.stop(workerId, "the user, via the workers page", {
    intent: "force",
  });
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

/**
 * The queue UI's resolve/dismiss action — a write, so it goes through the
 * daemon like every other command.
 */
async function handleResolveAttention(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  itemId: string,
): Promise<void> {
  const body = await readBody(req);
  const resolution = asString(body.resolution);
  if (resolution !== "resolved" && resolution !== "dismissed") {
    sendJson(res, 400, { error: 'resolution must be "resolved" or "dismissed".' });
    return;
  }
  const item = getAttentionItem(db, itemId);
  if (!item) {
    sendJson(res, 404, { error: `Unknown attention item: ${itemId}` });
    return;
  }
  if (item.status !== "open") {
    sendJson(res, 409, { error: `Attention item is already ${item.status}.` });
    return;
  }
  const note = asString(body.note);
  resolveAttentionItem(db, itemId, resolution, note ?? `${resolution} by the user from the queue`);
  broadcast({ type: "attention_changed", projectId: item.project_id });
  sendJson(res, 200, { ok: true });
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
  const attentionAction = /^\/attention\/([^/]+)\/resolve$/.exec(url.pathname);
  if (req.method === "POST" && attentionAction?.[1]) {
    void handleResolveAttention(req, res, attentionAction[1]).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if (route === "POST /manager/decision") {
    void handleDecisionAnswer(req, res).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  const workerAction = /^\/workers\/([^/]+)\/(steer|stop|hold)$/.exec(url.pathname);
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
    if (workerId && action === "hold") {
      void handleHoldWorker(res, workerId).catch((error) => {
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
  const staleDecisions = sweepPendingDecisionTurns(db);
  if (staleDecisions > 0) {
    console.log(`[decisions] expired ${staleDecisions} pending decision${staleDecisions === 1 ? "" : "s"} from before the restart`);
  }
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
  monitor.start();
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
