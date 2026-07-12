import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_LIVE_SNAPSHOT,
  updateLiveSnapshot,
  type LiveTurnSnapshot,
} from "../src/daemon/live-turn-snapshot";

const fold = (events: Parameters<typeof updateLiveSnapshot>[1][]): LiveTurnSnapshot | null => {
  let snapshot: LiveTurnSnapshot | null = EMPTY_LIVE_SNAPSHOT;
  for (const event of events) {
    if (snapshot === null) {
      throw new Error("folded past the end of the turn");
    }
    snapshot = updateLiveSnapshot(snapshot, event);
  }
  return snapshot;
};

test("a turn's lifecycle accumulates the live tail and drops it on settle", () => {
  const midTurn = fold([
    { type: "turn_started" },
    { type: "turn_status", status: "tool", tool: "spawn_worker", label: "Spawning a worker" },
    { type: "assistant_delta", text: "Both workers" },
    { type: "assistant_delta", text: " are running." },
  ]);
  assert.deepEqual(midTurn, {
    status: { status: "tool", tool: "spawn_worker", label: "Spawning a worker" },
    text: "Both workers are running.",
  });

  // The settled block replaces the preview: history owns the text now.
  const settled = updateLiveSnapshot(midTurn as LiveTurnSnapshot, { type: "assistant_text" });
  assert.deepEqual(settled, {
    status: { status: "tool", tool: "spawn_worker", label: "Spawning a worker" },
    text: "",
  });
});

test("turn_complete, turn_error, AND interrupted end the snapshot — the entry must not outlive the turn", () => {
  assert.equal(fold([{ type: "turn_started" }, { type: "turn_complete" }]), null);
  assert.equal(fold([{ type: "turn_started" }, { type: "turn_error" }]), null);
  // The interrupt path emits neither complete nor error (busy releases right
  // after it) — without ending here, every interrupted turn leaked an entry.
  assert.equal(
    fold([
      { type: "turn_started" },
      { type: "assistant_delta", text: "half a thou" },
      { type: "interrupted" },
    ]),
    null,
  );
});

test("turn_started resets whatever a prior turn left behind", () => {
  const restarted = updateLiveSnapshot(
    { status: { status: "writing", label: "Writing" }, text: "stale tail" },
    { type: "turn_started" },
  );
  assert.deepEqual(restarted, {
    status: { status: "thinking", label: "Thinking" },
    text: "",
  });
});

test("events the snapshot does not care about pass through untouched", () => {
  const before: LiveTurnSnapshot = {
    status: { status: "writing", label: "Writing" },
    text: "so far",
  };
  assert.equal(updateLiveSnapshot(before, { type: "tool_use" }), before);
  assert.equal(updateLiveSnapshot(before, { type: "decision_request" }), before);
  assert.equal(updateLiveSnapshot(before, { type: "distilled" }), before);
});
