// The nine durable record types and their validation rules (architecture §4).
// Records are doctrine, not transcripts: short, durable, linkable. Pure module —
// the store adapter enforces these rules at the filesystem boundary.
import type { Frontmatter, FrontmatterValue } from "./frontmatter";

export const GLP_TYPES = [
  "manager_synthesis",
  "active_goal",
  "implementation_plan",
  "open_question",
  "user_answer",
  "routed_clarification",
  "worker_brief",
  "decision",
  // "How to work with me" (principle 7): the user's standing working
  // preferences — tone, formats, red lines. Seeded into EVERY re-brief so a
  // compaction never resets how Darwin behaves toward the user.
  "style_contract",
] as const;

export type GlpType = (typeof GLP_TYPES)[number];

export function isGlpType(value: unknown): value is GlpType {
  return typeof value === "string" && (GLP_TYPES as readonly string[]).includes(value);
}

/** Per-type subdirectory under docs/galapagos/. */
export const TYPE_DIRS: Record<GlpType, string> = {
  manager_synthesis: "syntheses",
  active_goal: "goals",
  implementation_plan: "plans",
  open_question: "questions",
  user_answer: "answers",
  routed_clarification: "clarifications",
  worker_brief: "briefs",
  decision: "decisions",
  style_contract: "style",
};

/** Closed statuses are global and reachable only via update, never on create. */
export const CLOSED_STATUSES = [
  "resolved",
  "done",
  "approved",
  "superseded",
  "archived",
] as const;

export type ClosedStatus = (typeof CLOSED_STATUSES)[number];

export function isClosedStatus(status: string): status is ClosedStatus {
  return (CLOSED_STATUSES as readonly string[]).includes(status);
}

/** Statuses a record of each type may carry at creation (first = default). */
export const OPEN_STATUSES: Record<GlpType, readonly string[]> = {
  manager_synthesis: ["active"],
  active_goal: ["active"],
  implementation_plan: ["draft", "active"],
  open_question: ["open", "deferred"],
  user_answer: ["agreed"],
  routed_clarification: ["routed"],
  worker_brief: ["issued"],
  decision: ["proposed"],
  style_contract: ["active"],
};

export function defaultStatus(type: GlpType): string {
  return OPEN_STATUSES[type][0] ?? "open";
}

export const WRITTEN_BY = "Galapagos";

/** Frontmatter every record carries, regardless of type. */
export type BaseRecordFields = {
  id: string;
  glp_type: GlpType;
  title: string;
  status: string;
  project: string;
  created_at: string;
  updated_at: string;
  written_by: string;
};

function isNonEmptyString(value: FrontmatterValue | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: FrontmatterValue | undefined): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validate frontmatter for a record being created. Returns human-readable
 * problems; empty array means valid.
 */
export function validateCreate(input: {
  type: GlpType;
  title: string;
  status: string;
  extra: Frontmatter;
}): string[] {
  const problems: string[] = [];

  if (!input.title.trim()) {
    problems.push("A record needs a non-empty title.");
  }
  if (isClosedStatus(input.status)) {
    problems.push(
      `Cannot create a record with closed status "${input.status}" — closed statuses (${CLOSED_STATUSES.join(", ")}) are reachable only via update.`,
    );
  } else if (!OPEN_STATUSES[input.type].includes(input.status)) {
    problems.push(
      `Status "${input.status}" is not valid for ${input.type} on create — allowed: ${OPEN_STATUSES[input.type].join(", ")}.`,
    );
  }

  if (input.type === "decision") {
    const options = input.extra.decision_options;
    if (!isStringArray(options) || options.length === 0) {
      problems.push("A decision record requires decision_options: a non-empty list of the paths considered.");
    }
    if (!isNonEmptyString(input.extra.rollback_note)) {
      problems.push("A decision record requires rollback_note: how to back out if this turns out wrong.");
    }
    if (!isNonEmptyString(input.extra.confidence_impact)) {
      problems.push("A decision record requires confidence_impact: what this does to confidence and why.");
    }
    // git_checkpoint_ref becomes REQUIRED when the checkpoint mechanism lands
    // (Chunk 6, architecture §8); until then the field is accepted but not
    // demanded, so decisions written today remain valid records.
  }

  return problems;
}

/**
 * Validate a status transition on update. Closed records never reopen;
 * decisions cannot close without a chosen_path.
 */
export function validateStatusChange(input: {
  type: GlpType;
  currentStatus: string;
  nextStatus: string;
  /** Effective chosen_path after the update (existing value or patched). */
  chosenPath?: FrontmatterValue;
}): string[] {
  const problems: string[] = [];
  const { type, currentStatus, nextStatus } = input;

  const validNext =
    isClosedStatus(nextStatus) || OPEN_STATUSES[type].includes(nextStatus);
  if (!validNext) {
    problems.push(
      `Status "${nextStatus}" is not valid for ${type} — allowed: ${OPEN_STATUSES[type].join(", ")}, ${CLOSED_STATUSES.join(", ")}.`,
    );
  }

  if (isClosedStatus(currentStatus) && !isClosedStatus(nextStatus)) {
    problems.push(
      `Cannot reopen a closed record (${currentStatus} → ${nextStatus}) — write a new record that references it instead.`,
    );
  }

  if (type === "decision" && isClosedStatus(nextStatus) && !isNonEmptyString(input.chosenPath)) {
    problems.push(
      "A decision cannot reach a closed status without chosen_path — record which option was taken first.",
    );
  }

  return problems;
}
