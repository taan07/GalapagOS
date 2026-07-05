// Confidence for the UI: the same computation the daemon's monitor and the
// triage seed use, mapped to view types. Read-only — SQLite reads plus
// read-only git observation of worktrees; no writes, no daemon round-trip.
import { config } from "../config";
import type { GalapagosDb } from "../adapters/db/db";
import type { ProjectRow } from "../adapters/db/repos/projects";
import { computeProjectConfidence } from "../adapters/evidence/confidence";
import type { ConfidenceReport } from "../core/confidence/types";
import type { ConfidenceReportView, ProjectConfidenceView } from "../ui/types";

function toReportView(report: ConfidenceReport): ConfidenceReportView {
  return {
    score: report.score,
    state: report.state,
    uncappedScore: report.uncappedScore,
    signals: report.signals,
    caps: report.caps,
    stateReason: report.stateReason,
  };
}

export async function projectConfidenceView(
  db: GalapagosDb,
  project: ProjectRow,
): Promise<ProjectConfidenceView> {
  const confidence = await computeProjectConfidence(db, {
    project,
    staleWorkerSeconds: config.staleWorkerSeconds,
  });
  return {
    project: toReportView(confidence.project),
    workers: confidence.workers.map((entry) => ({
      workerId: entry.worker.id,
      laneName: entry.lane?.name ?? null,
      report: toReportView(entry.report),
      countsTowardProject: entry.countsTowardProject,
      claimLinks: entry.evidence.linkedClaims.map((claim) => ({
        text: claim.text,
        evidenceKind: claim.evidenceKind,
        verification: claim.verification,
        reason: claim.reason,
      })),
    })),
    computedAt: confidence.computedAt,
  };
}
