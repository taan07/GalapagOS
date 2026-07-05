// The pure confidence engine (architecture §9). Positive signals accumulate
// a score; trust-critical failures apply hard caps that no pile of positives
// can overcome; every signal and cap carries its reason AND the leg that
// produced it — the engine aggregates four independent "brains"
// (user-confirmed 2026-07-05): deterministic facts, test-integrity
// tripwires, the transcript watchdog, and the blinded critic. The §9 gold
// scenarios in tests/confidence-engine.test.ts ARE the specification — a
// change that breaks one of them is wrong until the contract itself changes.
import type {
  CheckEvidence,
  ConfidenceCap,
  ConfidenceReport,
  ConfidenceSignal,
  ConfidenceState,
  CriticInput,
  IntegrityInput,
  ProjectConfidenceInput,
  WatchdogInput,
  WorkerConfidenceInput,
} from "./types";

const STRONG_THRESHOLD = 80;
const STEADY_THRESHOLD = 45;

/** §9: contradictions cap hard at ≈40/blocked. */
const CONTRADICTION_CAP = 40;
/** A missing or failed required check is a harder stop than a contradiction. */
const REQUIRED_CHECK_CAP = 30;
const FAILED_SESSION_CAP = 30;
const LANE_VIOLATION_CAP = 40;
/** Corrupting the machinery that judges you is a contradiction-class breach. */
const INTEGRITY_ALERT_CAP = 40;
const WATCHDOG_GAMING_CAP = 40;
const CRITIC_REJECT_CAP = 40;
const STALE_WORKER_CAP = 55;
const WATCHDOG_SUSPICIOUS_CAP = 60;
const AUDIT_UNAVAILABLE_CAP = 60;
/** A leg that could not run is missing evidence — never quiet health. */
const LEG_UNAVAILABLE_CAP = 60;
const STALE_EVIDENCE_CAP = 65;
/** Critique found real (non-blocking) issues — below strong until addressed. */
const CRITIC_NEEDS_WORK_CAP = 70;
/** Claims and records alone — real evidence is what reaches strong. */
const NO_FRESH_EVIDENCE_CAP_WORKER = 70;
/** A completion nobody independent has reviewed yet cannot be strong. */
const LEG_PENDING_CAP = 72;
const NO_FRESH_EVIDENCE_CAP_PROJECT = 75;
const BLOCKED_WORKER_PROJECT_CAP = 60;
const DRAINING_WORKER_PROJECT_CAP = 72;

function buildReport(signals: ConfidenceSignal[], caps: ConfidenceCap[]): ConfidenceReport {
  const uncapped = Math.round(signals.reduce((sum, signal) => sum + signal.delta, 0));
  const clamped = Math.max(0, Math.min(100, uncapped));
  const sortedCaps = [...caps].sort((a, b) => a.capTo - b.capTo);
  const binding = sortedCaps[0];
  const score = binding ? Math.min(clamped, binding.capTo) : clamped;

  const blockingCap = sortedCaps.find((cap) => cap.blocking);
  const drainingCap = sortedCaps.find((cap) => cap.draining);

  // Draining means trust is ACTIVELY leaking (staleness, silence) — a low
  // but stable score is honest steady; the number itself says how little is
  // known. Verified live 2026-07-05: a fresh project with no records yet
  // must not read "needs eyes soon" while everything observable is healthy.
  let state: ConfidenceState;
  let stateReason: string;
  if (blockingCap) {
    state = "blocked";
    stateReason = blockingCap.label;
  } else if (drainingCap) {
    state = "draining";
    stateReason = drainingCap.label;
  } else if (score >= STRONG_THRESHOLD) {
    state = "strong";
    stateReason = "Fresh evidence backs the work — proceed.";
  } else if (score >= STEADY_THRESHOLD) {
    state = "steady";
    const capNote = binding ? ` (${binding.label})` : "";
    stateReason = `No standing failures, but not evidenced enough for strong${capNote}.`;
  } else {
    state = "steady";
    stateReason =
      "Nothing is failing or leaking — the score is low because little is recorded or evidenced yet.";
  }

  return { score, state, uncappedScore: uncapped, signals, caps: sortedCaps, stateReason };
}

/**
 * Score the check evidence shared by workers and projects: fresh passes
 * accumulate, required gaps block, optional failures lower, staleness drains.
 */
function scoreChecks(
  checks: CheckEvidence,
  signals: ConfidenceSignal[],
  caps: ConfidenceCap[],
): void {
  const runsByKey = new Map(checks.runs.map((run) => [run.key, run]));

  for (const key of checks.requiredKeys) {
    const run = runsByKey.get(key);
    if (!run) {
      caps.push({
        id: `check.required-missing.${key}`,
        leg: "facts",
        label: `Required check "${key}" has never run — completion is claimed without it.`,
        capTo: REQUIRED_CHECK_CAP,
        blocking: true,
        draining: false,
      });
      continue;
    }
    if (run.status === "failed") {
      caps.push({
        id: `check.required-failed.${key}`,
        leg: "facts",
        label: run.fresh
          ? `Required check "${key}" failed.`
          : `Required check "${key}" failed on its last run and has not been re-run since the code changed.`,
        capTo: REQUIRED_CHECK_CAP,
        blocking: true,
        draining: false,
      });
    }
  }

  for (const run of checks.runs) {
    if (run.status === "passed" && run.fresh) {
      signals.push({
        id: `check.fresh-pass.${run.key}`,
        leg: "facts",
        label: `Fresh passing ${run.key} run against the current state.`,
        delta: 12,
      });
    } else if (run.status === "passed" && !run.fresh) {
      caps.push({
        id: `check.stale.${run.key}`,
        leg: "facts",
        label: `The ${run.key} evidence predates the current head/dirty state — stale until re-run.`,
        capTo: STALE_EVIDENCE_CAP,
        blocking: false,
        draining: true,
      });
    } else if (run.status === "failed" && !checks.requiredKeys.includes(run.key)) {
      signals.push({
        id: `check.optional-failed.${run.key}`,
        leg: "facts",
        label: `Optional check "${run.key}" failed${run.fresh ? "" : " (stale run)"}.`,
        delta: -15,
      });
    }
  }
}

/** The tripwires leg: deterministic test-integrity patterns. */
function scoreIntegrity(
  integrity: IntegrityInput,
  signals: ConfidenceSignal[],
  caps: ConfidenceCap[],
): void {
  if (!integrity.available) {
    caps.push({
      id: "tripwires.unavailable",
      leg: "tripwires",
      label: `Test-integrity signals could not be computed (${integrity.reason}) — missing evidence is not quiet health.`,
      capTo: LEG_UNAVAILABLE_CAP,
      blocking: false,
      draining: true,
    });
    return;
  }
  let warns = 0;
  for (const finding of integrity.tripwires) {
    if (finding.severity === "alert") {
      caps.push({
        id: `tripwires.${finding.id}`,
        leg: "tripwires",
        label: `Test-integrity tripwire: ${finding.label} (${finding.paths.join(", ")}).`,
        capTo: INTEGRITY_ALERT_CAP,
        blocking: true,
        draining: false,
      });
    } else {
      warns += 1;
      if (warns <= 3) {
        signals.push({
          id: `tripwires.${finding.id}`,
          leg: "tripwires",
          label: `Integrity warning: ${finding.label} (${finding.paths.join(", ")}).`,
          delta: -10,
        });
      }
    }
  }
  if (integrity.tripwires.length === 0) {
    signals.push({
      id: "tripwires.clean",
      leg: "tripwires",
      label: "No test-integrity tripwires fired.",
      delta: 4,
    });
  }
}

/** The watchdog leg: a cheap model's read of the worker's transcript. */
function scoreWatchdog(
  watchdog: WatchdogInput,
  signals: ConfidenceSignal[],
  caps: ConfidenceCap[],
): void {
  if (watchdog.status === "pending") {
    caps.push({
      id: "watchdog.pending",
      leg: "watchdog",
      label: "Transcript review pending — a completion nobody independent has read cannot be strong.",
      capTo: LEG_PENDING_CAP,
      blocking: false,
      draining: false,
    });
    return;
  }
  if (watchdog.status === "unavailable") {
    caps.push({
      id: "watchdog.unavailable",
      leg: "watchdog",
      label: `The transcript watchdog could not run (${watchdog.reason}) — missing evidence is not quiet health.`,
      capTo: LEG_UNAVAILABLE_CAP,
      blocking: false,
      draining: true,
    });
    return;
  }
  if (!watchdog.fresh) {
    caps.push({
      id: "watchdog.stale",
      leg: "watchdog",
      label: "The watchdog verdict predates the current workspace state — re-review needed.",
      capTo: LEG_PENDING_CAP,
      blocking: false,
      draining: false,
    });
    return;
  }
  if (watchdog.verdict === "gaming") {
    caps.push({
      id: "watchdog.gaming",
      leg: "watchdog",
      label: `The watchdog flagged the transcript for gaming the checks: ${watchdog.summary}`,
      capTo: WATCHDOG_GAMING_CAP,
      blocking: true,
      draining: false,
    });
    return;
  }
  if (watchdog.verdict === "suspicious") {
    caps.push({
      id: "watchdog.suspicious",
      leg: "watchdog",
      label: `The watchdog found the transcript suspicious: ${watchdog.summary}`,
      capTo: WATCHDOG_SUSPICIOUS_CAP,
      blocking: false,
      draining: true,
    });
    return;
  }
  signals.push({
    id: "watchdog.clean",
    leg: "watchdog",
    label: "Transcript reviewed clean by the watchdog.",
    delta: 5,
  });
}

/** The critic leg: blinded independent critique of the diff against the brief. */
function scoreCritic(
  critic: CriticInput,
  signals: ConfidenceSignal[],
  caps: ConfidenceCap[],
): void {
  if (critic.status === "pending") {
    caps.push({
      id: "critic.pending",
      leg: "critic",
      label: "Independent critique pending — unreviewed completion cannot be strong.",
      capTo: LEG_PENDING_CAP,
      blocking: false,
      draining: false,
    });
    return;
  }
  if (critic.status === "unavailable") {
    caps.push({
      id: "critic.unavailable",
      leg: "critic",
      label: `The critic could not run (${critic.reason}) — missing evidence is not quiet health.`,
      capTo: LEG_UNAVAILABLE_CAP,
      blocking: false,
      draining: true,
    });
    return;
  }
  if (!critic.fresh) {
    caps.push({
      id: "critic.stale",
      leg: "critic",
      label: "The critique predates the current workspace state — re-review needed.",
      capTo: LEG_PENDING_CAP,
      blocking: false,
      draining: false,
    });
    return;
  }

  const blockers = critic.findings.filter((finding) => finding.severity === "blocker");
  if (critic.verdict === "reject" || blockers.length > 0) {
    const named = blockers[0]?.label ?? critic.summary;
    caps.push({
      id: "critic.reject",
      leg: "critic",
      label: `Independent critique rejects the work: ${named}`,
      capTo: CRITIC_REJECT_CAP,
      blocking: true,
      draining: false,
    });
    return;
  }
  if (critic.verdict === "needs_work") {
    caps.push({
      id: "critic.needs-work",
      leg: "critic",
      label: `Independent critique found issues to address: ${critic.summary}`,
      capTo: CRITIC_NEEDS_WORK_CAP,
      blocking: false,
      draining: false,
    });
  }
  let majors = 0;
  let minors = 0;
  for (const finding of critic.findings) {
    if (finding.severity === "major" && majors < 3) {
      majors += 1;
      signals.push({
        id: `critic.major.${majors}`,
        leg: "critic",
        label: `Critic (major): ${finding.label}`,
        delta: -10,
      });
    } else if (finding.severity === "minor" && minors < 4) {
      minors += 1;
      signals.push({
        id: `critic.minor.${minors}`,
        leg: "critic",
        label: `Critic (minor): ${finding.label}`,
        delta: -3,
      });
    }
  }
  if (critic.verdict === "approve") {
    signals.push({
      id: "critic.approve",
      leg: "critic",
      label: "Independent critique found nothing blocking against the brief.",
      delta: 8,
    });
  }
}

export function scoreWorker(input: WorkerConfidenceInput): ConfidenceReport {
  const signals: ConfidenceSignal[] = [];
  const caps: ConfidenceCap[] = [];

  switch (input.liveness.kind) {
    case "live":
      signals.push({
        id: "liveness.live",
        leg: "facts",
        label: "Worker session is live.",
        delta: 40,
      });
      if (input.liveness.stale) {
        const seconds = input.liveness.secondsSinceLastMessage;
        caps.push({
          id: "liveness.stale",
          leg: "facts",
          label: `Worker has been silent for ${seconds === null ? "its whole life" : `${Math.round(seconds)}s`} (threshold ${input.liveness.staleThresholdSeconds}s).`,
          capTo: STALE_WORKER_CAP,
          blocking: false,
          draining: true,
        });
      }
      break;
    case "stopped":
      signals.push({
        id: "liveness.stopped",
        leg: "facts",
        label: "Worker session ended by request — its work rests in the worktree.",
        delta: 40,
      });
      break;
    case "failed":
      signals.push({
        id: "liveness.failed",
        leg: "facts",
        label: "Worker session failed.",
        delta: 15,
      });
      caps.push({
        id: "liveness.failed",
        leg: "facts",
        label: "The session failed and will not be retried — review the worktree and respawn.",
        capTo: FAILED_SESSION_CAP,
        blocking: true,
        draining: false,
      });
      break;
  }

  if (input.laneAudit.ran) {
    if (input.laneAudit.violations.length === 0) {
      signals.push({
        id: "lane.clean",
        leg: "facts",
        label: "Lane audit clean — every change matches the lane contract.",
        delta: 10,
      });
    } else {
      caps.push({
        id: "lane.violation",
        leg: "facts",
        label: `Out-of-lane changes contradict the lane contract: ${input.laneAudit.violations.join(", ")}.`,
        capTo: LANE_VIOLATION_CAP,
        blocking: true,
        draining: false,
      });
    }
  } else {
    caps.push({
      id: "lane.audit-unavailable",
      leg: "facts",
      label: `The lane audit could not run (${input.laneAudit.reason}) — missing evidence is not quiet health.`,
      capTo: AUDIT_UNAVAILABLE_CAP,
      blocking: false,
      draining: true,
    });
  }

  if (input.hasDigest) {
    signals.push({
      id: "digest.present",
      leg: "facts",
      label: "A structured completion report was parsed.",
      delta: 10,
    });
  }

  let verifiedClaims = 0;
  for (const claim of input.claims) {
    if (claim.verification === "verified") {
      verifiedClaims += 1;
      if (verifiedClaims <= 3) {
        signals.push({
          id: `claim.verified.${verifiedClaims}`,
          leg: "facts",
          label: `Claim verified by ${claim.evidenceKind} evidence: "${claim.text}".`,
          delta: 4,
        });
      }
    } else if (claim.verification === "unsupported") {
      signals.push({
        id: "claim.unsupported",
        leg: "facts",
        label: `Claim cites ${claim.evidenceKind} evidence that does not exist: "${claim.text}".`,
        delta: -8,
      });
    } else if (claim.verification === "contradicted") {
      caps.push({
        id: "claim.contradicted",
        leg: "facts",
        label: `Claim contradicted by evidence: "${claim.text}".`,
        capTo: CONTRADICTION_CAP,
        blocking: true,
        draining: false,
      });
    }
    // "unverified" (manual claims, expired evidence) contributes nothing:
    // honest absence of proof is neither reward nor punishment.
  }

  scoreChecks(input.checks, signals, caps);
  scoreIntegrity(input.integrity, signals, caps);
  // The judgment legs apply once completion is claimed — in-progress work is
  // not penalized for reviews that are not due yet.
  if (input.watchdog !== null) {
    scoreWatchdog(input.watchdog, signals, caps);
  }
  if (input.critic !== null) {
    scoreCritic(input.critic, signals, caps);
  }

  const anyFreshPass = input.checks.runs.some((run) => run.fresh && run.status === "passed");
  if (!anyFreshPass) {
    caps.push({
      id: "evidence.none-fresh",
      leg: "facts",
      label: "No fresh passing evidence — claims and reports alone cannot reach strong.",
      capTo: NO_FRESH_EVIDENCE_CAP_WORKER,
      blocking: false,
      draining: false,
    });
  }

  return buildReport(signals, caps);
}

export function scoreProject(input: ProjectConfidenceInput): ConfidenceReport {
  const signals: ConfidenceSignal[] = [];
  const caps: ConfidenceCap[] = [];

  signals.push({
    id: "project.base",
    leg: "facts",
    label: "Project registered and under observation.",
    delta: 15,
  });

  if (input.clarity.hasSynthesis) {
    signals.push({
      id: "clarity.synthesis",
      leg: "facts",
      label: "A manager synthesis records the project understanding.",
      delta: 15,
    });
  }
  if (input.clarity.hasActiveGoal) {
    signals.push({
      id: "clarity.goal",
      leg: "facts",
      label: "An active goal is recorded.",
      delta: 15,
    });
  }
  if (input.clarity.openQuestionCount === 0) {
    signals.push({
      id: "clarity.no-open-questions",
      leg: "facts",
      label: "No open questions await the user.",
      delta: 10,
    });
  } else {
    signals.push({
      id: "clarity.open-questions",
      leg: "facts",
      label: `${input.clarity.openQuestionCount} open question${input.clarity.openQuestionCount === 1 ? "" : "s"} still unanswered.`,
      delta: -3 * Math.min(input.clarity.openQuestionCount, 4),
    });
  }

  scoreChecks(input.checks, signals, caps);

  if (!input.freshEvidenceExists) {
    caps.push({
      id: "evidence.records-alone",
      leg: "facts",
      label: "Records and claims alone — no fresh passing evidence anywhere. Strong requires real evidence.",
      capTo: NO_FRESH_EVIDENCE_CAP_PROJECT,
      blocking: false,
      draining: false,
    });
  }

  if (input.workers.length > 0) {
    const risky = input.workers.filter(
      (worker) => worker.report.state === "blocked" || worker.report.state === "draining",
    );
    if (risky.length === 0) {
      signals.push({
        id: "workers.healthy",
        leg: "facts",
        label: `All ${input.workers.length} worker${input.workers.length === 1 ? "" : "s"} healthy.`,
        delta: 10,
      });
    } else {
      // §9: one risky worker lowers project confidence even when the others
      // are healthy. The worst one names the cap.
      const worst = risky.reduce((lowest, worker) =>
        worker.report.score < lowest.report.score ? worker : lowest,
      );
      const blocked = worst.report.state === "blocked";
      caps.push({
        id: blocked ? "workers.blocked" : "workers.draining",
        leg: "facts",
        label: `Worker "${worst.label}" is ${worst.report.state}: ${worst.report.stateReason}`,
        capTo: blocked ? BLOCKED_WORKER_PROJECT_CAP : DRAINING_WORKER_PROJECT_CAP,
        blocking: false,
        draining: true,
      });
    }
  }

  if (input.openAttention.high > 0) {
    signals.push({
      id: "attention.high",
      leg: "facts",
      label: `${input.openAttention.high} high-priority attention item${input.openAttention.high === 1 ? "" : "s"} open.`,
      delta: -10 * Math.min(input.openAttention.high, 3),
    });
  }
  if (input.openAttention.normal > 0) {
    signals.push({
      id: "attention.normal",
      leg: "facts",
      label: `${input.openAttention.normal} open attention item${input.openAttention.normal === 1 ? "" : "s"} awaiting review.`,
      delta: -3 * Math.min(input.openAttention.normal, 4),
    });
  }

  return buildReport(signals, caps);
}
