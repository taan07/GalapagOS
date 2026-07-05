// The monitor loop (architecture §7): a daemon interval tick that makes ZERO
// LLM calls, ever. It turns observable facts into attention rows — silence,
// abandoned questions, out-of-lane files, claims without evidence, main-
// checkout drift — auto-reviews completions the evidence already proves
// clean, and triggers the (separate, event-driven) triage session when new
// open items exist. Everything it raises is deduplicated against identical
// OPEN facts, so a 30s cadence never floods the queue.
import type { GalapagosConfig } from "../config";
import { scoreWorker } from "../core/confidence/engine";
import { checkLane } from "../core/lanes/lane-check";
import { oneLine } from "../core/text";
import type { GalapagosDb } from "../adapters/db/db";
import {
  countOpenAttentionSince,
  createAttentionItem,
  listOpenWorkerAttentionByKind,
  listWorkerAttentionItems,
  openAttentionItemExists,
  resolveAttentionItem,
  type AttentionKind,
} from "../adapters/db/repos/attention";
import { listUnreviewedDigests, setDigestStatus } from "../adapters/db/repos/digests";
import { listRecentJobsByKind } from "../adapters/db/repos/jobs";
import { getLane, laneGlobs, listActiveLanes, type LaneRow } from "../adapters/db/repos/lanes";
import { listProjects, type ProjectRow } from "../adapters/db/repos/projects";
import {
  getWorker,
  listWorkers,
  LIVE_WORKER_STATUSES,
  type WorkerRow,
} from "../adapters/db/repos/workers";
import { collectAuditFiles } from "../adapters/agent/worker-runtime";
import { buildWorkerEvidence } from "../adapters/evidence/adapter";
import { observeGitRepository } from "../adapters/git/runner";

export type MonitorBroadcast =
  | { type: "attention_changed"; projectId: string }
  | { type: "digest_reviewed"; projectId: string; workerId: string }
  | { type: "monitor_tick"; projectId: string };

export type LegReviewInput = {
  worker: WorkerRow;
  lane: LaneRow | null;
  digestId: string;
};

export type MonitorDeps = {
  db: GalapagosDb;
  config: GalapagosConfig;
  /** Event-driven triage — invoked ONLY when new open attention items exist. */
  runTriage: (project: ProjectRow) => Promise<void>;
  /**
   * The judgment legs, launched once per completion (and again when the
   * workspace moves past a verdict). Injected so tests use fakes and the
   * tick itself stays LLM-free — the legs are events, like triage.
   */
  runWatchdog: (input: LegReviewInput) => Promise<unknown>;
  runCritic: (input: LegReviewInput) => Promise<unknown>;
  broadcast?: (event: MonitorBroadcast) => void;
  now?: () => Date;
};

type CheckoutSnapshot = {
  fingerprint: string;
  files: Set<string>;
};

/** Does this file fall inside what the lane's worker would plausibly touch? */
function laneClaimsFile(file: string, lane: LaneRow): boolean {
  const violations = checkLane([file], laneGlobs(lane));
  // No violation = matches an allowed glob; a "forbidden" hit is also the
  // lane's territory. Only "not_allowed" means the lane never claimed it.
  return !violations.some((violation) => violation.reason === "not_allowed");
}

export type Monitor = ReturnType<typeof createMonitor>;

export function createMonitor(deps: MonitorDeps) {
  const { db, config } = deps;
  const now = () => (deps.now ? deps.now() : new Date());
  // The only in-memory state, and deliberately so: main-checkout baselines
  // (a restart just re-baselines on the next tick) and in-flight guards.
  const checkoutSnapshots = new Map<string, CheckoutSnapshot>();
  const triaging = new Set<string>();
  /** One leg run in flight per worker per leg — key `<leg>:<workerId>`. */
  const legRuns = new Set<string>();
  let interval: NodeJS.Timeout | null = null;
  let ticking = false;

  const raise = (input: {
    project: ProjectRow;
    workerId?: string | null;
    kind: AttentionKind;
    title: string;
    detail: string;
    priority?: "high" | "normal";
  }): boolean => {
    if (
      openAttentionItemExists(db, {
        projectId: input.project.id,
        workerId: input.workerId ?? null,
        kind: input.kind,
        title: input.title,
        detail: input.detail,
      })
    ) {
      return false;
    }
    createAttentionItem(db, {
      projectId: input.project.id,
      workerId: input.workerId ?? null,
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      priority: input.priority ?? "normal",
    });
    return true;
  };

  /** Staleness + abandoned questions: silence is only suspicious per episode. */
  const scanLiveness = (project: ProjectRow, worker: WorkerRow, lane: LaneRow | null): boolean => {
    const lastSignal = worker.last_message_at ?? worker.created_at;
    const silentSeconds = Math.max(0, (now().getTime() - Date.parse(lastSignal)) / 1000);
    if (silentSeconds <= config.staleWorkerSeconds) {
      return false;
    }
    const label = lane?.name ?? worker.id.slice(0, 8);

    if (worker.status === "running" || worker.status === "spawning") {
      // Episode dedup: any stale_worker item raised since the worker's last
      // signal already covers this silence; new activity starts a new episode.
      const alreadyRaised = listWorkerAttentionItems(db, worker.id).some(
        (item) => item.kind === "stale_worker" && item.created_at >= lastSignal,
      );
      if (alreadyRaised) {
        return false;
      }
      createAttentionItem(db, {
        projectId: project.id,
        workerId: worker.id,
        kind: "stale_worker",
        title: `Worker "${label}" has gone quiet`,
        detail: `No messages for ${Math.round(silentSeconds)}s while ${worker.status} (threshold ${config.staleWorkerSeconds}s). The session may be hung or looping without output — check its stream, steer it, or stop it.`,
        priority: "high",
      });
      return true;
    }

    if (worker.status === "awaiting_input") {
      // A worker question is dialogue, not an exception (chunk 3 ruling) —
      // until it sits unanswered past the threshold. Then it is exactly the
      // kind of thing the user must not discover by accident.
      const alreadyRaised = listWorkerAttentionItems(db, worker.id).some(
        (item) => item.kind === "question_for_user" && item.created_at >= lastSignal,
      );
      if (alreadyRaised) {
        return false;
      }
      createAttentionItem(db, {
        projectId: project.id,
        workerId: worker.id,
        kind: "question_for_user",
        title: `Worker "${label}" is waiting on an answer`,
        detail: `The worker ended its turn without a completion report ${Math.round(silentSeconds)}s ago — per its doctrine that is a stated blocker or question. Its last words: ${oneLine(worker.last_summary ?? "(no summary captured)", 300)}`,
        priority: "high",
      });
      return true;
    }
    return false;
  };

  /** The detective lane audit, mid-run (architecture §7 layer 2). */
  const scanLane = async (
    project: ProjectRow,
    worker: WorkerRow,
    lane: LaneRow,
  ): Promise<boolean> => {
    try {
      const files = await collectAuditFiles(worker.worktree_path, lane.base_sha);
      const violations = checkLane(files, laneGlobs(lane));
      if (violations.length === 0) {
        return false;
      }
      return raise({
        project,
        workerId: worker.id,
        kind: "lane_violation",
        title: `Out-of-lane changes in lane "${lane.name}"`,
        detail: violations.map((entry) => `${entry.path} (${entry.reason})`).join("\n"),
        priority: "high",
      });
    } catch (error) {
      return raise({
        project,
        workerId: worker.id,
        kind: "check_failed",
        title: "Lane audit could not run during monitoring",
        detail: error instanceof Error ? error.message : String(error),
        priority: "high",
      });
    }
  };

  /** Launch a judgment leg once per completion, one in flight per worker. */
  const ensureLegRun = (
    leg: "watchdog" | "critic",
    run: (input: LegReviewInput) => Promise<unknown>,
    input: LegReviewInput,
    project: ProjectRow,
  ): void => {
    const key = `${leg}:${input.worker.id}`;
    if (legRuns.has(key)) {
      return;
    }
    legRuns.add(key);
    void run(input)
      .catch((error) => {
        console.error(
          `[monitor] ${leg} review failed for worker ${input.worker.id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        legRuns.delete(key);
        // A verdict landed (or honestly failed) — gauges and the queue move.
        deps.broadcast?.({ type: "attention_changed", projectId: project.id });
      });
  };

  /**
   * Completion-claims scan over unreviewed digests: raise what the evidence
   * cannot support, auto-resolve what new evidence now supports, launch the
   * judgment legs that are due, surface integrity findings, and auto-review
   * completions ALL legs prove clean — the tick itself stays zero-LLM.
   */
  const scanDigests = async (project: ProjectRow): Promise<boolean> => {
    let changed = false;
    for (const digest of listUnreviewedDigests(db, project.id)) {
      const worker = getWorker(db, digest.worker_id);
      if (!worker) {
        continue;
      }
      const lane = getLane(db, worker.lane_id) ?? null;
      const evidence = await buildWorkerEvidence(db, {
        worker,
        lane,
        staleWorkerSeconds: config.staleWorkerSeconds,
        now: now(),
      });

      // Judgment legs: due when no verdict covers this digest at the current
      // workspace state. Failed runs are NOT auto-retried (they surface as
      // "unavailable" and drain) — a fresh digest or workspace change re-arms.
      const watchdogInput = evidence.input.watchdog;
      if (
        watchdogInput &&
        (watchdogInput.status === "pending" ||
          (watchdogInput.status === "reviewed" && !watchdogInput.fresh))
      ) {
        ensureLegRun("watchdog", deps.runWatchdog, { worker, lane, digestId: digest.id }, project);
      }
      const criticInput = evidence.input.critic;
      if (
        criticInput &&
        (criticInput.status === "pending" ||
          (criticInput.status === "reviewed" && !criticInput.fresh))
      ) {
        ensureLegRun("critic", deps.runCritic, { worker, lane, digestId: digest.id }, project);
      }

      // Integrity findings → the queue. Tripwire alerts and watchdog gaming
      // are trust breaches (high); watchdog suspicion is a judgment call for
      // triage (normal); critic blockers name what the brief did not get.
      if (evidence.input.integrity.available) {
        for (const finding of evidence.input.integrity.tripwires) {
          if (finding.severity !== "alert") {
            continue;
          }
          if (
            raise({
              project,
              workerId: worker.id,
              kind: "integrity_alert",
              title: `Test-integrity tripwire: ${finding.id}`,
              detail: `${finding.label}.\n${finding.paths.join("\n")}`,
              priority: "high",
            })
          ) {
            changed = true;
          }
        }
      }
      if (watchdogInput?.status === "reviewed" && watchdogInput.fresh) {
        if (
          watchdogInput.verdict !== "clean" &&
          raise({
            project,
            workerId: worker.id,
            kind: "integrity_alert",
            title:
              watchdogInput.verdict === "gaming"
                ? "Watchdog: transcript shows the checks being gamed"
                : "Watchdog: transcript is suspicious",
            detail: watchdogInput.summary,
            priority: watchdogInput.verdict === "gaming" ? "high" : "normal",
          })
        ) {
          changed = true;
        }
      }
      if (criticInput?.status === "reviewed" && criticInput.fresh) {
        const blockers = criticInput.findings.filter(
          (finding) => finding.severity === "blocker",
        );
        if (
          (criticInput.verdict === "reject" || blockers.length > 0) &&
          raise({
            project,
            workerId: worker.id,
            kind: "integrity_alert",
            title: "Critic: the work does not hold against its brief",
            detail:
              blockers.map((finding) => finding.label).join("\n") || criticInput.summary,
            priority: "high",
          })
        ) {
          changed = true;
        }
      }

      const problems = evidence.linkedClaims.filter(
        (claim) => claim.verification === "unsupported" || claim.verification === "contradicted",
      );
      for (const claim of problems) {
        const contradicted = claim.verification === "contradicted";
        if (
          raise({
            project,
            workerId: worker.id,
            kind: "unsupported_claim",
            title: contradicted
              ? `Worker claim contradicted by evidence`
              : `Worker claims ${claim.evidenceKind} evidence that does not exist`,
            detail: `"${claim.text}"\n${claim.reason}`,
            priority: contradicted ? "high" : "normal",
          })
        ) {
          changed = true;
        }
      }
      if (problems.length === 0) {
        for (const item of listOpenWorkerAttentionByKind(db, worker.id, "unsupported_claim")) {
          resolveAttentionItem(
            db,
            item.id,
            "resolved",
            "Fresh evidence now supports every claim on the latest completion report (monitor).",
          );
          changed = true;
        }
      }

      // Management by exception: a completion whose evidence already proves
      // it clean is reviewed without an LLM and without interrupting anyone.
      const report = scoreWorker(evidence.input);
      const openItems = listWorkerAttentionItems(db, worker.id).filter(
        (item) => item.status === "open",
      );
      if (report.state === "strong" && openItems.length === 0) {
        setDigestStatus(db, digest.id, "manager_reviewed");
        deps.broadcast?.({ type: "digest_reviewed", projectId: project.id, workerId: worker.id });
      }
    }
    return changed;
  };

  /**
   * Main-checkout watch (user-confirmed 2026-07-05): while workers are live,
   * NEW dirty files in the project's primary checkout that fall inside a
   * live lane's globs raise one attention item — a worker could have written
   * there via Bash with absolute paths, or it is the user's own edit. Worded
   * accordingly, deduplicated per file set, re-baselined every tick.
   */
  const scanMainCheckout = async (
    project: ProjectRow,
    activeLanes: LaneRow[],
  ): Promise<boolean> => {
    const observation = await observeGitRepository(project.root_path);
    const files = new Set(
      [
        ...observation.status.stagedFiles,
        ...observation.status.dirtyFiles,
        ...observation.status.untrackedFiles,
      ].map((entry) => entry.path),
    );
    const previous = checkoutSnapshots.get(project.id);
    checkoutSnapshots.set(project.id, {
      fingerprint: observation.dirtyFingerprint,
      files,
    });
    if (!previous || previous.fingerprint === observation.dirtyFingerprint) {
      return false;
    }
    const suspicious = [...files].filter(
      (file) =>
        !previous.files.has(file) && activeLanes.some((lane) => laneClaimsFile(file, lane)),
    );
    if (suspicious.length === 0) {
      return false;
    }
    return raise({
      project,
      kind: "lane_violation",
      title: "Main checkout changed while workers are live",
      detail: `New uncommitted changes in the project's primary checkout fall inside a live lane's globs:\n${suspicious.join("\n")}\nA worker could have written here via Bash with absolute paths — or this is your own edit. Verify before trusting the checkout; workers must only ever touch their worktrees.`,
      priority: "normal",
    });
  };

  /**
   * Latest triage attempt for this project — the trigger cutoff. The END of
   * the run when known: items triage itself raised mid-run (ask_user) must
   * not retrigger the pass that created them. The accepted edge: a fact
   * arising during the seconds-long triage window rides along with the next
   * genuinely new item instead of triggering its own pass.
   */
  const lastTriageCutoff = (projectId: string): string | null => {
    for (const job of listRecentJobsByKind(db, "triage")) {
      try {
        const payload = JSON.parse(job.payload ?? "{}") as { projectId?: string };
        if (payload.projectId === projectId) {
          return job.finished_at ?? job.created_at;
        }
      } catch {
        // Unparseable payload — not this project's.
      }
    }
    return null;
  };

  const tickProject = async (project: ProjectRow): Promise<void> => {
    let attentionChanged = false;
    const workers = listWorkers(db, project.id);
    const liveWorkers = workers.filter((worker) =>
      LIVE_WORKER_STATUSES.includes(worker.status),
    );

    for (const worker of liveWorkers) {
      const lane = getLane(db, worker.lane_id) ?? null;
      if (scanLiveness(project, worker, lane)) {
        attentionChanged = true;
      }
      if (lane && lane.status === "active" && (await scanLane(project, worker, lane))) {
        attentionChanged = true;
      }
    }

    if (await scanDigests(project)) {
      attentionChanged = true;
    }

    const activeLanes = listActiveLanes(db, project.id);
    if (liveWorkers.length > 0 && activeLanes.length > 0) {
      try {
        if (await scanMainCheckout(project, activeLanes)) {
          attentionChanged = true;
        }
      } catch (error) {
        console.error(
          `[monitor] main-checkout watch failed for ${project.slug}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      checkoutSnapshots.delete(project.id);
    }

    if (attentionChanged) {
      deps.broadcast?.({ type: "attention_changed", projectId: project.id });
    }
    deps.broadcast?.({ type: "monitor_tick", projectId: project.id });

    // Event-driven triage: only when open items exist that postdate the last
    // attempt, one in flight per project. The tick itself never calls an LLM.
    if (
      !triaging.has(project.id) &&
      countOpenAttentionSince(db, project.id, lastTriageCutoff(project.id)) > 0
    ) {
      triaging.add(project.id);
      void deps
        .runTriage(project)
        .catch((error) => {
          console.error(
            `[monitor] triage failed for ${project.slug}: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          triaging.delete(project.id);
        });
    }
  };

  const tick = async (): Promise<void> => {
    if (ticking) {
      return; // A slow audit must not stack ticks behind itself.
    }
    ticking = true;
    try {
      for (const project of listProjects(db)) {
        try {
          await tickProject(project);
        } catch (error) {
          console.error(
            `[monitor] tick failed for ${project.slug}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } finally {
      ticking = false;
    }
  };

  return {
    /** One pass over every project — exported for tests and manual kicks. */
    tick,
    start(): void {
      if (interval) {
        return;
      }
      interval = setInterval(() => {
        void tick();
      }, config.monitorIntervalMs);
    },
    stop(): void {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
