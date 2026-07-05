// The thin evidence adapter (chunk 4): SQLite rows and git observations in,
// pure confidence-engine inputs out. This is the ONLY place that decides how
// a digest claim resolves against evidence runs — the engine scores what it
// is told, the UI badges what this module linked.
import { checkLane } from "../../core/lanes/lane-check";
import type {
  CheckEvidence,
  ClaimVerification,
  WorkerConfidenceInput,
  WorkerLiveness,
} from "../../core/confidence/types";
import type { CompletionClaim } from "../../core/digests/completion";
import type { GalapagosDb } from "../db/db";
import { laneGlobs, type LaneRow } from "../db/repos/lanes";
import type { WorkerRow } from "../db/repos/workers";
import { latestDigestForWorker } from "../db/repos/digests";
import { latestRunsByKey, type CheckKey, type EvidenceRunRow } from "../db/repos/evidence";
import { collectAuditFiles } from "../agent/worker-runtime";
import { configuredCheckKeys } from "../checks/run-checks";
import { observeWorkspaceEvidence } from "./workspace";

/**
 * The checks a completion claim demands (user-confirmed 2026-07-05:
 * typecheck, test and build; lint stays optional). Only checks the repo
 * actually configures can be demanded — a project without a build script is
 * not blocked on a build that cannot exist.
 */
export const REQUIRED_ON_COMPLETION: readonly CheckKey[] = ["typecheck", "test", "build"];

const HARD_EVIDENCE_KINDS: readonly string[] = ["typecheck", "lint", "test", "build"];

export type LinkedClaim = {
  text: string;
  evidenceKind: string;
  files: string[];
  verification: ClaimVerification;
  /** The evidence run this claim resolved against, when one exists. */
  evidenceRunId: string | null;
  /** Why the badge says what it says — rendered, never fabricated. */
  reason: string;
};

/**
 * Resolve digest claims against the evidence pool (architecture §3: link
 * each claim to its run). Hard kinds resolve against the latest run of that
 * kind; diff claims resolve mechanically against what actually changed;
 * manual claims are honestly unverifiable.
 */
export function linkClaims(input: {
  claims: CompletionClaim[];
  latestRuns: Map<CheckKey, EvidenceRunRow>;
  /** The workspace's current evidence key; null = state unobservable. */
  workspaceKey: string | null;
  /** Every file changed since the lane base; null = audit unavailable. */
  changedFiles: string[] | null;
}): LinkedClaim[] {
  return input.claims.map((claim) => {
    const base = {
      text: claim.text,
      evidenceKind: claim.evidence_kind,
      files: claim.files,
    };

    if (claim.evidence_kind === "manual") {
      return {
        ...base,
        verification: "unverified" as const,
        evidenceRunId: null,
        reason: "Manually verified by the worker — no run to check against.",
      };
    }

    if (claim.evidence_kind === "diff") {
      if (input.changedFiles === null) {
        return {
          ...base,
          verification: "unverified" as const,
          evidenceRunId: null,
          reason: "The change audit is unavailable, so the claimed diff cannot be checked.",
        };
      }
      if (claim.files.length === 0) {
        return {
          ...base,
          verification: "unverified" as const,
          evidenceRunId: null,
          reason: "The claim names no files, so there is nothing to check against the diff.",
        };
      }
      const changed = new Set(input.changedFiles);
      const missing = claim.files.filter((file) => !changed.has(file));
      if (missing.length === 0) {
        return {
          ...base,
          verification: "verified" as const,
          evidenceRunId: null,
          reason: "Every claimed file really changed since the lane base.",
        };
      }
      return {
        ...base,
        verification: "contradicted" as const,
        evidenceRunId: null,
        reason: `Claimed files never changed: ${missing.join(", ")}.`,
      };
    }

    if (!HARD_EVIDENCE_KINDS.includes(claim.evidence_kind)) {
      return {
        ...base,
        verification: "unverified" as const,
        evidenceRunId: null,
        reason: `Unknown evidence kind "${claim.evidence_kind}".`,
      };
    }

    const run = input.latestRuns.get(claim.evidence_kind as CheckKey);
    if (!run) {
      return {
        ...base,
        verification: "unsupported" as const,
        evidenceRunId: null,
        reason: `No ${claim.evidence_kind} run exists for this worker — the claim stands on nothing.`,
      };
    }
    const fresh = input.workspaceKey !== null && run.head_sha === input.workspaceKey;
    if (!fresh) {
      return {
        ...base,
        verification: "unverified" as const,
        evidenceRunId: run.id,
        reason:
          input.workspaceKey === null
            ? "The workspace state is unobservable, so the run's freshness is unknown."
            : "The linked run predates the current workspace state — expired evidence proves nothing either way.",
      };
    }
    if (run.status === "passed") {
      return {
        ...base,
        verification: "verified" as const,
        evidenceRunId: run.id,
        reason: `Fresh passing ${claim.evidence_kind} run (${run.summary}).`,
      };
    }
    return {
      ...base,
      verification: "contradicted" as const,
      evidenceRunId: run.id,
      reason: `The fresh ${claim.evidence_kind} run FAILED (${run.summary}) — the claim is contradicted.`,
    };
  });
}

function toCheckEvidence(
  latestRuns: Map<CheckKey, EvidenceRunRow>,
  workspaceKey: string | null,
  requiredKeys: CheckKey[],
): CheckEvidence {
  return {
    requiredKeys: [...requiredKeys],
    runs: Array.from(latestRuns.values()).map((run) => ({
      key: run.check_key,
      status: run.status,
      fresh: workspaceKey !== null && run.head_sha === workspaceKey,
    })),
  };
}

export type WorkerEvidence = {
  input: WorkerConfidenceInput;
  linkedClaims: LinkedClaim[];
  /** Files changed since the lane base; null when the audit could not run. */
  auditFiles: string[] | null;
  workspaceKey: string | null;
  digestId: string | null;
  digestStatus: string | null;
};

/**
 * Assemble one worker's confidence input from what is actually observable:
 * its row, its lane, its worktree, its digest, its evidence runs. Every
 * unobservable piece degrades to an explicit "could not run/observe" —
 * never to silence.
 */
export async function buildWorkerEvidence(
  db: GalapagosDb,
  args: {
    worker: WorkerRow;
    lane: LaneRow | null;
    staleWorkerSeconds: number;
    now?: Date;
  },
): Promise<WorkerEvidence> {
  const { worker, lane } = args;
  const now = args.now ?? new Date();

  let liveness: WorkerLiveness;
  if (worker.status === "failed") {
    liveness = { kind: "failed" };
  } else if (worker.status === "stopped") {
    liveness = { kind: "stopped" };
  } else {
    // Silence only counts against a worker that claims to be working;
    // awaiting_input and idle are silent by design.
    const silenceApplies = worker.status === "running" || worker.status === "spawning";
    const lastSignal = worker.last_message_at ?? worker.created_at;
    const seconds = Math.max(0, (now.getTime() - Date.parse(lastSignal)) / 1000);
    liveness = {
      kind: "live",
      stale: silenceApplies && seconds > args.staleWorkerSeconds,
      secondsSinceLastMessage: worker.last_message_at === null ? null : seconds,
      staleThresholdSeconds: args.staleWorkerSeconds,
    };
  }

  let workspaceKey: string | null = null;
  try {
    workspaceKey = (await observeWorkspaceEvidence(worker.worktree_path)).key;
  } catch {
    workspaceKey = null;
  }

  let auditFiles: string[] | null = null;
  let laneAudit: WorkerConfidenceInput["laneAudit"];
  if (!lane) {
    laneAudit = { ran: false, reason: "the lane record is missing" };
  } else {
    try {
      auditFiles = await collectAuditFiles(worker.worktree_path, lane.base_sha);
      laneAudit = {
        ran: true,
        violations: checkLane(auditFiles, laneGlobs(lane)).map((violation) => violation.path),
      };
    } catch (error) {
      laneAudit = {
        ran: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const digest = latestDigestForWorker(db, worker.id);
  const claims: CompletionClaim[] = digest
    ? (JSON.parse(digest.claims) as CompletionClaim[])
    : [];
  const latestRuns = latestRunsByKey(db, { projectId: worker.project_id, workerId: worker.id });
  const linkedClaims = linkClaims({
    claims,
    latestRuns,
    workspaceKey,
    changedFiles: auditFiles,
  });

  // Completion demands evidence; in-progress work is not born blocked.
  const configured = configuredCheckKeys(worker.worktree_path);
  const requiredKeys = digest
    ? REQUIRED_ON_COMPLETION.filter((key) => configured.includes(key))
    : [];

  return {
    input: {
      label: lane?.name ?? worker.id.slice(0, 8),
      liveness,
      laneAudit,
      hasDigest: digest !== undefined,
      claims: linkedClaims.map((claim) => ({
        text: claim.text,
        evidenceKind: claim.evidenceKind,
        verification: claim.verification,
      })),
      checks: toCheckEvidence(latestRuns, workspaceKey, requiredKeys),
    },
    linkedClaims,
    auditFiles,
    workspaceKey,
    digestId: digest?.id ?? null,
    digestStatus: digest?.status ?? null,
  };
}
