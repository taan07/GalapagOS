// Full confidence assembly for one project: every worker's evidence, the
// records-derived manager clarity, project-level evidence runs, and the open
// attention counts — through the pure engine, out as explainable reports.
// Used identically by the UI's read path and the daemon's monitor, so a
// gauge and a triage decision can never disagree about the same state.
import { scoreProject, scoreWorker } from "../../core/confidence/engine";
import type { ConfidenceReport } from "../../core/confidence/types";
import { isClosedStatus } from "../../core/records/schema";
import type { GalapagosDb } from "../db/db";
import { listOpenAttentionItems } from "../db/repos/attention";
import { latestRunsByKey } from "../db/repos/evidence";
import { getLane, type LaneRow } from "../db/repos/lanes";
import type { ProjectRow } from "../db/repos/projects";
import { listWorkers, type WorkerRow } from "../db/repos/workers";
import { createRecordsStore } from "../records/store";
import { buildWorkerEvidence, type WorkerEvidence } from "./adapter";
import { observeWorkspaceEvidence } from "./workspace";

export type WorkerConfidence = {
  worker: WorkerRow;
  lane: LaneRow | null;
  evidence: WorkerEvidence;
  report: ConfidenceReport;
  /**
   * Whether this worker feeds the project gauge. A long-stopped worker with
   * nothing open and its digest reviewed is history, not a standing risk.
   */
  countsTowardProject: boolean;
};

export type ProjectConfidence = {
  project: ConfidenceReport;
  workers: WorkerConfidence[];
  /** When this picture was computed — every gauge carries its source. */
  computedAt: string;
};

export async function computeProjectConfidence(
  db: GalapagosDb,
  args: {
    project: ProjectRow;
    staleWorkerSeconds: number;
    now?: Date;
  },
): Promise<ProjectConfidence> {
  const { project } = args;
  const now = args.now ?? new Date();

  const openAttention = listOpenAttentionItems(db, project.id);
  const openByWorker = new Map<string, number>();
  for (const item of openAttention) {
    if (item.worker_id) {
      openByWorker.set(item.worker_id, (openByWorker.get(item.worker_id) ?? 0) + 1);
    }
  }

  const workers: WorkerConfidence[] = [];
  for (const worker of listWorkers(db, project.id)) {
    const lane = getLane(db, worker.lane_id) ?? null;
    const evidence = await buildWorkerEvidence(db, {
      worker,
      lane,
      staleWorkerSeconds: args.staleWorkerSeconds,
      now,
    });
    const report = scoreWorker(evidence.input);
    const closed = worker.status === "stopped" || worker.status === "failed";
    const hasOpenAttention = (openByWorker.get(worker.id) ?? 0) > 0;
    const unreviewedDigest = evidence.digestStatus === "parsed";
    workers.push({
      worker,
      lane,
      evidence,
      report,
      countsTowardProject: !closed || hasOpenAttention || unreviewedDigest,
    });
  }

  // Manager clarity from the committed records — the same store Darwin
  // re-briefs from. An unreadable store degrades to zero clarity, visibly.
  let hasSynthesis = false;
  let hasActiveGoal = false;
  let openQuestionCount = 0;
  try {
    const store = createRecordsStore(project.root_path, project.slug);
    hasSynthesis = store
      .list({ type: "manager_synthesis" })
      .some((doc) => !isClosedStatus(doc.status));
    hasActiveGoal = store.list({ type: "active_goal", status: "active" }).length > 0;
    openQuestionCount = store
      .list({ type: "open_question" })
      .filter((doc) => !isClosedStatus(doc.status)).length;
  } catch {
    // Records unreachable: clarity is honestly zero, not fabricated.
  }

  let projectWorkspaceKey: string | null = null;
  try {
    projectWorkspaceKey = (await observeWorkspaceEvidence(project.root_path)).key;
  } catch {
    projectWorkspaceKey = null;
  }
  const projectRuns = latestRunsByKey(db, { projectId: project.id, workerId: null });
  const projectCheckRuns = Array.from(projectRuns.values()).map((run) => ({
    key: run.check_key,
    status: run.status,
    fresh: projectWorkspaceKey !== null && run.head_sha === projectWorkspaceKey,
  }));

  const freshEvidenceExists =
    projectCheckRuns.some((run) => run.fresh && run.status === "passed") ||
    workers.some(
      (entry) =>
        entry.countsTowardProject &&
        entry.evidence.input.checks.runs.some((run) => run.fresh && run.status === "passed"),
    );

  const report = scoreProject({
    clarity: { hasSynthesis, hasActiveGoal, openQuestionCount },
    // Project-level checks are informative, never demanded — required-ness
    // lives where completion claims live: on workers (implementer decision,
    // stamped in docs/chunks/4.md).
    checks: { requiredKeys: [], runs: projectCheckRuns },
    freshEvidenceExists,
    workers: workers
      .filter((entry) => entry.countsTowardProject)
      .map((entry) => ({ label: entry.evidence.input.label, report: entry.report })),
    openAttention: {
      high: openAttention.filter((item) => item.priority === "high").length,
      normal: openAttention.filter((item) => item.priority === "normal").length,
    },
  });

  return { project: report, workers, computedAt: now.toISOString() };
}
