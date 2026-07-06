// I/O for the watchdog leg: pull the worker's full persisted transcript
// from worker_events (it was stored for exactly this), render it, run the
// single-shot review on GALAPAGOS_WATCHDOG_MODEL, and persist the verdict
// as a jobs row (kind "watchdog") keyed to the workspace evidence state —
// a verdict that predates new work proves nothing about it.
import type { GalapagosConfig } from "../../config";
import { oneLine } from "../../core/text";
import {
  buildWatchdogPrompt,
  parseWatchdogVerdict,
  WATCHDOG_SYSTEM_PROMPT,
  type TranscriptEvent,
} from "../../core/legs/watchdog";
import type { GalapagosDb } from "../db/db";
import { createJob, failJob, finishJob, startJob } from "../db/repos/jobs";
import { laneGlobs, type LaneRow } from "../db/repos/lanes";
import { listWorkerEvents, type WorkerRow } from "../db/repos/workers";
import { observeWorkspaceEvidence } from "../evidence/workspace";
import { runSingleShotReview } from "./session";

/** Payload/result shape of a jobs row written by this leg. */
export type WatchdogJobResult = {
  verdict: "clean" | "suspicious" | "gaming";
  summary: string;
  evidence: string[];
  evidenceKey: string;
  /** How many transcript events the verdict covered — new events stale it. */
  eventCount: number;
  digestId: string;
  workerId: string;
};

function renderEventText(kind: string, payload: Record<string, unknown>): string {
  if (typeof payload.text === "string") {
    return payload.text;
  }
  if (typeof payload.tool === "string") {
    return `${payload.tool} ${oneLine(JSON.stringify(payload.input ?? {}), 600)}`;
  }
  if (typeof payload.content === "string") {
    return `${payload.isError === true ? "(error) " : ""}${oneLine(payload.content, 800)}`;
  }
  if (typeof payload.resultText === "string") {
    return payload.resultText;
  }
  if (typeof payload.message === "string") {
    return payload.message;
  }
  return oneLine(JSON.stringify(payload), 400);
}

export async function runWatchdogReview(input: {
  db: GalapagosDb;
  config: GalapagosConfig;
  worker: WorkerRow;
  lane: LaneRow | null;
  digestId: string;
}): Promise<{ ran: boolean; error: string | null }> {
  const { db, config, worker } = input;
  // The state being judged goes in the PAYLOAD, before the run — so even a
  // FAILED run records what it failed against, and the evidence adapter can
  // re-arm the leg when that state moves (coverage audit 2026-07-05: a
  // transient failure must not pin the leg at "unavailable" forever).
  let payloadKey = "unobservable";
  try {
    payloadKey = (await observeWorkspaceEvidence(worker.worktree_path)).key;
  } catch {
    // Key stays "unobservable"; the run below will fail loudly on its own.
  }
  const job = createJob(db, "watchdog", {
    workerId: worker.id,
    digestId: input.digestId,
    projectId: worker.project_id,
    evidenceKey: payloadKey,
  });
  startJob(db, job.id);

  try {
    const events: TranscriptEvent[] = listWorkerEvents(db, worker.id).map((event) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(event.payload) as Record<string, unknown>;
      } catch {
        // Raw payload stays visible rather than silently vanishing.
        payload = { text: event.payload };
      }
      return {
        kind: event.kind,
        text: renderEventText(event.kind, payload),
        createdAt: event.created_at,
      };
    });

    const workspace = await observeWorkspaceEvidence(worker.worktree_path);
    const globs = input.lane ? laneGlobs(input.lane) : { allowedGlobs: [], forbiddenGlobs: [] };
    const prompt = buildWatchdogPrompt({
      laneName: input.lane?.name ?? worker.id.slice(0, 8),
      allowedGlobs: globs.allowedGlobs,
      events,
    });

    const response = await runSingleShotReview({
      config,
      cwd: worker.worktree_path,
      model: config.watchdogModel,
      systemPrompt: WATCHDOG_SYSTEM_PROMPT,
      prompt,
    });
    if (!response.ok) {
      failJob(db, job.id, response.reason);
      return { ran: false, error: response.reason };
    }
    const parsed = parseWatchdogVerdict(response.text);
    if (!parsed.ok) {
      failJob(db, job.id, parsed.problem);
      return { ran: false, error: parsed.problem };
    }
    const result: WatchdogJobResult = {
      ...parsed.verdict,
      evidenceKey: workspace.key,
      eventCount: events.length,
      digestId: input.digestId,
      workerId: worker.id,
    };
    finishJob(db, job.id, result);
    return { ran: true, error: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failJob(db, job.id, reason);
    return { ran: false, error: reason };
  }
}
