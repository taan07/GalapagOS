// View types for the UI layer. The UI never imports adapters — these mirror
// the shapes served by the route handlers.
export type ProjectView = {
  id: string;
  name: string;
  slug: string;
  root_path: string;
  created_at: string;
};

export type TurnView = {
  id: string;
  turn_index: number;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  created_at: string;
};

export type SpecificView = {
  fileName: string;
  question: string;
  answer: string;
  status: "agreed" | "superseded" | "deferred";
  createdAt: string;
};

export type ToolChip = {
  tool: string;
  summary: string;
  detail: string;
};

export type RebriefView = {
  /** Turn id the clear action targets; null for pre-persistence events. */
  turnId: string | null;
  reason: string;
  /** Full seed text; null when there were no records to seed from. */
  preamble: string | null;
  cleared: boolean;
};

export type DecisionOptionView = { label: string; implication: string };

/** One question of a batch card — select-only (free text goes to the chat). */
export type DecisionFieldView = {
  id: string;
  prompt: string;
  options: DecisionOptionView[];
  multiSelect: boolean;
};

/** How a card presents: single decision, batch of questions, or a confirm. */
export type DecisionCardKind = "decision" | "batch" | "confirm";

/** A card Darwin put to the user in chat (ask_user / ask_batch /
 * confirm_understanding / amend_lane gate). */
export type DecisionView = {
  decisionId: string;
  /** Absent on cards persisted before 2026-07-08 → treat as "decision". */
  cardKind?: DecisionCardKind;
  question: string;
  options: DecisionOptionView[];
  multiSelect: boolean;
  /** Batch questions (empty for single decisions and confirms). */
  fields?: DecisionFieldView[];
  status: "pending" | "answered" | "timeout" | "interrupted" | "expired";
  selections: string[];
  /** Per-field selected labels for a batch, keyed by field id. */
  responses?: Record<string, string[]>;
  custom: string;
};

/** A message waiting its turn while Darwin works — visible and steerable. */
export type QueuedMessage = { id: string; text: string };

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "chip"; chip: ToolChip }
  | { kind: "rebrief"; rebrief: RebriefView }
  | { kind: "decision"; decision: DecisionView }
  | { kind: "note"; text: string }
  /** A usage-limit failure with a retry-on-Opus offer (see turn_error). */
  | { kind: "limit"; message: string; failedText: string; model: string };

export type ManagerStreamEvent =
  | { type: "turn_started"; sessionId: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_use"; tool: string; summary: string; detail: string }
  | { type: "rebrief"; reason: string; preamble: string | null; turnId: string | null }
  | { type: "turn_complete"; resultText: string; sdkSessionId: string | null }
  | { type: "interrupted"; message: string }
  | {
      type: "decision_request";
      turnId: string;
      decisionId: string;
      cardKind: DecisionCardKind;
      question: string;
      options: DecisionOptionView[];
      multiSelect: boolean;
      fields: DecisionFieldView[];
    }
  | {
      type: "decision_settled";
      decisionId: string;
      status: "answered" | "timeout" | "interrupted";
      selections: string[];
      responses: Record<string, string[]>;
      custom: string;
    }
  | {
      type: "distilled";
      recordsWritten: number;
      committed: boolean;
      commitSkippedReason?: string;
      error?: string;
    }
  | { type: "turn_error"; message: string; limitReached?: boolean; model?: string };

/** One worker row as served by /api/workers — lane joined, liveness raw. */
export type WorkerView = {
  id: string;
  status: "spawning" | "running" | "awaiting_input" | "idle" | "stopped" | "failed";
  laneName: string | null;
  allowedGlobs: string[];
  forbiddenGlobs: string[];
  baseSha: string | null;
  branch: string;
  worktreePath: string;
  lastMessageAt: string | null;
  lastSummary: string | null;
  createdAt: string;
  hasDigest: boolean;
  openAttentionCount: number;
  /** Predecessor worker id when this session continues stopped work. */
  resumedFrom: string | null;
};

export type WorkerEventView = {
  id: string;
  kind: "assistant" | "tool_use" | "tool_result" | "result" | "error" | "steer";
  payload: Record<string, unknown>;
  createdAt: string;
};

export type DigestView = {
  narrative: string;
  beforeAfter: { before: string; after: string }[];
  claims: { text: string; evidence_kind: string; files: string[] }[];
  touchedAreas: string[];
  status: string;
  createdAt: string;
};

export type AttentionView = {
  id: string;
  kind: string;
  title: string;
  detail: string;
  priority: "high" | "normal";
  status: string;
  createdAt: string;
  /** Present on the project queue; implicit in a worker drilldown. */
  workerId?: string | null;
};

/** The engine's four independent "brains" — every signal/cap names its leg. */
export type ConfidenceLegView = "facts" | "tripwires" | "watchdog" | "critic";

/** One confidence report as served by /api/confidence — mirrors core types. */
export type ConfidenceReportView = {
  score: number;
  state: "strong" | "steady" | "draining" | "blocked";
  uncappedScore: number;
  signals: { id: string; leg: ConfidenceLegView; label: string; delta: number }[];
  caps: {
    id: string;
    leg: ConfidenceLegView;
    label: string;
    capTo: number;
    blocking: boolean;
    draining: boolean;
  }[];
  stateReason: string;
};

/** How one digest claim resolved against evidence — the badge and its reason. */
export type ClaimLinkView = {
  text: string;
  evidenceKind: string;
  verification: "verified" | "unverified" | "unsupported" | "contradicted";
  reason: string;
};

export type WorkerConfidenceView = {
  workerId: string;
  laneName: string | null;
  report: ConfidenceReportView;
  countsTowardProject: boolean;
  claimLinks: ClaimLinkView[];
};

export type ProjectConfidenceView = {
  project: ConfidenceReportView;
  workers: WorkerConfidenceView[];
  /** Source attribution: when this picture was computed from evidence. */
  computedAt: string;
};

export type WorkerDetailView = {
  worker: WorkerView;
  events: WorkerEventView[];
  digest: DigestView | null;
  attention: AttentionView[];
};

/**
 * Live events from the daemon's GET /events stream (via /api/events). The
 * stream carries other event types too; parse to this union and let the
 * type guards fall through — a catch-all variant would kill narrowing.
 */
export type DaemonStreamEvent =
  | {
      type: "worker_event";
      projectId: string;
      workerId: string;
      event: { id: string; kind: WorkerEventView["kind"]; payload: Record<string, unknown>; createdAt: string };
    }
  | {
      type: "worker_status";
      projectId: string;
      workerId: string;
      status: WorkerView["status"];
      lastSummary: string | null;
    }
  | { type: "attention_changed"; projectId: string }
  | { type: "digest_reviewed"; projectId: string; workerId: string }
  | { type: "monitor_tick"; projectId: string }
  | { type: "manager_note"; projectId: string; text: string };

/** One durable record as served by /api/records — every field attributed. */
export type RecordView = {
  id: string;
  type: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  writtenBy: string;
  body: string;
  /** Where this record physically lives, relative to the project root. */
  sourceFile: string;
  /** Per-field origin, e.g. title → "frontmatter:title", body → "markdown body". */
  fieldSources: Record<string, string>;
  /** Type-specific frontmatter (question, answer, decision fields, links). */
  extra: Record<string, unknown>;
};
