// Typed inputs and the explainable report of the confidence engine
// (architecture §9). Everything here is pure data: adapters translate SQLite
// rows and git observations into these shapes; the engine never sees I/O.

/**
 * Confidence measures INTERVENTION NEED, not progress (architecture §9):
 * strong = proceed without a second thought; steady = fine, keep half an eye;
 * draining = trust is leaking (staleness, silence) and will keep dropping;
 * blocked = do not proceed on this — a trust-critical failure is standing.
 */
export type ConfidenceState = "strong" | "steady" | "draining" | "blocked";

/**
 * The engine's independent evidence legs (user-confirmed 2026-07-05): four
 * "brains" that cannot all be fooled the same way, each its own module,
 * each visible in the report. facts = deterministic evidence bookkeeping
 * (checks, freshness, lanes, liveness); tripwires = deterministic
 * test-integrity patterns; watchdog = a cheap model reading the worker's
 * transcript; critic = blinded independent critique of diff-vs-brief.
 */
export type ConfidenceLeg = "facts" | "tripwires" | "watchdog" | "critic";

/** One accumulating contribution to the score, positive or negative. */
export type ConfidenceSignal = {
  id: string;
  /** Which leg produced this signal. */
  leg: ConfidenceLeg;
  /** The human reason — every number explains itself (§9, non-negotiable). */
  label: string;
  delta: number;
};

/**
 * A hard ceiling a pile of positive signals cannot overcome. `blocking`
 * forces the blocked state; `draining` marks trust actively leaking.
 */
export type ConfidenceCap = {
  id: string;
  leg: ConfidenceLeg;
  label: string;
  capTo: number;
  blocking: boolean;
  draining: boolean;
};

export type ConfidenceReport = {
  score: number;
  state: ConfidenceState;
  /** What the positives summed to before any ceiling — debug drilldown only. */
  uncappedScore: number;
  signals: ConfidenceSignal[];
  /** Every ACTIVE cap, lowest first — the first entry is the binding one. */
  caps: ConfidenceCap[];
  /** One sentence naming why the state is what it is. */
  stateReason: string;
};

/**
 * How a digest claim resolved against evidence (the evidence adapter decides;
 * the engine only scores):
 * - verified: a fresh passing run of the claimed kind backs it (or a diff
 *   claim whose files really changed).
 * - unverified: honestly unprovable — a manual claim, or evidence that has
 *   since gone stale. Contributes nothing either way.
 * - unsupported: the claim cites hard evidence (typecheck/lint/test/build)
 *   that simply does not exist. Lowers — honesty is observable support.
 * - contradicted: a fresh run of the claimed kind FAILED, or a diff claim
 *   names files that never changed. Caps hard (§9: ≈40/blocked).
 */
export type ClaimVerification = "verified" | "unverified" | "unsupported" | "contradicted";

export type ClaimEvidence = {
  text: string;
  evidenceKind: string;
  verification: ClaimVerification;
};

export type CheckRunEvidence = {
  key: string;
  status: "passed" | "failed";
  /**
   * True when the run's evidence key still matches the workspace — same
   * HEAD, same dirty state. Any commit or edit since the run makes it stale.
   */
  fresh: boolean;
};

export type CheckEvidence = {
  /**
   * Checks DEMANDED right now. A missing or failed required check blocks;
   * required-ness is the caller's policy (Galapagos demands typecheck/test/
   * build once a worker claims completion — nothing before that).
   */
  requiredKeys: string[];
  /** The latest run per key. Absent key = that check never ran. */
  runs: CheckRunEvidence[];
};

export type WorkerLiveness =
  | {
      kind: "live";
      stale: boolean;
      secondsSinceLastMessage: number | null;
      staleThresholdSeconds: number;
    }
  | { kind: "stopped" }
  | { kind: "failed" };

export type LaneAuditEvidence =
  | { ran: true; violations: string[] }
  | { ran: false; reason: string };

/**
 * One deterministic test-integrity finding (the tripwires leg). "alert" =
 * the check machinery itself was touched in a way that can fake a pass —
 * blocks; "warn" = legitimate-looking but review-worthy (e.g. the worker
 * edited tests that judge its own code) — lowers and flags for the critic.
 */
export type TripwireFinding = {
  id: string;
  severity: "alert" | "warn";
  label: string;
  paths: string[];
};

export type IntegrityInput =
  | { available: true; tripwires: TripwireFinding[] }
  | { available: false; reason: string };

/**
 * The watchdog leg's verdict over the worker's transcript. Applicable only
 * once completion is claimed (null before that). `fresh` compares the
 * verdict's evidence key to the workspace — a verdict predating new work
 * proves nothing about it.
 */
export type WatchdogInput =
  | { status: "pending" }
  | { status: "unavailable"; reason: string }
  | {
      status: "reviewed";
      verdict: "clean" | "suspicious" | "gaming";
      fresh: boolean;
      summary: string;
      /** Verbatim transcript quotes backing the verdict — the proof travels
       * with the accusation (coverage audit 2026-07-05: write-only quotes). */
      evidence: string[];
    };

export type CriticFindingInput = {
  severity: "blocker" | "major" | "minor";
  label: string;
};

/** The blinded-critic leg's verdict. Applicable only once completion is claimed. */
export type CriticInput =
  | { status: "pending" }
  | { status: "unavailable"; reason: string }
  | {
      status: "reviewed";
      verdict: "approve" | "needs_work" | "reject";
      fresh: boolean;
      findings: CriticFindingInput[];
      summary: string;
    };

export type WorkerConfidenceInput = {
  /** How the report names this worker, e.g. its lane name. */
  label: string;
  liveness: WorkerLiveness;
  laneAudit: LaneAuditEvidence;
  hasDigest: boolean;
  /** Claims from the latest digest; [] when there is no digest. */
  claims: ClaimEvidence[];
  checks: CheckEvidence;
  /** The tripwires leg — deterministic, computed whenever the audit can run. */
  integrity: IntegrityInput;
  /** The watchdog leg; null = not applicable (no completion claimed yet). */
  watchdog: WatchdogInput | null;
  /** The critic leg; null = not applicable (no completion claimed yet). */
  critic: CriticInput | null;
};

export type ProjectClarity = {
  hasSynthesis: boolean;
  hasActiveGoal: boolean;
  openQuestionCount: number;
};

export type ProjectConfidenceInput = {
  clarity: ProjectClarity;
  /** Project-level evidence runs (worker_id null), against the project HEAD. */
  checks: CheckEvidence;
  /**
   * True when ANY fresh passing evidence exists — project-level or inside
   * any worker's report. Without it, records alone cap below strong (§9).
   */
  freshEvidenceExists: boolean;
  workers: { label: string; report: ConfidenceReport }[];
  openAttention: { high: number; normal: number };
};
