import test from "node:test";
import assert from "node:assert/strict";
import {
  liveEventsFrom,
  shortToolName,
  statusKey,
  toolStatusLabel,
  type TurnStatusEvent,
} from "../src/adapters/agent/live-status";

test("message_start and thinking blocks map to a Thinking status", () => {
  assert.deepEqual(liveEventsFrom({ type: "message_start", message: {} }), [
    { type: "turn_status", status: "thinking", label: "Thinking" },
  ]);
  assert.deepEqual(
    liveEventsFrom({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }),
    [{ type: "turn_status", status: "thinking", label: "Thinking" }],
  );
});

test("a text block start flips the status to Writing", () => {
  assert.deepEqual(
    liveEventsFrom({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    [{ type: "turn_status", status: "writing", label: "Writing" }],
  );
});

test("a tool_use block start names the tool, MCP prefix stripped", () => {
  const events = liveEventsFrom({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "tu_1", name: "mcp__galapagos__spawn_worker" },
  });
  assert.deepEqual(events, [
    { type: "turn_status", status: "tool", tool: "spawn_worker", label: "Spawning a worker" },
  ]);
});

test("built-in tools keep their name and unknown tools degrade readably", () => {
  assert.equal(shortToolName("Read"), "Read");
  assert.equal(toolStatusLabel("Read"), "Reading a file");
  assert.equal(toolStatusLabel("brand_new_tool"), "Running brand_new_tool");
});

test("text deltas become assistant_delta events; empty deltas are dropped", () => {
  assert.deepEqual(
    liveEventsFrom({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hel" },
    }),
    [{ type: "assistant_delta", text: "Hel" }],
  );
  assert.deepEqual(
    liveEventsFrom({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "" },
    }),
    [],
  );
});

test("non-prose stream noise is silence: json deltas, stops, garbage", () => {
  assert.deepEqual(
    liveEventsFrom({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"lane' },
    }),
    [],
  );
  assert.deepEqual(liveEventsFrom({ type: "content_block_stop", index: 0 }), []);
  assert.deepEqual(liveEventsFrom({ type: "message_delta" }), []);
  assert.deepEqual(liveEventsFrom(null), []);
  assert.deepEqual(liveEventsFrom("message_start"), []);
  assert.deepEqual(liveEventsFrom({ type: 42 }), []);
});

test("statusKey dedupes identical statuses but separates tools", () => {
  const thinking: TurnStatusEvent = { type: "turn_status", status: "thinking", label: "Thinking" };
  assert.equal(statusKey(thinking), statusKey({ ...thinking }));
  const read: TurnStatusEvent = { type: "turn_status", status: "tool", tool: "Read", label: "x" };
  const grep: TurnStatusEvent = { type: "turn_status", status: "tool", tool: "Grep", label: "x" };
  assert.notEqual(statusKey(read), statusKey(grep));
});
