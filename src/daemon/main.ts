import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { config } from "../config";
import { openDb } from "../adapters/db/db";
import {
  createNewProject,
  flipInterviewToDefault,
  getProject,
  listProjects,
  projectAutonomyMode,
  registerProject,
  setProjectAutonomyMode,
  type ProjectRow,
} from "../adapters/db/repos/projects";
import { AUTONOMY_MODES, isAutonomyMode } from "../core/autonomy";
import {
  MAX_MESSAGE_BODY_BYTES,
  attachmentPromptNote,
  parseOutgoingAttachments,
  type UserTurnPayload,
} from "../core/attachments";
import { storeAttachments } from "../adapters/attachments/store";
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
  listTurns,
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
import { existsSync } from "node:fs";
import { getLane } from "../adapters/db/repos/lanes";
import { getWorker as getWorkerRow } from "../adapters/db/repos/workers";
import { getCompletionDigest } from "../adapters/db/repos/digests";
import { getCompletionRetirement } from "../adapters/db/repos/retirements";
import { CHECK_KEYS, latestRunsByKey } from "../adapters/db/repos/evidence";
import { parseStatusPorcelain } from "../core/git/parsers";
import { checkViewsFrom, parseCommitLog } from "../core/worker-changes";
import { LocalGitCommandRunner } from "../adapters/git/runner";
import { observeWorkspaceEvidence } from "../adapters/evidence/workspace";
import { commitRecords } from "../adapters/git/mutating-runner";
import { ingestVaultSpecifics } from "../adapters/records/ingest";
import { createRecordsStore } from "../adapters/records/store";
import { chooseFolder, revealFolder } from "../adapters/system/dialogs";
import { createMonitor } from "./monitor";
import {
  EMPTY_LIVE_SNAPSHOT,
  updateLiveSnapshot,
  type LiveTurnSnapshot,
} from "./live-turn-snapshot";
import { buildCompletionDebrief } from "./completion-debrief";
import {
  createCompletionDebriefScheduler,
  type DebriefAttemptContext,
  type DebriefRunResult,
} from "./completion-debrief-scheduler";
import type { CompletionDebriefRow } from "../adapters/db/repos/debriefs";
import { createSseClientRegistry } from "../core/sse-clients";

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
// The pending distill's own kill switch, so a preempting user message can
// abort the fork directly (activeTurnControllers may already belong to the
// next phase by the time the preempt runs).
const distillControllers = new Map<string, AbortController>();
const eventClients = createSseClientRegistry();
const activeTurnControllers = new Map<string, AbortController>();
// Per-project manager-model override, set when the user hits "change to Opus"
// after Fable's usage limit. In-memory on purpose: a daemon restart drops it,
// so Darwin retries on Fable once the limit window has likely reset.
const managerModelOverrides = new Map<string, string>();
// A lane violation that arrives while Darwin is mid-turn: the worker is
// already frozen, so we hold the latest stray here and wake Darwin the instant
// the turn lock frees — never forking his session.
const pendingLaneWakes = new Map<string, LaneViolationNotice>();
// Triage-card answers that landed while Darwin was mid-turn (track E): each
// queues for its own pickup turn when the lock frees.
const pendingAnswerWakes = new Map<
  string,
  { question: string; outcomeText: string; attentionId: string }[]
>();
// What an in-flight turn looks like RIGHT NOW, per project — so a client that
// loads mid-turn (reload, second tab) can arm working=true and render the
// live tail it never streamed. Served by GET /manager/live, gated on the busy
// flag there, so a stale entry is never rendered.
const liveTurnSnapshots = new Map<string, LiveTurnSnapshot>();
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

function buildDebriefAttemptContext(row: CompletionDebriefRow): DebriefAttemptContext | null {
  const project = getProject(db, row.project_id);
  const worker = getWorkerRow(db, row.worker_id);
  const digest = getCompletionDigest(db, row.digest_id);
  if (!project || !worker || !digest || digest.worker_id !== worker.id) {
    return null;
  }
  const lane = getLane(db, worker.lane_id);
  const laneName = lane?.name ?? "(unknown lane)";
  // Resolve at actual attempt time: a delayed debrief reports the latest
  // retirement retry result while remaining pinned to its original digest.
  const retirement = getCompletionRetirement(db, row.digest_id);
  const retirementView = retirement?.status === "succeeded"
    ? { status: "succeeded" as const }
    : retirement?.status === "failed"
      ? {
          status: "failed" as const,
          reason: retirement.last_error ?? "no failure reason was recorded",
          retryable: retirement.failure_kind === "transient",
        }
      : { status: retirement?.status ?? "pending" as const };
  const { noteText, seed } = buildCompletionDebrief({
    digestId: row.digest_id,
    workerId: worker.id,
    laneName,
    retirement: retirementView,
  });
  return {
    digestId: row.digest_id,
    workerId: worker.id,
    laneName,
    retirementStatus: retirement?.status ?? "missing",
    retirementFailureKind: retirement?.failure_kind ?? null,
    retirementError: retirement?.last_error ?? null,
    model: managerModelOverrides.get(project.id) ?? config.managerModel,
    seed,
    noteText,
  };
}

const completionDebriefs = createCompletionDebriefScheduler({
  db,
  isProjectBusy: (projectId) => busyProjects.has(projectId),
  buildContext: buildDebriefAttemptContext,
  runAttempt: async (row, _queuedContext, begin) => {
    const project = getProject(db, row.project_id);
    if (!project) {
      return {
        ok: false,
        failureKind: "non_retryable",
        errorCode: "project_missing",
        error: `Project ${row.project_id} no longer exists.`,
      };
    }
    // Delivery succeeds at turn_complete, not after the optional distillation
    // fork. A restart during paperwork must not duplicate a debrief the user
    // already received.
    return new Promise<DebriefRunResult>((resolve) => {
      void runAutonomousManagerTurn({
        project,
        seed: "",
        noteText: "",
        logTag: `narrator:${row.digest_id}`,
        refreshTurn: () => buildDebriefAttemptContext(row),
        onTurnBeginning: begin,
        onTurnSettled: resolve,
      })
        .then(resolve)
        .catch((error) => {
          resolve({
            ok: false,
            failureKind: "transient",
            errorCode: "runner_exception",
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
  },
  onAttentionChanged: (projectId) => {
    broadcast({ type: "attention_changed", projectId });
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
  // The narrator (track C): a verified completion wakes Darwin to debrief the
  // user. Fire-and-forget — the tick never waits on a model turn.
  onDigestReviewed: ({ projectId, workerId, digestId }) => {
    completionDebriefs.ensure({ projectId, workerId, digestId });
    void completionDebriefs.drain(projectId);
  },
  retireWorker: async (workerId, reason) => {
    const outcome = await workers.stop(workerId, reason, { intent: "force" });
    if (outcome.ok) {
      return { ok: true };
    }
    // A deploy can land after finalizeStop committed but before the durable
    // retirement row was stamped. Treat the observable stopped+retired state
    // as success; retrying stop would otherwise turn a completed fact into a
    // false refusal.
    const current = getWorkerRow(db, workerId);
    const lane = current ? getLane(db, current.lane_id) : undefined;
    if (current?.status === "stopped" && lane?.status === "retired") {
      return { ok: true };
    }
    return {
      ok: false,
      reason: outcome.reason,
      failureKind: /already being stopped/i.test(outcome.reason)
        ? "transient" as const
        : "non_retryable" as const,
    };
  },
  runTriage: async (project) => {
    const outcome = await runTriageJob({
      db,
      config,
      project,
      workers,
      broadcast: (event) => broadcast(event),
      // Track E: escalations become real cards, and an answered card wakes
      // Darwin so the answer is acted on now, not parked behind the queue.
      decisions,
      onEscalationAnswered: (answer) => {
        void wakeManagerForDecisionAnswer(project.id, answer);
      },
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
    "Cache-Control": "no-cache, no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
}

/** Direct response stream for the initiating POST; /events uses the registry. */
function sseWrite(res: http.ServerResponse, event: unknown): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(event: unknown): void {
  eventClients.broadcast(event);
}

/** Everything a turn writes to the wire: turn events plus the distill note. */
type OutboundTurnEvent =
  | ManagerTurnEvent
  | {
      type: "distilled";
      recordsWritten: number;
      committed: boolean;
      commitSkippedReason?: string;
      error?: string;
    };

/**
 * The one way turn events leave the daemon: down the initiating POST stream
 * (when there is one — autonomous turns have none) AND onto /events wrapped
 * with the projectId, folding the live snapshot along the way. Full parity on
 * the broadcast is the point of turn-attach: a tab that loads mid-turn
 * (reload, second window) re-attaches from /events instead of orphaning, and
 * the attached tab dedupes by ignoring /events turn traffic while its own
 * POST stream is live.
 */
function makeTurnEmit(
  projectId: string,
  sink?: http.ServerResponse,
): (event: OutboundTurnEvent) => void {
  return (event) => {
    if (sink) {
      sseWrite(sink, event);
    }
    const next = updateLiveSnapshot(
      liveTurnSnapshots.get(projectId) ?? EMPTY_LIVE_SNAPSHOT,
      event,
    );
    if (next === null) {
      liveTurnSnapshots.delete(projectId);
    } else {
      liveTurnSnapshots.set(projectId, next);
    }
    broadcast({ ...event, projectId });
  };
}

/** Body over the wire cap — thrown before JSON.parse ever sees the bytes. */
class BodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes.`);
  }
}

async function readBody(
  req: http.IncomingMessage,
  maxBytes?: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (maxBytes !== undefined && total > maxBytes) {
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(buffer);
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

/**
 * The formal sign-off (track C): an implementation_plan moved to "approved"
 * ends Interview mode. Persisted — a restart never resurrects the interview —
 * and broadcast so every tab's mode pill flips together. Returns whether the
 * mode actually flipped so tool replies never claim an exit that didn't
 * happen (approving a plan in Default/Auto is a plain record update).
 */
function approvePlanSignOff(projectId: string): boolean {
  if (!flipInterviewToDefault(db, projectId)) {
    return false;
  }
  broadcast({ type: "autonomy_mode", projectId, mode: "default" });
  broadcast({
    type: "manager_note",
    projectId,
    text: "Plan signed — Interview mode ends; Darwin is back in Default mode and building may begin.",
  });
  return true;
}

const COMPACTED_NOTE =
  "Darwin's context was compacted at a clean boundary — he re-briefs himself from the committed records (plus the live thread tail and worker fleet) on his next turn.";

/**
 * The proactive re-brief trigger (principle 7): when a completed turn ran its
 * context past the configured fill AND the distill pass that followed
 * COMPLETED (an aborted pass marks nothing — its records are not written, so
 * the transcript is not yet redundant), compact the session at that boundary.
 * The next turn's pre-flight composes the re-brief at use-time freshness.
 * Skipped whenever the session moved on: a live turn owns it (unless the
 * caller still holds busy itself), or it is no longer the active session.
 */
function compactAtBoundaryIfPressured(input: {
  projectId: string;
  sessionId: string;
  contextFill: number | null;
  distillRan: boolean;
  /** The autonomous turn holds busy through its own distill — its boundary is still quiet. */
  callerHoldsBusy?: boolean;
}): void {
  if (!input.distillRan || input.contextFill === null) {
    return;
  }
  if (input.contextFill < config.rebriefFillThreshold) {
    return;
  }
  if (!input.callerHoldsBusy && busyProjects.has(input.projectId)) {
    // A new turn is already running on this session — compacting under it
    // would strand its turns on a retired session. The next completed
    // boundary catches the pressure.
    return;
  }
  const active = getOrCreateActiveSession(db, input.projectId);
  if (active.id !== input.sessionId) {
    return;
  }
  compactSession(db, input.projectId, input.sessionId);
  broadcast({ type: "manager_note", projectId: input.projectId, text: COMPACTED_NOTE });
  console.log(
    `[manager] proactive compaction for ${input.projectId} at ${Math.round(input.contextFill * 100)}% context fill`,
  );
}

async function handleManagerMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req, MAX_MESSAGE_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: error.message });
      return;
    }
    throw error;
  }
  const projectId = asString(body.projectId);
  // Attachment-bearing sends may carry no prose at all (a bare screenshot);
  // a malformed attachments array rejects the send whole — a silently
  // dropped attachment would be worse than an error.
  const text = asString(body.text) ?? "";
  const attachments = parseOutgoingAttachments(body.attachments);
  if (!attachments) {
    sendJson(res, 400, { error: "Malformed attachments." });
    return;
  }
  if (!projectId || (!text && attachments.length === 0)) {
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
  const emit = makeTurnEmit(projectId, res);
  // A reload during the pre-turn distill gate must already read as working:
  // the snapshot exists from the first instant the busy flag does.
  liveTurnSnapshots.set(projectId, {
    status: { status: "thinking", label: "Thinking" },
    text: "",
  });

  try {
    // Persist the message BEFORE any wait: until 2026-07-10 it lived only in
    // this handler's memory through the distill gate, so a reload during the
    // wait lost it without a trace. Persisted-but-unanswered is honest;
    // vanished is not.
    const session = getOrCreateActiveSession(db, projectId);
    // Attachment bytes land on disk FIRST; the turn's content column carries
    // only text + relative paths, so history fetches stay light forever.
    const storedAttachments = storeAttachments(config.stateDir, projectId, attachments);
    const userTurnContent =
      storedAttachments.length > 0
        ? JSON.stringify({
            kind: "user",
            text,
            attachments: storedAttachments,
          } satisfies UserTurnPayload)
        : text;
    const userTurn = appendTurn(db, { sessionId: session.id, role: "user", content: userTurnContent });

    // The previous turn's distillation may still be running. The fork
    // invariant stands — the manager session is never forked concurrently
    // with a live turn — but the user outranks bookkeeping: abort the pending
    // fork (its turns stay unmarked; the next pass sweeps them) instead of
    // making the user wait out a 30–90s pass in silence. This was THE
    // "Darwin takes forever to respond" delay (avg 31s, max 90s measured).
    const pendingDistill = distillsInFlight.get(projectId);
    if (pendingDistill) {
      emit({
        type: "turn_status",
        status: "thinking",
        label: "Setting aside the last turn's paperwork…",
      });
      distillControllers.get(projectId)?.abort();
      await pendingDistill;
    }

    // One kill switch per phase: interrupting the turn must not also kill the
    // distill pass that follows (the user chose to keep it), but a second
    // triple-Esc during distillation aborts the fork too.
    const turnController = new AbortController();
    armController(turnController);
    // Mode is re-read AFTER the distill gate: the gate can hold for tens of
    // seconds, and a Shift+Tab in that window must bind THIS turn — the hard
    // gate is worthless if it reads a stale snapshot (review finding).
    const projectAtTurnStart = getProject(db, projectId) ?? project;
    const outcome = await runManagerTurn({
      db,
      config: effectiveConfig,
      project: projectAtTurnStart,
      userText: text,
      emit,
      abortController: turnController,
      workers,
      decisions,
      persistedUserTurn: userTurn,
      ...(storedAttachments.length > 0
        ? {
            attachments: {
              images: attachments.filter((entry) => entry.kind === "image"),
              promptNote: attachmentPromptNote(storedAttachments, config.stateDir),
            },
          }
        : {}),
      mode: projectAutonomyMode(projectAtTurnStart),
      onPlanApproved: () => approvePlanSignOff(project.id),
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
          onPlanApproved: () => approvePlanSignOff(project.id),
        });
        emit({
          type: "distilled",
          recordsWritten: distill.recordsWritten,
          committed: distill.commit.status === "committed",
          ...(distill.commit.status === "skipped"
            ? { commitSkippedReason: distill.commit.reason }
            : {}),
          ...(distill.error ? { error: distill.error } : {}),
        });
        // The completed distillation boundary — the one moment the transcript
        // is redundant by design. Compact here when the turn ran hot.
        compactAtBoundaryIfPressured({
          projectId,
          sessionId: outcome.sessionId,
          contextFill: outcome.contextFill,
          distillRan: distill.ran,
        });
      })();
      // Register the guard (swallowed copy — a distill failure must not
      // reject the next turn's wait) BEFORE releasing the busy flag, so
      // there is no instant where a new turn sees neither lock.
      const guard = distillPromise.catch(() => {});
      distillsInFlight.set(projectId, guard);
      distillControllers.set(projectId, distillController);
      releaseBusy();
      try {
        await distillPromise;
      } finally {
        if (distillsInFlight.get(projectId) === guard) {
          distillsInFlight.delete(projectId);
        }
        if (distillControllers.get(projectId) === distillController) {
          distillControllers.delete(projectId);
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Through emit, not sseWrite: a re-attached tab (no POST stream) must
    // learn the turn died too, or its composer never unlocks.
    emit({
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
    // A worker may have strayed or completed while this turn ran — handle
    // both now that Darwin is free, strays first.
    drainPendingLaneWake(projectId);
    void completionDebriefs.drain(projectId);
    drainPendingAnswerWake(projectId);
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

  await runAutonomousManagerTurn({ project, seed, noteText, logTag: "lane-guard" });
}

/**
 * One daemon-initiated manager turn: busy held throughout, live snapshot
 * armed (a reload mid-narration sees Darwin working), distill + boundary
 * compaction after, pending wakes drained on the way out. Shared by every
 * autonomous wake — the lane guard and the completion narrator.
 */
async function runAutonomousManagerTurn(input: {
  project: NonNullable<ReturnType<typeof getProject>>;
  seed: string;
  noteText: string;
  logTag: string;
  refreshTurn?: () => DebriefAttemptContext | null;
  onTurnBeginning?: (context: DebriefAttemptContext) => void;
  onTurnSettled?: (result: DebriefRunResult) => void;
}): Promise<DebriefRunResult> {
  const { project, logTag } = input;
  let seed = input.seed;
  let noteText = input.noteText;
  let actualDebriefContext: DebriefAttemptContext | null = null;
  let result: DebriefRunResult = {
    ok: false,
    failureKind: "transient",
    errorCode: "turn_incomplete",
    error: "The autonomous manager turn ended without a successful result.",
  };
  let turnCompleted = false;
  let turnError: string | null = null;
  let turnReported = false;
  const reportTurn = (outcome: DebriefRunResult) => {
    result = outcome;
    if (!turnReported) {
      turnReported = true;
      input.onTurnSettled?.(outcome);
    }
  };
  busyProjects.add(project.id);
  // Autonomous turns arm the same mid-turn surface as user turns: a tab that
  // loads while Darwin narrates sees him working, not a dead page.
  liveTurnSnapshots.set(project.id, {
    status: { status: "thinking", label: "Thinking" },
    text: "",
  });
  try {
    // Respect the fork invariant: never start a turn while the previous turn's
    // distillation fork is still running. Turn-lock decoupled distill from the
    // busy flag, so a free busy flag does not mean the session is idle.
    const pendingDistill = distillsInFlight.get(project.id);
    if (pendingDistill) {
      await pendingDistill;
    }
    const refreshed = input.refreshTurn?.();
    if (input.refreshTurn && !refreshed) {
      reportTurn({
        ok: false,
        failureKind: "non_retryable",
        errorCode: "context_missing",
        error: "The digest-bound debrief context no longer exists.",
      });
      return result;
    }
    if (refreshed) {
      seed = refreshed.seed;
      noteText = refreshed.noteText;
      actualDebriefContext = refreshed;
    }
    broadcast({ type: "manager_note", projectId: project.id, text: noteText });
    // Honor the project's manager-model override (e.g. the user switched Darwin
    // to Opus after a Fable limit) so the autonomous turn uses the live model.
    const activeManagerModel = managerModelOverrides.get(project.id) ?? config.managerModel;
    const effectiveConfig =
      activeManagerModel === config.managerModel
        ? config
        : { ...config, managerModel: activeManagerModel };
    const turnController = new AbortController();
    activeTurnControllers.set(project.id, turnController);
    // Same staleness rule as user turns: the distill gate above can hold for
    // a while, and the mode must bind at TURN start, not wake time.
    const projectAtTurnStart = getProject(db, project.id) ?? project;
    const broadcastEmit = makeTurnEmit(project.id);
    if (actualDebriefContext) {
      input.onTurnBeginning?.(actualDebriefContext);
    }
    const autonomousSession = getOrCreateActiveSession(db, project.id);
    const inputKind = logTag.startsWith("lane-guard")
      ? "lane_guard"
      : logTag.startsWith("narrator:")
        ? "completion_debrief"
        : logTag === "triage-answer"
          ? "answer_pickup"
          : "autonomous";
    const syntheticTurn = appendTurn(db, {
      sessionId: autonomousSession.id,
      role: "system",
      content: JSON.stringify({ kind: "synthetic_input", inputKind, text: seed }),
      inputOrigin: "daemon",
      inputKind,
    });
    const outcome = await runManagerTurn({
      db,
      config: effectiveConfig,
      project: projectAtTurnStart,
      userText: seed,
      persistedUserTurn: syntheticTurn,
      // Autonomous turns have no chat stream — the /events broadcast is the
      // ONLY path anything (decision cards, live status, prose) reaches the
      // user. Full parity with user turns via the shared emit.
      emit: (event) => {
        if (event.type === "turn_error") {
          turnError = event.message;
        }
        broadcastEmit(event);
      },
      abortController: turnController,
      workers,
      decisions,
      mode: projectAutonomyMode(projectAtTurnStart),
      onPlanApproved: () => approvePlanSignOff(project.id),
    });
    turnCompleted = outcome.completed;
    if (outcome.completed) {
      reportTurn({ ok: true });
    } else if (outcome.interrupted) {
      reportTurn({
        ok: false,
        failureKind: "non_retryable",
        errorCode: "user_interrupted",
        error: "The autonomous debrief was interrupted by the user.",
      });
    } else {
      const error = turnError ?? "The manager turn returned without completing.";
      reportTurn(classifyAutonomousFailure(error));
    }
    if (outcome.completed || outcome.interrupted) {
      const distillController = new AbortController();
      activeTurnControllers.set(project.id, distillController);
      const distill = await runDistillJob({
        db,
        config,
        project,
        sessionId: outcome.sessionId,
        sdkSessionId: outcome.sdkSessionId,
        abortController: distillController,
        onPlanApproved: () => approvePlanSignOff(project.id),
      });
      // Autonomous turns hit the same completed-distill boundary; busy is
      // still ours here, so the session is provably quiet.
      compactAtBoundaryIfPressured({
        projectId: project.id,
        sessionId: outcome.sessionId,
        contextFill: outcome.contextFill,
        distillRan: distill.ran,
        callerHoldsBusy: true,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${logTag}] autonomous manager turn failed for ${project.slug}: ${message}`);
    // Once turn_complete was emitted, the user received the debrief. A later
    // distillation failure is bookkeeping debt, not narration failure.
    reportTurn(turnCompleted ? { ok: true } : classifyAutonomousFailure(message));
  } finally {
    activeTurnControllers.delete(project.id);
    busyProjects.delete(project.id);
    // No user POST turn can own this project's snapshot while autonomous busy
    // was held, so dropping it here can never clobber a successor's.
    liveTurnSnapshots.delete(project.id);
    // A worker may have strayed or completed during this turn — handle both,
    // strays first (a frozen worker is bleeding urgency; a debrief keeps).
    drainPendingLaneWake(project.id);
    void completionDebriefs.drain(project.id);
    drainPendingAnswerWake(project.id);
  }
  reportTurn(result);
  return result;
}

function classifyAutonomousFailure(message: string): DebriefRunResult {
  if (/not logged in|credential|keychain|authentication/i.test(message)) {
    return { ok: false, failureKind: "non_retryable", errorCode: "auth", error: message };
  }
  if (isUsageLimitError(message)) {
    return { ok: false, failureKind: "transient", errorCode: "usage_limit", error: message };
  }
  if (/timeout|timed out/i.test(message)) {
    return { ok: false, failureKind: "transient", errorCode: "timeout", error: message };
  }
  return { ok: false, failureKind: "transient", errorCode: "turn_error", error: message };
}

/** Wake Darwin for a stray that queued while the project was busy, if any. */
function drainPendingLaneWake(projectId: string): void {
  const pending = pendingLaneWakes.get(projectId);
  if (pending) {
    pendingLaneWakes.delete(projectId);
    void wakeManagerForLaneViolation(pending);
  }
}

/**
 * The answer pickup (track E): the user answered a triage card. Wake Darwin
 * with the question AND the answer so he acts on it now — steering, records,
 * acknowledgment — instead of the answer waiting for the user's next message.
 * Same busy discipline as every wake: mid-turn answers queue and drain.
 */
async function wakeManagerForDecisionAnswer(
  projectId: string,
  answer: { question: string; outcomeText: string; attentionId: string },
): Promise<void> {
  const project = getProject(db, projectId);
  if (!project) {
    return;
  }
  if (busyProjects.has(project.id)) {
    const queue = pendingAnswerWakes.get(project.id) ?? [];
    queue.push(answer);
    pendingAnswerWakes.set(project.id, queue);
    return;
  }
  const noteText = "The user answered triage's question — Darwin is picking it up.";
  const seed =
    `SYSTEM — escalated question answered.\n\n` +
    `While you were between turns, triage asked the user:\n${answer.question}\n\n` +
    `The user's answer:\n${answer.outcomeText}\n\n` +
    `The backing attention item (${answer.attentionId}) is still OPEN and now carries this answer. Act on it now — steer or hold workers as it directs, record the durable outcome (user_answer or update_record where it belongs) — then resolve_attention ${answer.attentionId} with what you did, and acknowledge the answer to the user in your reply, answer-first.`;
  await runAutonomousManagerTurn({ project, seed, noteText, logTag: "triage-answer" });
}

/** Pick up the oldest card answer that landed while the project was busy. */
function drainPendingAnswerWake(projectId: string): void {
  const queue = pendingAnswerWakes.get(projectId);
  const next = queue?.shift();
  if (queue && queue.length === 0) {
    pendingAnswerWakes.delete(projectId);
  }
  if (next) {
    void wakeManagerForDecisionAnswer(projectId, next);
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
/**
 * The manual mirror of the boundary trigger: the user asks for a fresh,
 * records-seeded context NOW. Route-only, like clear-rebrief — Darwin never
 * calls this; the compaction happens between turns and the next turn's
 * pre-flight composes the re-brief.
 */
async function handleRebriefNow(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const projectId = asString(body.projectId);
  if (!projectId) {
    sendJson(res, 400, { error: "projectId is required." });
    return;
  }
  const project = getProject(db, projectId);
  if (!project) {
    sendJson(res, 404, { error: `Unknown project: ${projectId}` });
    return;
  }
  if (busyProjects.has(projectId)) {
    sendJson(res, 409, { error: "Darwin is mid-turn — wait for it to finish before re-briefing." });
    return;
  }
  const session = getOrCreateActiveSession(db, projectId);
  const hasConversation = listTurns(db, session.id).some((turn) => turn.role !== "system");
  if (!hasConversation && session.seeded_from_records_at) {
    // Already a virgin records-seeded session: compacting again would just
    // churn rows for an identical outcome.
    sendJson(res, 200, {
      compacted: false,
      note: "Darwin's context is already fresh — the next turn re-briefs from records.",
    });
    return;
  }
  compactSession(db, projectId, session.id);
  broadcast({ type: "manager_note", projectId, text: COMPACTED_NOTE });
  sendJson(res, 200, { compacted: true });
}

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

// The diff patch is capped so one runaway worktree cannot flood the wire;
// the truncation is announced, never silent.
const WORKER_DIFF_CAP = 200_000;

/**
 * The work itself, on demand (track F): commits since the lane base, the
 * unified diff, and the check evidence beside it — freshness computed against
 * the worktree's LIVE key, because a passing run against a stale key is not a
 * green check. Read-only git in the worktree the daemon owns.
 */
async function handleWorkerChanges(res: http.ServerResponse, workerId: string): Promise<void> {
  const worker = getWorkerRow(db, workerId);
  if (!worker) {
    sendJson(res, 404, { error: `No worker with id ${workerId}.` });
    return;
  }
  if (!existsSync(worker.worktree_path)) {
    sendJson(res, 200, {
      gone: true,
      commits: [],
      diff: "",
      diffTruncated: false,
      dirtyFiles: [],
      checks: [],
    });
    return;
  }
  const lane = getLane(db, worker.lane_id);
  const baseSha = lane?.base_sha ?? null;
  const runner = new LocalGitCommandRunner();

  let commits: { sha: string; subject: string }[] = [];
  let diff = "";
  let diffTruncated = false;
  let dirtyFiles: string[] = [];
  if (baseSha) {
    const [logOutput, porcelainOutput] = await Promise.all([
      runner.runGit(
        ["log", "--no-decorate", "--format=%h%x00%s", `${baseSha}..HEAD`],
        worker.worktree_path,
      ),
      runner.runGit(["status", "--porcelain=v1", "-z", "-uall"], worker.worktree_path),
    ]);
    commits = parseCommitLog(logOutput);
    const status = parseStatusPorcelain(porcelainOutput);
    dirtyFiles = [...status.stagedFiles, ...status.dirtyFiles, ...status.untrackedFiles]
      .map((entry) => entry.path)
      .filter(Boolean);
    try {
      diff = await runner.runGit(["diff", `${baseSha}...HEAD`], worker.worktree_path);
    } catch {
      // A patch past the runner's read buffer (~10MB) rejects outright —
      // degrade to the diffstat instead of failing the whole card. Announced,
      // never silent.
      const stat = await runner
        .runGit(["diff", "--stat", `${baseSha}...HEAD`], worker.worktree_path)
        .catch(() => "(the diff could not be read)");
      diff = `(patch too large to render — file summary instead)\n\n${stat}`;
      diffTruncated = true;
    }
    if (diff.length > WORKER_DIFF_CAP) {
      diff = `${diff.slice(0, WORKER_DIFF_CAP)}\n… (diff truncated at ${WORKER_DIFF_CAP.toLocaleString()} chars — the worktree holds the real content)`;
      diffTruncated = true;
    }
  }

  // Check evidence with honest freshness: latest run per key, compared to the
  // workspace's key RIGHT NOW — a passing run against a stale key is not a
  // green check.
  const workspace = await observeWorkspaceEvidence(worker.worktree_path);
  const latest = latestRunsByKey(db, { projectId: worker.project_id, workerId: worker.id });
  const checks = checkViewsFrom(CHECK_KEYS, latest, workspace.available ? workspace.key : null);

  sendJson(res, 200, {
    gone: false,
    commits,
    diff,
    diffTruncated,
    dirtyFiles,
    checks,
    workspaceEvidence: {
      available: workspace.available,
      reason: workspace.reason,
      usage: workspace.usage,
      limits: workspace.limits,
    },
  });
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

async function handleRearmCompletionDebrief(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const attentionId = asString(body.attentionId);
  if (!attentionId) {
    sendJson(res, 400, { error: "attentionId is required." });
    return;
  }
  const rearmed = completionDebriefs.rearmByAttention(attentionId);
  if (!rearmed) {
    sendJson(res, 409, { error: "That debrief is not in a re-armable failed state." });
    return;
  }
  sendJson(res, 200, { ok: true, digestId: rearmed.digest_id });
  void completionDebriefs.drain(rearmed.project_id);
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
  if (route === "POST /manager/mode") {
    // The Shift+Tab axis lands here: validate, persist, broadcast — every
    // tab's pill flips together, and the NEXT turn runs under the new mode
    // (doctrine + allowlist are rebuilt per turn).
    void (async () => {
      const body = await readBody(req);
      const projectId = asString(body.projectId);
      const mode = asString(body.mode);
      if (!projectId || !isAutonomyMode(mode)) {
        sendJson(res, 400, {
          error: `projectId and a valid mode (${AUTONOMY_MODES.join(" | ")}) are required.`,
        });
        return;
      }
      if (!getProject(db, projectId)) {
        sendJson(res, 404, { error: `Unknown project: ${projectId}` });
        return;
      }
      setProjectAutonomyMode(db, projectId, mode);
      broadcast({ type: "autonomy_mode", projectId, mode });
      sendJson(res, 200, { ok: true, mode });
    })().catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if (route === "POST /manager/rebrief/now") {
    void handleRebriefNow(req, res).catch((error) => {
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
  if (route === "POST /completion-debriefs/rearm") {
    void handleRearmCompletionDebrief(req, res).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if (route === "GET /manager/live") {
    // What a client loading MID-TURN needs to re-attach: the busy flag and
    // the live tail its POST-less page never streamed. Snapshot only served
    // while busy, so a stale entry is never rendered as a ghost turn.
    const projectId = url.searchParams.get("projectId");
    if (!projectId) {
      sendJson(res, 400, { error: "projectId is required." });
      return;
    }
    const busy = busyProjects.has(projectId);
    const snapshot = busy ? liveTurnSnapshots.get(projectId) ?? EMPTY_LIVE_SNAPSHOT : EMPTY_LIVE_SNAPSHOT;
    sendJson(res, 200, { busy, status: snapshot.status, text: snapshot.text });
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
  const workerChanges = /^\/workers\/([^/]+)\/changes$/.exec(url.pathname);
  if (req.method === "GET" && workerChanges?.[1]) {
    void handleWorkerChanges(res, workerChanges[1]).catch((error) => {
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
    const removeClient = eventClients.add(res);
    req.on("close", removeClient);
    req.on("error", removeClient);
    res.on("close", removeClient);
    res.on("error", removeClient);
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
    const { reattached, finalized } = await workers.reconcileOrphans();
    if (reattached > 0) {
      console.log(
        `[workers] re-attached ${reattached} live worker${reattached === 1 ? "" : "s"} after restart (sessions resumed in place)`,
      );
    }
    if (finalized > 0) {
      console.log(`[workers] reconciled ${finalized} orphaned worker${finalized === 1 ? "" : "s"} after restart`);
    }
  } catch (error) {
    console.error(
      `[workers] orphan reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const recoveredDebriefs = completionDebriefs.recover();
  if (recoveredDebriefs.length > 0) {
    console.log(
      `[narrator] recovered ${recoveredDebriefs.length} interrupted debrief attempt${recoveredDebriefs.length === 1 ? "" : "s"}`,
    );
  }
  for (const project of listProjects(db)) {
    void completionDebriefs.drain(project.id);
  }
  // Durable due_at owns retry timing; this poll only wakes due work. Busy
  // projects remain untouched and consume no attempt until runManagerTurn
  // actually begins.
  setInterval(() => {
    for (const project of listProjects(db)) {
      void completionDebriefs.drain(project.id);
    }
  }, 5_000).unref();

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
