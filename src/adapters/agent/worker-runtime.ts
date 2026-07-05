// Daemon-side worker orchestration. One runtime instance owns the live
// session handles (the only in-memory piece — everything durable lands in
// SQLite as it happens): spawn = lane row + worktree + brief record + session,
// steer = streaming-input injection, stop = end session + detective lane
// audit + completion check. The harness itself is behind worker-session.ts.
import type { GalapagosConfig } from "../../config";
import { checkLane, findLaneOverlap, type LaneContract } from "../../core/lanes/lane-check";
import { parseCompletionReport } from "../../core/digests/completion";
import type { GalapagosDb } from "../db/db";
import {
  createLane,
  getLane,
  laneGlobs,
  listActiveLanes,
  retireLane,
  type LaneRow,
} from "../db/repos/lanes";
import {
  appendWorkerEvent,
  createWorker,
  getWorker,
  listLiveStatusWorkers,
  listWorkerEvents,
  listWorkers,
  setWorkerSdkSessionId,
  setWorkerStatus,
  touchWorker,
  type WorkerEventRow,
  type WorkerRow,
  type WorkerStatus,
} from "../db/repos/workers";
import {
  createCompletionDigest,
  latestDigestForWorker,
  type CompletionDigestRow,
} from "../db/repos/digests";
import {
  createAttentionItem,
  listWorkerAttentionItems,
  type AttentionItemRow,
} from "../db/repos/attention";
import type { ProjectRow } from "../db/repos/projects";
import { slugify } from "../db/repos/projects";
import { addWorktree, removeWorktree, workerWorktreePath } from "../git/mutating-runner";
import { commitRecords } from "../git/mutating-runner";
import { LocalGitCommandRunner } from "../git/runner";
import { createRecordsStore } from "../records/store";
import { buildWorkerDoctrine } from "../../daemon/worker-doctrine";
import {
  spawnWorkerSession,
  type WorkerSession,
  type WorkerSessionFactory,
} from "./worker-session";

export type WorkerBroadcast =
  | {
      type: "worker_event";
      projectId: string;
      workerId: string;
      event: { id: string; kind: string; payload: unknown; createdAt: string };
    }
  | {
      type: "worker_status";
      projectId: string;
      workerId: string;
      status: WorkerStatus;
      lastSummary: string | null;
    };

export type SpawnWorkerInput = {
  project: ProjectRow;
  laneName: string;
  allowedGlobs: string[];
  forbiddenGlobs?: string[];
  briefTitle: string;
  brief: string;
  model?: string;
};

export type SpawnWorkerOutcome =
  | {
      ok: true;
      workerId: string;
      laneSlug: string;
      branch: string;
      worktreePath: string;
      baseSha: string;
      briefRecordId: string;
      briefCommitNote: string | null;
    }
  | { ok: false; reason: string };

export type StopWorkerOutcome =
  | {
      ok: true;
      status: WorkerStatus;
      violations: { path: string; reason: string }[];
      hasDigest: boolean;
      auditError: string | null;
    }
  | { ok: false; reason: string };

export type WorkerStatusView = {
  worker: WorkerRow;
  lane: LaneRow | null;
  events: WorkerEventRow[];
  digest: CompletionDigestRow | null;
  attention: AttentionItemRow[];
};

type LiveEntry = {
  session: WorkerSession;
  loopDone: Promise<void>;
  stopRequested: boolean;
};

function oneLine(value: string, max = 200): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * The detective audit's file set (architecture §7): committed changes since
 * the lane's base sha ∪ porcelain modified/untracked in the worktree.
 */
export async function collectAuditFiles(worktreePath: string, baseSha: string): Promise<string[]> {
  const runner = new LocalGitCommandRunner();
  const [diffOutput, porcelainOutput] = await Promise.all([
    runner.runGit(["diff", "--name-only", `${baseSha}...HEAD`], worktreePath),
    // -uall lists untracked FILES: the default collapses a new directory to
    // "dir/", which globs can neither honestly clear nor blame.
    runner.runGit(["status", "--porcelain", "-uall"], worktreePath),
  ]);

  const files = new Set<string>();
  for (const line of diffOutput.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) {
      files.add(trimmed);
    }
  }
  for (const line of porcelainOutput.split("\n")) {
    if (line.length < 4) {
      continue;
    }
    // "XY path" or "XY old -> new" for renames — audit the new path.
    let filePath = line.slice(3);
    const arrow = filePath.indexOf(" -> ");
    if (arrow !== -1) {
      filePath = filePath.slice(arrow + 4);
    }
    filePath = filePath.trim().replace(/^"|"$/g, "");
    if (filePath) {
      files.add(filePath);
    }
  }
  return Array.from(files);
}

export type WorkerRuntime = ReturnType<typeof createWorkerRuntime>;

export function createWorkerRuntime(deps: {
  db: GalapagosDb;
  config: GalapagosConfig;
  sessionFactory?: WorkerSessionFactory;
  broadcast?: (event: WorkerBroadcast) => void;
}) {
  const { db, config } = deps;
  const sessionFactory = deps.sessionFactory ?? spawnWorkerSession;
  const live = new Map<string, LiveEntry>();

  const broadcastStatus = (worker: { id: string; project_id: string }) => {
    const row = getWorker(db, worker.id);
    if (row) {
      deps.broadcast?.({
        type: "worker_status",
        projectId: row.project_id,
        workerId: row.id,
        status: row.status,
        lastSummary: row.last_summary,
      });
    }
  };

  const persistEvent = (
    worker: { id: string; project_id: string },
    kind: WorkerEventRow["kind"],
    payload: unknown,
    summary?: string,
  ) => {
    const row = appendWorkerEvent(db, { workerId: worker.id, kind, payload });
    touchWorker(db, worker.id, summary);
    deps.broadcast?.({
      type: "worker_event",
      projectId: worker.project_id,
      workerId: worker.id,
      event: { id: row.id, kind: row.kind, payload, createdAt: row.created_at },
    });
    return row;
  };

  const setStatus = (worker: { id: string; project_id: string }, status: WorkerStatus) => {
    setWorkerStatus(db, worker.id, status);
    broadcastStatus(worker);
  };

  /**
   * Handle one successful result: parse the completion contract. A valid
   * report becomes a digest; a malformed block is an immediate attention item
   * (the worker claimed completion and botched the format); NO block is
   * ordinary mid-task conversation — the at-stop check owns that case.
   */
  const handleSuccessResult = (worker: WorkerRow, resultText: string) => {
    const parsed = parseCompletionReport(resultText);
    if (parsed.status === "parsed") {
      createCompletionDigest(db, {
        workerId: worker.id,
        narrative: parsed.report.narrative,
        beforeAfter: parsed.report.before_after,
        claims: parsed.report.claims,
        touchedAreas: parsed.report.touched_areas,
      });
      touchWorker(db, worker.id, oneLine(parsed.report.narrative));
    } else if (parsed.status === "malformed") {
      createAttentionItem(db, {
        projectId: worker.project_id,
        workerId: worker.id,
        kind: "unstructured_completion",
        title: "Worker completion report is malformed",
        detail: parsed.problems.join("\n"),
      });
    }
  };

  const consumeSession = async (workerId: string, session: WorkerSession): Promise<void> => {
    // Runs unawaited in the background: it must never reject, or the daemon
    // dies on an unhandled rejection. Failures are persisted, not thrown.
    try {
      await consumeSessionInner(workerId, session);
    } catch (error) {
      try {
        const worker = getWorker(db, workerId);
        if (worker) {
          persistEvent(worker, "error", {
            message: `Worker event loop crashed: ${error instanceof Error ? error.message : String(error)}`,
          });
          setStatus(worker, "failed");
        }
      } catch {
        console.error(`[workers] event loop for ${workerId} crashed and could not be recorded`);
      }
    } finally {
      live.delete(workerId);
    }
  };

  const consumeSessionInner = async (workerId: string, session: WorkerSession): Promise<void> => {
    let failed = false;
    for await (const event of session.events) {
      const worker = getWorker(db, workerId);
      if (!worker) {
        break;
      }
      switch (event.kind) {
        case "session_started":
          setWorkerSdkSessionId(db, workerId, event.sdkSessionId);
          setStatus(worker, "running");
          break;
        case "assistant":
          persistEvent(worker, "assistant", event.payload, oneLine(event.payload.text));
          break;
        case "tool_use":
          persistEvent(worker, "tool_use", event.payload);
          break;
        case "tool_result":
          persistEvent(worker, "tool_result", {
            content: oneLine(event.payload.content, 4000),
            isError: event.payload.isError,
          });
          break;
        case "result":
          persistEvent(worker, "result", event.payload);
          if (event.payload.isError) {
            // Auth/model/max-turn failure: the session cannot continue. Never
            // retried on a fresh session (chunk 2 rule, same for workers).
            failed = true;
            setStatus(worker, "failed");
          } else {
            if (event.payload.resultText !== null) {
              handleSuccessResult(worker, event.payload.resultText);
            }
            setStatus(worker, "idle");
          }
          break;
        case "error": {
          const entry = live.get(workerId);
          if (entry?.stopRequested) {
            // Interrupting an in-flight turn surfaces as a stream error —
            // expected during stop, not a worker failure.
            break;
          }
          persistEvent(worker, "error", event.payload);
          failed = true;
          setStatus(worker, "failed");
          break;
        }
      }
    }

    const worker = getWorker(db, workerId);
    const entry = live.get(workerId);
    if (worker && !failed && !entry?.stopRequested && worker.status !== "failed") {
      // The stream ended without a stop request: the session process died.
      persistEvent(worker, "error", {
        message: "Worker session ended unexpectedly — its process exited.",
      });
      setStatus(worker, "failed");
    }
  };

  /**
   * The at-stop safety pass: detective lane audit over the worktree, the
   * has-a-digest check, lane retirement. Runs for live stops and for boot
   * reconciliation alike. Never silently skipped — an audit that cannot run
   * becomes an attention item.
   */
  const finalizeStop = async (worker: WorkerRow): Promise<StopWorkerOutcome> => {
    const lane = getLane(db, worker.lane_id);
    const violations: { path: string; reason: string }[] = [];
    let auditError: string | null = null;

    if (lane) {
      const contract: LaneContract = laneGlobs(lane);
      try {
        const files = await collectAuditFiles(worker.worktree_path, lane.base_sha);
        for (const violation of checkLane(files, contract)) {
          violations.push({ path: violation.path, reason: violation.reason });
        }
        if (violations.length > 0) {
          createAttentionItem(db, {
            projectId: worker.project_id,
            workerId: worker.id,
            kind: "lane_violation",
            title: `Out-of-lane changes in lane "${lane.name}"`,
            detail: violations.map((entry) => `${entry.path} (${entry.reason})`).join("\n"),
            priority: "high",
          });
        }
      } catch (error) {
        auditError = error instanceof Error ? error.message : String(error);
        createAttentionItem(db, {
          projectId: worker.project_id,
          workerId: worker.id,
          kind: "check_failed",
          title: "Lane audit could not run at worker stop",
          detail: auditError,
          priority: "high",
        });
      }
      retireLane(db, lane.id);
    }

    const digest = latestDigestForWorker(db, worker.id);
    if (!digest) {
      createAttentionItem(db, {
        projectId: worker.project_id,
        workerId: worker.id,
        kind: "unstructured_completion",
        title: "Worker stopped without a structured completion report",
        detail:
          "No galapagos-completion block was ever parsed from this worker's results — it is not rendered as done. Review its event stream and worktree directly.",
      });
    }

    // A worker that already failed stays failed; stopping is not recovery.
    const current = getWorker(db, worker.id);
    const status: WorkerStatus = current?.status === "failed" ? "failed" : "stopped";
    setStatus(worker, status);
    return { ok: true, status, violations, hasDigest: digest !== undefined, auditError };
  };

  return {
    async spawn(input: SpawnWorkerInput): Promise<SpawnWorkerOutcome> {
      const { project } = input;
      const laneName = input.laneName.trim();
      if (!laneName) {
        return { ok: false, reason: "A lane needs a non-empty name." };
      }
      const allowedGlobs = (input.allowedGlobs ?? []).map((glob) => glob.trim()).filter(Boolean);
      if (allowedGlobs.length === 0) {
        return {
          ok: false,
          reason: "A lane needs at least one allowed glob — no worker runs without a lane contract.",
        };
      }
      const forbiddenGlobs = (input.forbiddenGlobs ?? []).map((glob) => glob.trim()).filter(Boolean);
      if (!input.briefTitle.trim() || !input.brief.trim()) {
        return { ok: false, reason: "A worker brief needs a title and a body." };
      }

      const laneSlug = slugify(laneName);
      for (const active of listActiveLanes(db, project.id)) {
        if (active.slug === laneSlug) {
          return {
            ok: false,
            reason: `An active lane is already named "${active.name}" — stop its worker first or pick a different name.`,
          };
        }
        const overlap = findLaneOverlap(allowedGlobs, laneGlobs(active).allowedGlobs);
        if (overlap) {
          return {
            ok: false,
            reason: `Lane rejected: allowed glob "${overlap.candidateGlob}" overlaps "${overlap.existingGlob}" of active lane "${active.name}". Lanes are exclusive — no two workers may touch the same files. Narrow the globs or stop that worker first.`,
          };
        }
      }

      let baseSha: string;
      try {
        const runner = new LocalGitCommandRunner();
        baseSha = (await runner.runGit(["rev-parse", "--verify", "HEAD"], project.root_path)).trim();
      } catch (error) {
        return {
          ok: false,
          reason: `Could not resolve the project HEAD to base the lane on: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const lane = createLane(db, {
        projectId: project.id,
        name: laneName,
        slug: laneSlug,
        allowedGlobs,
        forbiddenGlobs,
        baseSha,
      });
      const worktreePath = workerWorktreePath(config.stateDir, project.slug, laneSlug);
      const branch = `galapagos/worker/${laneSlug}`;
      const worker = createWorker(db, {
        projectId: project.id,
        laneId: lane.id,
        worktreePath,
        branch,
      });

      const abort = (reason: string): SpawnWorkerOutcome => {
        persistEvent(worker, "error", { message: reason });
        retireLane(db, lane.id);
        setStatus(worker, "failed");
        return { ok: false, reason };
      };

      const worktree = await addWorktree({
        projectRoot: project.root_path,
        worktreePath,
        branch,
        baseSha,
        stateDir: config.stateDir,
      });
      if (worktree.status !== "created") {
        return abort(
          worktree.status === "failed" ? worktree.reason : "Worktree creation failed.",
        );
      }

      // The worker_brief record echoes the lane contract (architecture §7)
      // and commits to the target repo's history like every record.
      let briefRecordId: string;
      let briefCommitNote: string | null = null;
      try {
        const store = createRecordsStore(project.root_path, project.slug);
        const record = store.create({
          type: "worker_brief",
          title: input.briefTitle,
          body: input.brief,
          extra: {
            lane_name: laneName,
            allowed_globs: allowedGlobs,
            forbidden_globs: forbiddenGlobs,
            base_sha: baseSha,
            branch,
          },
        });
        briefRecordId = record.id;
        db.prepare("UPDATE workers SET brief_record_id = ? WHERE id = ?").run(record.id, worker.id);
        const commit = await commitRecords(
          project.root_path,
          `galapagos(records): worker brief for lane ${laneSlug}`,
        );
        if (commit.status === "skipped") {
          briefCommitNote = `Brief record written but its commit was skipped: ${commit.reason}. It will land with the next records commit.`;
        }
      } catch (error) {
        await removeWorktree({ projectRoot: project.root_path, worktreePath, stateDir: config.stateDir });
        return abort(
          `Writing the worker_brief record failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      let session: WorkerSession;
      try {
        session = sessionFactory({
          config,
          worktreePath,
          systemPrompt: buildWorkerDoctrine({
            projectName: project.name,
            laneName,
            allowedGlobs,
            forbiddenGlobs,
            baseSha,
            branch,
            worktreePath,
          }),
          briefText: input.brief,
          model: input.model?.trim() || config.workerModel,
          lane: { allowedGlobs, forbiddenGlobs },
        });
      } catch (error) {
        return abort(
          `Spawning the worker session failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const loopDone = consumeSession(worker.id, session);
      live.set(worker.id, { session, loopDone, stopRequested: false });

      return {
        ok: true,
        workerId: worker.id,
        laneSlug,
        branch,
        worktreePath,
        baseSha,
        briefRecordId,
        briefCommitNote,
      };
    },

    steer(workerId: string, message: string): { ok: true } | { ok: false; reason: string } {
      const worker = getWorker(db, workerId);
      if (!worker) {
        return { ok: false, reason: `No worker with id ${workerId}.` };
      }
      const entry = live.get(workerId);
      if (!entry) {
        return {
          ok: false,
          reason: `Worker ${workerId} is ${worker.status} and has no live session to steer.`,
        };
      }
      if (!message.trim()) {
        return { ok: false, reason: "A steering message cannot be empty." };
      }
      try {
        entry.session.send(message);
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      persistEvent(worker, "steer", { text: message });
      setStatus(worker, "running");
      return { ok: true };
    },

    async stop(workerId: string): Promise<StopWorkerOutcome> {
      const worker = getWorker(db, workerId);
      if (!worker) {
        return { ok: false, reason: `No worker with id ${workerId}.` };
      }
      if (worker.status === "stopped") {
        return { ok: false, reason: `Worker ${workerId} is already stopped.` };
      }
      const entry = live.get(workerId);
      if (entry) {
        entry.stopRequested = true;
        await entry.session.stop();
        await entry.loopDone;
      }
      return finalizeStop(worker);
    },

    list(projectId: string): { worker: WorkerRow; lane: LaneRow | null }[] {
      return listWorkers(db, projectId).map((worker) => ({
        worker,
        lane: getLane(db, worker.lane_id) ?? null,
      }));
    },

    status(workerId: string): WorkerStatusView | null {
      const worker = getWorker(db, workerId);
      if (!worker) {
        return null;
      }
      return {
        worker,
        lane: getLane(db, worker.lane_id) ?? null,
        events: listWorkerEvents(db, workerId),
        digest: latestDigestForWorker(db, workerId) ?? null,
        attention: listWorkerAttentionItems(db, workerId),
      };
    },

    /**
     * Boot reconciliation: rows whose status implies a live session after a
     * daemon restart are orphans — their sessions died with the old process.
     * Mark them honestly and run the same at-stop safety pass (their
     * worktrees still hold the work).
     */
    async reconcileOrphans(): Promise<number> {
      const orphans = listLiveStatusWorkers(db);
      for (const worker of orphans) {
        persistEvent(worker, "error", {
          message:
            "Daemon restarted — the live worker session was lost. Work up to this point remains in the worktree.",
        });
        await finalizeStop(worker);
      }
      return orphans.length;
    },
  };
}
