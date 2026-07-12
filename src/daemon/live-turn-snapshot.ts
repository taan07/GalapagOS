// The daemon-side memory of an in-flight turn, kept so a client that loads
// MID-TURN (reload, second tab) can arm its working state and render the live
// tail it never streamed. Pure reducer — the daemon owns one snapshot per
// project and folds every outbound turn event through it.

export type LiveTurnStatus = {
  status: "thinking" | "writing" | "tool";
  tool?: string;
  label: string;
};

export type LiveTurnSnapshot = {
  status: LiveTurnStatus | null;
  /** Unsettled streamed prose — deltas since the last settled assistant_text. */
  text: string;
};

export const EMPTY_LIVE_SNAPSHOT: LiveTurnSnapshot = { status: null, text: "" };

// Runtime type guards, not casts: the reducer accepts ANY outbound event
// (unknown tags pass through), so a union member like `{type: string}` would
// defeat discriminated narrowing — the guards read the fields honestly.
type AnyEvent = { type: string } & Record<string, unknown>;

const isStatusEvent = (
  event: AnyEvent,
): event is AnyEvent & { status: LiveTurnStatus["status"]; label: string; tool?: string } =>
  event.type === "turn_status" &&
  (event.status === "thinking" || event.status === "writing" || event.status === "tool") &&
  typeof event.label === "string" &&
  (event.tool === undefined || typeof event.tool === "string");

const isDeltaEvent = (event: AnyEvent): event is AnyEvent & { text: string } =>
  event.type === "assistant_delta" && typeof event.text === "string";

/**
 * Fold one outbound turn event into the snapshot. Returns null when the turn
 * is over — turn_complete, turn_error, or an interrupt (the daemon releases
 * busy right after an interrupt; the entry must not outlive the turn, or a
 * later reload would render a ghost tail).
 */
export function updateLiveSnapshot(
  current: LiveTurnSnapshot,
  event: AnyEvent,
): LiveTurnSnapshot | null {
  if (event.type === "turn_started") {
    return { status: { status: "thinking", label: "Thinking" }, text: "" };
  }
  if (isStatusEvent(event)) {
    return {
      status: {
        status: event.status,
        label: event.label,
        ...(event.tool !== undefined ? { tool: event.tool } : {}),
      },
      text: current.text,
    };
  }
  if (isDeltaEvent(event)) {
    return { status: current.status, text: current.text + event.text };
  }
  if (event.type === "assistant_text") {
    // The settled block replaces the streamed preview — the persisted turn
    // is the truth, and a mid-turn loader gets it from history.
    return { status: current.status, text: "" };
  }
  if (
    event.type === "interrupted" ||
    event.type === "turn_complete" ||
    event.type === "turn_error"
  ) {
    return null;
  }
  return current;
}
