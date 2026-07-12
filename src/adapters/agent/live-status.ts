// The live shadow of Darwin's in-flight turn. The Agent SDK (with
// includePartialMessages) emits raw Messages-API stream events; this module
// maps them to the two live UI events: a human status line ("Spawning a
// worker…") and token deltas of Darwin's prose. Pure functions — the SDK
// event arrives as `unknown` and is narrowed structurally, so tests never
// need the SDK and a vendor type change cannot crash a turn.

/** What Darwin is doing right now, as a status-line update. */
export type TurnStatusEvent = {
  type: "turn_status";
  status: "thinking" | "writing" | "tool";
  /** Short tool name (mcp__galapagos__ prefix stripped); only for "tool". */
  tool?: string;
  /** The human line the UI shows verbatim. */
  label: string;
};

/** A token-delta of Darwin's top-level prose (never persisted). */
export type AssistantDeltaEvent = { type: "assistant_delta"; text: string };

export type LiveTurnEvent = TurnStatusEvent | AssistantDeltaEvent;

/** "mcp__galapagos__spawn_worker" → "spawn_worker"; built-ins pass through. */
export function shortToolName(name: string): string {
  const parts = name.split("__");
  return parts.length >= 3 ? parts.slice(2).join("__") : name;
}

// Human labels for the status line. Anything unlisted falls back to
// "Running <tool>…" so a new tool degrades readably, never invisibly.
const TOOL_LABELS: Record<string, string> = {
  git_truth: "Checking git state",
  read_records: "Reading the records",
  write_record: "Writing a record",
  update_record: "Updating a record",
  record_specific: "Recording a specific",
  list_specifics: "Reading the specifics",
  spawn_worker: "Spawning a worker",
  resume_worker: "Resuming a worker",
  steer_worker: "Steering a worker",
  hold_worker: "Holding a worker",
  stop_worker: "Stopping a worker",
  amend_lane: "Widening a lane",
  merge_worker: "Merging a worker's branch",
  list_workers: "Checking the worker fleet",
  worker_status: "Checking on a worker",
  run_checks: "Running the checks",
  list_attention: "Reading the attention queue",
  resolve_attention: "Resolving an attention item",
  review_completion: "Reviewing a completion",
  ask_user: "Asking you a question",
  ask_batch: "Asking you a few questions",
  confirm_understanding: "Playing back his understanding",
  Read: "Reading a file",
  Glob: "Scanning the file tree",
  Grep: "Searching the code",
};

export function toolStatusLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? `Running ${tool}`;
}

const THINKING: TurnStatusEvent = {
  type: "turn_status",
  status: "thinking",
  label: "Thinking",
};

const WRITING: TurnStatusEvent = {
  type: "turn_status",
  status: "writing",
  label: "Writing",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Map one raw stream event to live UI events. Narrowed at runtime instead of
 * importing the SDK's (transitive, enormous) stream-event union:
 * - message_start / thinking block  → "Thinking" status
 * - text block start                → "Writing" status
 * - tool_use block start            → tool status (holds through execution —
 *   the stream goes silent while the tool runs, which is exactly right)
 * - text_delta                      → assistant_delta
 * Everything else (input_json_delta, block stops, message_delta…) is silence.
 */
export function liveEventsFrom(event: unknown): LiveTurnEvent[] {
  if (!isRecord(event) || typeof event.type !== "string") {
    return [];
  }

  if (event.type === "message_start") {
    return [THINKING];
  }

  if (event.type === "content_block_start" && isRecord(event.content_block)) {
    const block = event.content_block;
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      return [THINKING];
    }
    if (block.type === "text") {
      return [WRITING];
    }
    if (block.type === "tool_use" && typeof block.name === "string") {
      const tool = shortToolName(block.name);
      return [
        { type: "turn_status", status: "tool", tool, label: toolStatusLabel(tool) },
      ];
    }
    return [];
  }

  if (event.type === "content_block_delta" && isRecord(event.delta)) {
    const delta = event.delta;
    if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
      return [{ type: "assistant_delta", text: delta.text }];
    }
    return [];
  }

  return [];
}

/** Dedupe key so back-to-back identical statuses emit once. */
export function statusKey(event: TurnStatusEvent): string {
  return `${event.status}:${event.tool ?? ""}`;
}
