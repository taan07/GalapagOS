import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createMessageQueue,
  workerCanUseTool,
} from "../src/adapters/agent/worker-session";

const LANE = {
  allowedGlobs: ["src/auth/**"],
  forbiddenGlobs: ["src/auth/**/*.env"],
};

function worktree(): string {
  return mkdtempSync(path.join(os.tmpdir(), "glp-worktree-"));
}

test("canUseTool allows in-lane Edit/Write, absolute or relative", async () => {
  const root = worktree();
  const decide = workerCanUseTool(LANE, root);

  const absolute = await decide(
    "Edit",
    { file_path: path.join(root, "src/auth/login.ts") },
    { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" },
  );
  assert.equal(absolute?.behavior, "allow");

  const relative = await decide(
    "Write",
    { file_path: "src/auth/form.tsx" },
    { signal: new AbortController().signal, toolUseID: "t2", requestId: "r2" },
  );
  assert.equal(relative?.behavior, "allow");
});

test("canUseTool denies out-of-lane writes with the lane explained", async () => {
  const root = worktree();
  const decide = workerCanUseTool(LANE, root);

  const outside = await decide(
    "Edit",
    { file_path: path.join(root, "src/billing/invoice.ts") },
    { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" },
  );
  assert.equal(outside?.behavior, "deny");
  if (outside?.behavior === "deny") {
    assert.match(outside.message, /outside your lane/);
    assert.match(outside.message, /src\/auth\/\*\*/);
  }

  const forbidden = await decide(
    "Write",
    { file_path: path.join(root, "src/auth/prod.env") },
    { signal: new AbortController().signal, toolUseID: "t2", requestId: "r2" },
  );
  assert.equal(forbidden?.behavior, "deny");
  if (forbidden?.behavior === "deny") {
    assert.match(forbidden.message, /forbidden glob/);
  }
});

test("canUseTool denies writes escaping the worktree entirely", async () => {
  const root = worktree();
  const decide = workerCanUseTool(LANE, root);

  const escape = await decide(
    "Write",
    { file_path: "../../etc/passwd" },
    { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" },
  );
  assert.equal(escape?.behavior, "deny");
  if (escape?.behavior === "deny") {
    assert.match(escape.message, /outside your worktree/);
  }
});

test("canUseTool covers NotebookEdit's notebook_path and missing paths", async () => {
  const root = worktree();
  const decide = workerCanUseTool(LANE, root);

  const notebook = await decide(
    "NotebookEdit",
    { notebook_path: path.join(root, "notes/analysis.ipynb") },
    { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" },
  );
  assert.equal(notebook?.behavior, "deny");

  const missing = await decide(
    "Edit",
    {},
    { signal: new AbortController().signal, toolUseID: "t2", requestId: "r2" },
  );
  assert.equal(missing?.behavior, "deny");
  if (missing?.behavior === "deny") {
    assert.match(missing.message, /without a usable file_path/);
  }
});

test("canUseTool denies tools outside the worker surface — deny-by-default", async () => {
  const root = worktree();
  const decide = workerCanUseTool(LANE, root);
  for (const tool of ["WebSearch", "WebFetch", "Task"]) {
    const result = await decide(
      tool,
      { query: "anything" },
      { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" },
    );
    assert.equal(result?.behavior, "deny", `${tool} must be denied`);
    if (result?.behavior === "deny") {
      assert.match(result.message, /not part of the worker tool surface/);
    }
  }
});

test("message queue yields the brief first, then pushed steers, then ends", async () => {
  const queue = createMessageQueue("the brief");
  const seen: string[] = [];

  const consumer = (async () => {
    for await (const message of queue.stream) {
      seen.push(message.message.content as string);
      if (seen.length === 3) {
        break;
      }
    }
  })();

  queue.push("steer one");
  // Let the consumer drain, then push while it is parked waiting.
  await new Promise((resolve) => setTimeout(resolve, 10));
  queue.push("steer two");
  await consumer;
  assert.deepEqual(seen, ["the brief", "steer one", "steer two"]);
});

test("message queue end() terminates a parked consumer and blocks further sends", async () => {
  const queue = createMessageQueue("only message");
  const seen: string[] = [];
  const consumer = (async () => {
    for await (const message of queue.stream) {
      seen.push(message.message.content as string);
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, 10));
  queue.end();
  await consumer;
  assert.deepEqual(seen, ["only message"]);
  assert.throws(() => queue.push("too late"), /stopped worker session/);
});

test("queue messages carry the streaming-input user shape", async () => {
  const queue = createMessageQueue("shape check");
  queue.end();
  for await (const message of queue.stream) {
    assert.equal(message.type, "user");
    assert.equal(message.parent_tool_use_id, null);
    assert.deepEqual(message.message, { role: "user", content: "shape check" });
  }
});
