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

/** The slice of turn events the snapshot cares about; the rest pass through. */
export type LiveSnapshotEvent =
  | { type: "turn_started" }
  | { type: "turn_status"; status: LiveTurnStatus["status"]; tool?: string; label: string }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_text" }
  | { type: "interrupted" }
  | { type: "turn_complete" }
  | { type: "turn_error" }
  | { type: string };

/**
 * Fold one outbound turn event into the snapshot. Returns null when the turn
 * is over (the caller drops the entry) — a snapshot must never outlive its
 * turn, or a later reload would render a ghost tail.
 */
export function updateLiveSnapshot(
  current: LiveTurnSnapshot,
  event: LiveSnapshotEvent,
): LiveTurnSnapshot | null {
  switch (event.type) {
    case "turn_started":
      return { status: { status: "thinking", label: "Thinking" }, text: "" };
    case "turn_status": {
      const e = event as Extract<LiveSnapshotEvent, { type: "turn_status" }>;
      return {
        status: { status: e.status, label: e.label, ...(e.tool ? { tool: e.tool } : {}) },
        text: current.text,
      };
    }
    case "assistant_delta": {
      const e = event as Extract<LiveSnapshotEvent, { type: "assistant_delta" }>;
      return { status: current.status, text: current.text + e.text };
    }
    case "assistant_text":
      // The settled block replaces the streamed preview — the persisted turn
      // is the truth, and a mid-turn loader gets it from history.
      return { status: current.status, text: "" };
    case "interrupted":
      // Mid-block partials were never persisted; the tail must not survive
      // into a reload that the interrupt already erased.
      return { status: null, text: "" };
    case "turn_complete":
    case "turn_error":
      return null;
    default:
      return current;
  }
}
