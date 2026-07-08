// Daemon-side worker orchestration. One runtime instance owns the live
// session handles (the only in-memory piece — everything durable lands in
// SQLite as it happens): spawn = lane row + worktree + brief record + session,
// steer = streaming-input injection, stop = end session + detective lane
// audit + completion check. The harness itself is behind worker-session.ts.
import { existsSync } from "node:fs";
import type { GalapagosConfig } from "../../config";
import { checkLane, findLaneOverlap, type LaneContract } from "../../core/lanes/lane-check";
import { parseCompletionReport } from "../../core/digests/completion";
import { parseStatusPorcelain } from "../../core/git/parsers";
import { oneLine } from "../../core/text";
import type { GalapagosDb } from "../db/db";
import {
  amendLaneGlobs,
  createLane,
  getLane,
  laneGlobs,
  listActiveLanes,
  reactivateLane,
  retireLane,
  type LaneRow,
} from "../db/repos/lanes";
import {
  appendWorkerEvent,
  countWorkerEvents,
  createWorker,
  getWorker,
  listLiveStatusWorkers,
  listRecentWorkerEvents,
  listWorkers,
  setWorkerBriefRecord,
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
  openAttentionItemExists,
  type AttentionItemRow,
} from "../db/repos/attention";
import type { ProjectRow } from "../db/repos/projects";
import { slugify } from "../db/repos/projects";
import { addWorktree, removeWorktree, workerWorktreePath } from "../git/mutating-runner";
import { commitRecords } from "../git/mutating-runner";
import { LocalGitCommandRunner } from "../git/runner";
import { createRecordsStore } from "../records/store";
import { buildWorkerDoctrine } from "./worker-doctrine";
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
  /** Newest events only — status is a glance, not the transcript. */
  recentEvents: WorkerEventRow[];
  eventsTotal: number;
  digest: CompletionDigestRow | null;
  attention: AttentionItemRow[];
};

type LiveEntry = {
  session: WorkerSession;
  loopDone: Promise<void>;
  stopRequested: boolean;
  /**
   * The live lane contract — the SAME object the session's canUseTool closes
   * over, so a user-approved lane amendment takes effect on the next write.
   */
  contract: LaneContract;
  /** One-shot waiters for the worker's next visible reply (steer-with-ack). */
  replyWaiters: ((summary: string) => void)[];
};

/**
 * The detective audit's file set (architecture §7): committed changes since
 * the lane's base sha ∪ porcelain modified/untracked in the worktree. Both
 * reads use -z (NUL-delimited, no C-style quoting — a path like café.ts must
 * reach the globs verbatim, not as an escaped string no glob matches), and
 * the porcelain output goes through the tested core parser.
 */
export async function collectAuditFiles(worktreePath: string, baseSha: string): Promise<string[]> {
  const runner = new LocalGitCommandRunner();
  const [diffOutput, porcelainOutput] = await Promise.all([
    runner.runGit(["diff", "--name-only", "-z", `${baseSha}...HEAD`], worktreePath),
    // -uall lists untracked FILES: the default collapses a new directory to
    // "dir/", which globs can neither honestly clear nor blame.
    runner.runGit(["status", "--porcelain=v1", "-z", "-uall"], worktreePath),
  ]);

  const files = new Set<string>();
  for (const token of diffOutput.split("\0")) {
    if (token) {
      files.add(token);
    }
  }
  const status = parseStatusPorcelain(porcelainOutput);
  for (const entry of [...status.stagedFiles, ...status.dirtyFiles, ...status.untrackedFiles]) {
    if (entry.path) {
      files.add(entry.path);
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
  // Workers whose stop/finalize pass is currently running: a second stop
  // (manager tool racing the HTTP route) must not run the audit twice and
  // duplicate attention items.
  const stopping = new Set<string>();
  // Same-tool denial counters per live worker (loud-denial ruling): a worker
  // silently improvising around a permission wall must become visible.
  const denialCounts = new Map<string, Map<string, number>>();
  const DENIAL_ATTENTION_THRESHOLD = 3;

  const recordDenial = (workerId: string, projectId: string, tool: string) => {
    const perWorker = denialCounts.get(workerId) ?? new Map<string, number>();
    denialCounts.set(workerId, perWorker);
    const count = (perWorker.get(tool) ?? 0) + 1;
    perWorker.set(tool, count);
    if (count === DENIAL_ATTENTION_THRESHOLD) {
      createAttentionItem(db, {
        projectId,
        workerId,
        kind: "tool_denied",
        title: `Worker denied ${tool} ${count} times`,
        detail: `The lane/tool guard denied ${tool} ${count} times in this session. The worker may be improvising around the denial — review its stream, steer it an alternative, or escalate whether ${tool} should be granted.`,
      });
    }
  };

  const drainReplyWaiters = (workerId: string, summary: string) => {
    const entry = live.get(workerId);
    if (entry && entry.replyWaiters.length > 0) {
      const waiters = entry.replyWaiters.splice(0);
      for (const waiter of waiters) {
        waiter(summary);
      }
    }
  };

  /** Bounded wait for the worker's next visible reply; null on timeout. */
  const awaitReply = (entry: LiveEntry, timeoutMs: number): Promise<string | null> =>
    new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        const index = entry.replyWaiters.indexOf(waiter);
        if (index !== -1) {
          entry.replyWaiters.splice(index, 1);
        }
        resolve(null);
      }, timeoutMs);
      const waiter = (summary: string) => {
        clearTimeout(timer);
        resolve(summary);
      };
      entry.replyWaiters.push(waiter);
    });

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
   * A session that dies MID-RUN fails with nobody watching a tool result, so
   * the attention queue is the only surface that can carry it to triage and
   * the user. Spawn failures stay off the queue — they return synchronously
   * to whoever asked. One open item per worker; a failed worker stays failed.
   */
  const raiseWorkerFailure = (worker: WorkerRow, message: string) => {
    const title = "Worker session failed";
    if (
      openAttentionItemExists(db, {
        projectId: worker.project_id,
        workerId: worker.id,
        kind: "worker_failed",
        title,
      })
    ) {
      return;
    }
    createAttentionItem(db, {
      projectId: worker.project_id,
      workerId: worker.id,
      kind: "worker_failed",
      title,
      detail: `${message}\nThe session will not be retried; its work up to this point remains in ${worker.worktree_path}.`,
      priority: "high",
    });
  };

  /**
   * Handle one successful result: parse the completion contract. A valid
   * report becomes a digest; a malformed block is an immediate attention item
   * (the worker claimed completion and botched the format); NO block is
   * ordinary mid-task conversation — the at-stop check owns that case.
   * Returns the parse status so the caller can set the worker's state: a
   * block-less turn end is, per the worker doctrine, a stated blocker or
   * question — awaiting_input, not idle.
   */
  const handleSuccessResult = (
    worker: WorkerRow,
    resultText: string,
  ): "parsed" | "missing" | "malformed" => {
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
    return parsed.status;
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
          const message = `Worker event loop crashed: ${error instanceof Error ? error.message : String(error)}`;
          persistEvent(worker, "error", { message });
          raiseWorkerFailure(worker, message);
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
          drainReplyWaiters(workerId, oneLine(event.payload.text, 400));
          break;
        case "tool_use": {
          // Write/Edit inputs can carry whole files; the worktree already
          // holds the real content — persist a bounded preview, not megabytes
          // per row broadcast to every SSE client.
          const rawInput = JSON.stringify(event.payload.input ?? {});
          persistEvent(worker, "tool_use", {
            tool: event.payload.tool,
            input:
              rawInput.length > 4000
                ? `${rawInput.slice(0, 4000)}… (${rawInput.length} chars total — see the worktree for the real content)`
                : event.payload.input,
          });
          break;
        }
        case "tool_result":
          persistEvent(worker, "tool_result", {
            content: oneLine(event.payload.content, 4000),
            isError: event.payload.isError,
          });
          break;
        case "result":
          if (event.payload.isError && live.get(workerId)?.stopRequested) {
            // Interrupting an in-flight turn surfaces as an error RESULT from
            // the SDK. A requested stop is not a failure: persist nothing here
            // — finalizeStop writes the honest "stopped by …" marker.
            break;
          }
          persistEvent(worker, "result", event.payload);
          if (event.payload.isError) {
            // Auth/model/max-turn failure: the session cannot continue. Never
            // retried on a fresh session (chunk 2 rule, same for workers).
            failed = true;
            raiseWorkerFailure(worker, `The worker's turn ended in error (${event.payload.subtype}).`);
            setStatus(worker, "failed");
          } else {
            const parseStatus =
              event.payload.resultText !== null
                ? handleSuccessResult(worker, event.payload.resultText)
                : "missing";
            // A turn ending WITHOUT a completion block is, per the worker
            // doctrine, a stated blocker or question — the worker is waiting
            // on its manager, not resting.
            setStatus(worker, parseStatus === "missing" ? "awaiting_input" : "idle");
            drainReplyWaiters(
              workerId,
              event.payload.resultText
                ? oneLine(event.payload.resultText, 400)
                : "(turn ended without text)",
            );
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
          raiseWorkerFailure(worker, event.payload.message);
          setStatus(worker, "failed");
          break;
        }
      }
    }

    const worker = getWorker(db, workerId);
    const entry = live.get(workerId);
    if (worker && !failed && !entry?.stopRequested && worker.status !== "failed") {
      // The stream ended without a stop request: the session process died.
      const message = "Worker session ended unexpectedly — its process exited.";
      persistEvent(worker, "error", { message });
      raiseWorkerFailure(worker, message);
      setStatus(worker, "failed");
    }
  };

  /**
   * The at-stop safety pass: detective lane audit over the worktree, the
   * has-a-digest check, lane retirement. Runs for live stops and for boot
   * reconciliation alike. Never silently skipped — an audit that cannot run
   * becomes an attention item. `stoppedBy` names who ended this worker so
   * the stream records a deliberate stop as a stop, never as a failure.
   */
  const finalizeStop = async (worker: WorkerRow, stoppedBy: string): Promise<StopWorkerOutcome> => {
    persistEvent(worker, "result", {
      subtype: "stopped",
      isError: false,
      resultText: null,
      stoppedBy,
    });
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
          // The monitor may have caught these exact files mid-run — the same
          // open fact is not appended twice (a CHANGED violation set is).
          const title = `Out-of-lane changes in lane "${lane.name}"`;
          const detail = violations.map((entry) => `${entry.path} (${entry.reason})`).join("\n");
          if (
            !openAttentionItemExists(db, {
              projectId: worker.project_id,
              workerId: worker.id,
              kind: "lane_violation",
              title,
              detail,
            })
          ) {
            createAttentionItem(db, {
              projectId: worker.project_id,
              workerId: worker.id,
              kind: "lane_violation",
              title,
              detail,
              priority: "high",
            });
          }
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

      // Exclusivity validation runs AFTER the last await and the lane row is
      // inserted synchronously right behind it: two concurrent spawns (the
      // manager tool racing a direct POST /workers) cannot both pass the
      // check before either inserts.
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

      // Leftovers from a retired lane of the same name are a CLEAN rejection
      // — Darwin reads the reason and picks a new name (or resumes the old
      // worker). They must never become a failed worker row (drill finding).
      const worktreePath = workerWorktreePath(config.stateDir, project.slug, laneSlug);
      const branch = `galapagos/worker/${laneSlug}`;
      if (existsSync(worktreePath)) {
        return {
          ok: false,
          reason: `A previous lane named "${laneName}" left its worktree at ${worktreePath} — that work is preserved there. Pick a NEW lane name for new work, or use resume_worker on the stopped worker to continue the old task.`,
        };
      }
      try {
        const runner = new LocalGitCommandRunner();
        await runner.runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], project.root_path);
        return {
          ok: false,
          reason: `The branch ${branch} already exists from a previous lane named "${laneName}". Pick a NEW lane name — worker branches are never reused.`,
        };
      } catch {
        // branch does not exist — the name is free
      }

      const lane = createLane(db, {
        projectId: project.id,
        name: laneName,
        slug: laneSlug,
        allowedGlobs,
        forbiddenGlobs,
        baseSha,
      });
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
        setWorkerBriefRecord(db, worker.id, record.id);
        const commit = await commitRecords(
          project.root_path,
          `galapagos(records): worker brief for lane ${laneSlug}`,
        );
        if (commit.status === "skipped") {
          briefCommitNote = `Brief record written but its commit was skipped: ${commit.reason}. It will land with the next records commit.`;
        }
      } catch (error) {
        await removeWorktree({
          projectRoot: project.root_path,
          worktreePath,
          stateDir: config.stateDir,
          branch,
        });
        return abort(
          `Writing the worker_brief record failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // One shared contract object: the session's canUseTool closes over it,
      // so an approved amend_lane mutation applies to the very next write.
      const contract: LaneContract = { allowedGlobs, forbiddenGlobs };
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
          lane: contract,
          onToolDenied: (tool) => recordDenial(worker.id, project.id, tool),
        });
      } catch (error) {
        await removeWorktree({
          projectRoot: project.root_path,
          worktreePath,
          stateDir: config.stateDir,
          branch,
        });
        return abort(
          `Spawning the worker session failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const loopDone = consumeSession(worker.id, session);
      live.set(worker.id, { session, loopDone, stopRequested: false, contract, replyWaiters: [] });

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

    /**
     * Continue a stopped worker's task (user-confirmed ruling, 2026-07-05):
     * a FRESH session in the SAME worktree and branch, lane re-activated
     * after re-checking exclusivity, briefed from the original worker_brief
     * record plus the worktree's actual git state. The old session is gone —
     * this is continuation of the WORK, not resurrection of the transcript.
     */
    async resume(input: {
      project: ProjectRow;
      workerId: string;
      note?: string;
    }): Promise<SpawnWorkerOutcome> {
      const { project } = input;
      const predecessor = getWorker(db, input.workerId);
      if (!predecessor) {
        return { ok: false, reason: `No worker with id ${input.workerId}.` };
      }
      if (live.has(predecessor.id) || stopping.has(predecessor.id)) {
        return {
          ok: false,
          reason: `Worker ${predecessor.id} is still live — steer it instead of resuming.`,
        };
      }
      if (predecessor.status !== "stopped" && predecessor.status !== "failed") {
        return {
          ok: false,
          reason: `Worker ${predecessor.id} is ${predecessor.status} — only stopped or failed workers can be resumed.`,
        };
      }
      const lane = getLane(db, predecessor.lane_id);
      if (!lane) {
        return { ok: false, reason: `Worker ${predecessor.id} has no lane row — cannot resume.` };
      }
      if (!existsSync(predecessor.worktree_path)) {
        return {
          ok: false,
          reason: `The worktree at ${predecessor.worktree_path} no longer exists — the work is gone; spawn a fresh worker instead.`,
        };
      }

      // Exclusivity holds across resume: the lane's globs must not overlap
      // any lane that became active while this one was retired.
      const contract = laneGlobs(lane);
      for (const active of listActiveLanes(db, project.id)) {
        if (active.id === lane.id) {
          continue;
        }
        const overlap = findLaneOverlap(contract.allowedGlobs, laneGlobs(active).allowedGlobs);
        if (overlap) {
          return {
            ok: false,
            reason: `Resume rejected: this lane's glob "${overlap.candidateGlob}" overlaps "${overlap.existingGlob}" of the now-active lane "${active.name}". Stop that worker first or wait for it.`,
          };
        }
      }

      // The continuation brief: the original doctrine-judged brief plus the
      // honest state of the worktree the new session inherits.
      let originalBrief = "(the original worker_brief record is unavailable — inspect the worktree and its commits to reconstruct the task)";
      if (predecessor.brief_record_id) {
        const store = createRecordsStore(project.root_path, project.slug);
        const record = store.get(predecessor.brief_record_id);
        if (record) {
          originalBrief = `${record.title}\n\n${record.body.trim()}`;
        }
      }
      let commits = "(could not read)";
      let dirty = "(could not read)";
      try {
        const runner = new LocalGitCommandRunner();
        commits =
          (
            await runner.runGit(
              ["log", "--oneline", `${lane.base_sha}..HEAD`],
              predecessor.worktree_path,
            )
          ).trim() || "(none yet)";
        dirty =
          (
            await runner.runGit(["status", "--porcelain", "-uall"], predecessor.worktree_path)
          ).trim() || "(clean)";
      } catch (error) {
        return {
          ok: false,
          reason: `Could not read the worktree's git state: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const briefText = `CONTINUATION: you are resuming a task a previous worker session started
and did not finish. You work in the SAME worktree — its state below is
real; inspect it with git before acting, and do not redo finished work.

## Original brief

${originalBrief}

## Worktree state at resume

Commits since the lane base:
${commits}

Uncommitted changes:
${dirty}

## Continuation instruction from the manager

${input.note?.trim() || "Continue toward the original brief's done-criteria."}

Review the state first, then continue. End with your completion report as
required.`;

      reactivateLane(db, lane.id);
      const worker = createWorker(db, {
        projectId: project.id,
        laneId: lane.id,
        worktreePath: predecessor.worktree_path,
        branch: predecessor.branch,
        briefRecordId: predecessor.brief_record_id,
        resumedFrom: predecessor.id,
      });

      let session: WorkerSession;
      try {
        session = sessionFactory({
          config,
          worktreePath: predecessor.worktree_path,
          systemPrompt: buildWorkerDoctrine({
            projectName: project.name,
            laneName: lane.name,
            allowedGlobs: contract.allowedGlobs,
            forbiddenGlobs: contract.forbiddenGlobs,
            baseSha: lane.base_sha,
            branch: predecessor.branch,
            worktreePath: predecessor.worktree_path,
          }),
          briefText,
          model: config.workerModel,
          lane: contract,
          onToolDenied: (tool) => recordDenial(worker.id, project.id, tool),
        });
      } catch (error) {
        persistEvent(worker, "error", {
          message: `Resuming the worker session failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        retireLane(db, lane.id);
        setStatus(worker, "failed");
        return {
          ok: false,
          reason: `Resuming the worker session failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const loopDone = consumeSession(worker.id, session);
      live.set(worker.id, { session, loopDone, stopRequested: false, contract, replyWaiters: [] });

      return {
        ok: true,
        workerId: worker.id,
        laneSlug: lane.slug,
        branch: predecessor.branch,
        worktreePath: predecessor.worktree_path,
        baseSha: lane.base_sha,
        briefRecordId: predecessor.brief_record_id ?? "(none)",
        briefCommitNote: null,
      };
    },

    /**
     * Inject a message mid-run. With awaitResponse (steer-with-acknowledgment,
     * user-confirmed ruling) the call waits — bounded — for the worker's next
     * visible reply so the manager catches misinterpretation in the same
     * turn; on timeout it reports "delivered, no response yet" honestly.
     */
    async steer(
      workerId: string,
      message: string,
      options: { awaitResponse?: boolean; timeoutMs?: number } = {},
    ): Promise<{ ok: true; response: string | null } | { ok: false; reason: string }> {
      const worker = getWorker(db, workerId);
      if (!worker) {
        return { ok: false, reason: `No worker with id ${workerId}.` };
      }
      if (worker.status === "failed" || worker.status === "stopped") {
        // A failed session may linger in the live map until its stream
        // closes; steering it would flip a dead worker back to "running".
        return {
          ok: false,
          reason: `Worker ${workerId} is ${worker.status} — it cannot be steered. Spawn a fresh worker instead.`,
        };
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

      if (!options.awaitResponse) {
        return { ok: true, response: null };
      }
      const response = await awaitReply(entry, options.timeoutMs ?? 60_000);
      return { ok: true, response };
    },

    /**
     * Hold (user-confirmed ruling): the brake that is not a Stop. A canned
     * pause steer — the worker states where it is and waits (rendering
     * awaiting_input by the completion contract). The lane stays active, the
     * session stays live; release is an ordinary steer.
     */
    async hold(
      workerId: string,
      heldBy: string,
    ): Promise<{ ok: true; response: string | null } | { ok: false; reason: string }> {
      const worker = getWorker(db, workerId);
      if (!worker) {
        return { ok: false, reason: `No worker with id ${workerId}.` };
      }
      const entry = live.get(workerId);
      if (!entry || worker.status === "failed" || worker.status === "stopped") {
        return {
          ok: false,
          reason: `Worker ${workerId} is ${worker.status} — there is no live session to hold.`,
        };
      }
      const holdMessage = `HOLD (requested by ${heldBy}): pause now. Do not start anything new and do not write further changes. Reply with ONE short message stating exactly where you are and what remains, then wait for further instructions. Do not emit a completion block.`;
      try {
        entry.session.send(holdMessage);
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      persistEvent(worker, "steer", { text: holdMessage, hold: true, heldBy });
      const response = await awaitReply(entry, 60_000);
      return { ok: true, response };
    },

    /**
     * Apply a user-APPROVED lane amendment (the approval gate lives in the
     * amend_lane tool — the runtime only ever applies what the user allowed):
     * widen the lane through the same exclusivity gate a spawn passes, record
     * the amendment on the lane row and brief record, tell the worker.
     */
    async applyLaneAmendment(input: {
      project: ProjectRow;
      workerId: string;
      addGlobs: string[];
      reason: string;
      approvedBy: string;
    }): Promise<{ ok: true; allowedGlobs: string[] } | { ok: false; reason: string }> {
      const { project } = input;
      const worker = getWorker(db, input.workerId);
      if (!worker) {
        return { ok: false, reason: `No worker with id ${input.workerId}.` };
      }
      const entry = live.get(input.workerId);
      if (!entry || worker.status === "failed" || worker.status === "stopped") {
        return {
          ok: false,
          reason: `Worker ${input.workerId} is ${worker.status} — amend lanes only on live workers (resume first).`,
        };
      }
      const lane = getLane(db, worker.lane_id);
      if (!lane) {
        return { ok: false, reason: `Worker ${input.workerId} has no lane row.` };
      }
      const addGlobs = input.addGlobs.map((glob) => glob.trim()).filter(Boolean);
      if (addGlobs.length === 0) {
        return { ok: false, reason: "An amendment needs at least one glob to add." };
      }

      // The SAME exclusivity gate a spawn passes: the widened lane must not
      // overlap any other active lane.
      for (const active of listActiveLanes(db, project.id)) {
        if (active.id === lane.id) {
          continue;
        }
        const overlap = findLaneOverlap(addGlobs, laneGlobs(active).allowedGlobs);
        if (overlap) {
          return {
            ok: false,
            reason: `Amendment rejected: "${overlap.candidateGlob}" overlaps "${overlap.existingGlob}" of active lane "${active.name}". Lanes stay exclusive — stop that worker first or scope differently.`,
          };
        }
      }

      const current = laneGlobs(lane);
      const merged = [...current.allowedGlobs, ...addGlobs.filter((glob) => !current.allowedGlobs.includes(glob))];
      amendLaneGlobs(db, lane.id, merged);
      // Mutate the live contract object the session's canUseTool closes over.
      entry.contract.allowedGlobs.length = 0;
      entry.contract.allowedGlobs.push(...merged);

      // The brief record carries the amendment — the lane contract's paper
      // trail stays in the target repo's history.
      if (worker.brief_record_id) {
        try {
          const store = createRecordsStore(project.root_path, project.slug);
          store.update({
            id: worker.brief_record_id,
            note: `Lane amended (approved by ${input.approvedBy}): allowed globs now ${merged.join(", ")}. Reason: ${input.reason}`,
          });
          await commitRecords(
            project.root_path,
            `galapagos(records): lane amendment for ${lane.slug}`,
          );
        } catch {
          // The amendment itself stands; the record note is best-effort and
          // the next distill commit will carry any pending record changes.
        }
      }

      const notice = `LANE AMENDED (approved by ${input.approvedBy}): your allowed globs are now: ${merged.join(", ")}. Reason: ${input.reason}. The forbidden globs are unchanged.`;
      try {
        entry.session.send(notice);
      } catch (error) {
        return {
          ok: false,
          reason: `Amendment applied but the worker could not be told: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      persistEvent(worker, "steer", { text: notice, laneAmendment: { addGlobs } });
      return { ok: true, allowedGlobs: merged };
    },

    async stop(
      workerId: string,
      stoppedBy = "an unspecified caller",
    ): Promise<StopWorkerOutcome> {
      const worker = getWorker(db, workerId);
      if (!worker) {
        return { ok: false, reason: `No worker with id ${workerId}.` };
      }
      if (worker.status === "stopped") {
        return { ok: false, reason: `Worker ${workerId} is already stopped.` };
      }
      if (stopping.has(workerId)) {
        return { ok: false, reason: `Worker ${workerId} is already being stopped.` };
      }
      // A failed worker with a retired lane was already finalized (its audit
      // ran at spawn-abort, an earlier stop, or boot reconciliation) —
      // re-running finalizeStop would duplicate its attention items.
      const lane = getLane(db, worker.lane_id);
      if (worker.status === "failed" && lane?.status === "retired" && !live.has(workerId)) {
        return {
          ok: false,
          reason: `Worker ${workerId} already failed and its lane is retired — the at-stop audit has already run.`,
        };
      }
      stopping.add(workerId);
      try {
        const entry = live.get(workerId);
        if (entry) {
          entry.stopRequested = true;
          await entry.session.stop();
          await entry.loopDone;
        }
        return await finalizeStop(worker, stoppedBy);
      } finally {
        stopping.delete(workerId);
      }
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
        recentEvents: listRecentWorkerEvents(db, workerId, 10),
        eventsTotal: countWorkerEvents(db, workerId),
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
        await finalizeStop(worker, "the daemon (restart reconciliation)");
      }
      return orphans.length;
    },
  };
}
