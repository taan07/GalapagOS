// Pure parser for the worker PLAN contract (companion to the completion
// contract in core/digests/completion.ts). A worker turns its brief into a
// visible checklist: its first reply ends with a fenced ```galapagos-plan
// JSON block { goal, steps: [{ title, detail? }] }, and it marks progress with
// ```galapagos-step blocks { step, status, note? }. Unlike the completion
// block, a botched plan/step block is NOT a done-claim — the runtime tolerates
// it (a soft event, never an attention item), so the parser's job is only to
// separate the honest outcomes: parsed / missing / malformed.
export const STEP_STATUSES = ["active", "done"] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];

export type PlanStep = {
  title: string;
  detail?: string;
};

export type ParsedPlan = {
  goal: string;
  steps: PlanStep[];
};

export type PlanParseResult =
  | { status: "parsed"; plan: ParsedPlan }
  | { status: "missing" }
  | { status: "malformed"; problems: string[] };

/** A single progress update: mark step N active or done, with an optional note. */
export type StepUpdate = {
  step: number;
  status: StepStatus;
  note?: string;
};

const PLAN_FENCE = /```galapagos-plan[ \t]*\r?\n([\s\S]*?)```/g;
const STEP_FENCE = /```galapagos-step[ \t]*\r?\n([\s\S]*?)```/g;

function validatePlan(value: unknown): { plan?: ParsedPlan; problems: string[] } {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { problems: ["The block must contain a single JSON object."] };
  }
  const candidate = value as Record<string, unknown>;

  if (typeof candidate.goal !== "string" || !candidate.goal.trim()) {
    problems.push('"goal" must be a non-empty string (the brief\'s objective in one line).');
  }

  const steps = candidate.steps;
  const parsedSteps: PlanStep[] = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    problems.push('"steps" must be a non-empty array of { title, detail? } objects.');
  } else {
    steps.forEach((entry, index) => {
      const step = entry as Record<string, unknown> | null;
      if (typeof step !== "object" || step === null) {
        problems.push(`"steps[${index}]" must be an object.`);
        return;
      }
      if (typeof step.title !== "string" || !step.title.trim()) {
        problems.push(`"steps[${index}].title" must be a non-empty string.`);
      }
      if (step.detail !== undefined && typeof step.detail !== "string") {
        problems.push(`"steps[${index}].detail" must be a string when present.`);
      }
      if (typeof step.title === "string" && step.title.trim()) {
        parsedSteps.push({
          title: step.title.trim(),
          ...(typeof step.detail === "string" && step.detail.trim()
            ? { detail: step.detail.trim() }
            : {}),
        });
      }
    });
  }

  if (problems.length > 0) {
    return { problems };
  }
  return {
    problems: [],
    plan: { goal: (candidate.goal as string).trim(), steps: parsedSteps },
  };
}

/**
 * Parse a worker message for its plan. When several plan blocks exist the LAST
 * one wins — a fresh full plan is a re-plan that replaces the previous one.
 */
export function parsePlan(text: string): PlanParseResult {
  const blocks = Array.from(text.matchAll(PLAN_FENCE));
  const last = blocks.at(-1);
  if (!last) {
    return { status: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(last[1] ?? "");
  } catch (error) {
    return {
      status: "malformed",
      problems: [
        `The galapagos-plan block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const { plan, problems } = validatePlan(parsed);
  if (!plan) {
    return { status: "malformed", problems };
  }
  return { status: "parsed", plan };
}

function validateStepUpdate(value: unknown): StepUpdate | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const step = candidate.step;
  if (typeof step !== "number" || !Number.isInteger(step) || step < 1) {
    return null;
  }
  if (!(STEP_STATUSES as readonly string[]).includes(candidate.status as string)) {
    return null;
  }
  return {
    step,
    status: candidate.status as StepStatus,
    ...(typeof candidate.note === "string" && candidate.note.trim()
      ? { note: candidate.note.trim() }
      : {}),
  };
}

/**
 * Parse every galapagos-step block in a message, in order — a worker may
 * advance more than one step in a single turn. Malformed blocks are silently
 * skipped (a progress note is not a claim of completion); only well-formed
 * updates are returned.
 */
export function parseStepUpdates(text: string): StepUpdate[] {
  const updates: StepUpdate[] = [];
  for (const block of text.matchAll(STEP_FENCE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1] ?? "");
    } catch {
      continue;
    }
    const update = validateStepUpdate(parsed);
    if (update) {
      updates.push(update);
    }
  }
  return updates;
}
