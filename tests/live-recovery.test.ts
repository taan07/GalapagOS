import test from "node:test";
import assert from "node:assert/strict";
import {
  createProjectActivityModel,
  createProjectRecoveryModel,
  createSingleFlightReconciler,
} from "../src/core/live-recovery";
import { createSseClientRegistry, SSE_HEARTBEAT_MS } from "../src/core/sse-clients";

test("a late project-A response remains cached but cannot overwrite selected project B", () => {
  const model = createProjectRecoveryModel<string>();
  model.select("A");
  const a = model.begin("A");
  model.select("B");
  assert.equal(model.store(a, "A after reconnect"), true);
  assert.equal(model.mayApply(a), false);
  assert.equal(model.cached("A"), "A after reconnect");
  const b = model.begin("B");
  assert.equal(model.mayApply(b), true);
});

test("an older response cannot regress the same project's cache", () => {
  const model = createProjectRecoveryModel<string>();
  model.select("A");
  const old = model.begin("A");
  const current = model.begin("A");
  assert.equal(model.store(current, "new truth"), true);
  assert.equal(model.store(old, "stale truth"), false);
  assert.equal(model.cached("A"), "new truth");
});

test("reconnect, visible, online, and health recovery coalesce one authoritative resync", async () => {
  const singleFlight = createSingleFlightReconciler();
  let calls = 0;
  let release: (() => void) | undefined;
  const work = () => {
    calls += 1;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const all = ["reopen", "visible", "online", "health-up"].map(() => singleFlight.run("A", work));
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(singleFlight.pending("A"), true);
  release?.();
  await Promise.all(all);
  assert.equal(singleFlight.pending("A"), false);
});

test("a recovery trigger arriving during I/O gets one trailing authoritative pass", async () => {
  const singleFlight = createSingleFlightReconciler();
  const releases: Array<() => void> = [];
  let calls = 0;
  const work = () => {
    calls += 1;
    return new Promise<void>((resolve) => releases.push(resolve));
  };
  const first = singleFlight.run("A", work);
  await Promise.resolve();
  assert.equal(calls, 1);
  const reopen = singleFlight.run("A", work);
  const visible = singleFlight.run("A", work);
  releases.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, "concurrent recovery triggers collapse into one trailing run");
  releases.shift()?.();
  await Promise.all([first, reopen, visible]);
  assert.equal(calls, 2);
});

test("connection state reports reconnecting rather than assuming health from a poll", () => {
  const model = createProjectRecoveryModel<never>();
  assert.equal(model.connection(), "connecting");
  model.setConnection("live");
  model.setConnection("reconnecting");
  assert.equal(model.connection(), "reconnecting");
});

test("POST ownership and queued messages remain isolated by project", () => {
  const activity = createProjectActivityModel<string>();
  activity.beginStream("A");
  activity.beginStream("A");
  assert.equal(activity.ownsStream("A"), true);
  assert.equal(activity.ownsStream("B"), false);
  activity.queue("A", () => []).push("A message");
  activity.queue("B", () => []).push("B message");
  assert.deepEqual(activity.queue("A", () => []), ["A message"]);
  assert.deepEqual(activity.queue("B", () => []), ["B message"]);
  assert.equal(activity.endStream("A"), 1);
  assert.equal(activity.ownsStream("A"), true);
  assert.equal(activity.endStream("A"), 0);
  assert.equal(activity.ownsStream("A"), false);
});

test("heartbeat transport removes closed clients and never emits a domain event", () => {
  let tick: (() => void) | undefined;
  let cleared = 0;
  const registry = createSseClientRegistry({
    setInterval(callback, ms) {
      assert.equal(ms, SSE_HEARTBEAT_MS);
      tick = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval() { cleared += 1; },
  });
  const writes: string[] = [];
  const client: { destroyed?: boolean; write(chunk: string): void } = { write: (chunk) => writes.push(chunk) };
  registry.add(client);
  assert.deepEqual(writes, [": heartbeat\n\n"]);
  client.destroyed = true;
  tick?.();
  assert.equal(registry.size(), 0);
  assert.equal(cleared, 1);
});

test("a client already closed at registration never gets retained or scheduled", () => {
  let scheduled = 0;
  const registry = createSseClientRegistry({
    setInterval() {
      scheduled += 1;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval() {},
  });
  registry.add({ destroyed: true, write() {} });
  assert.equal(registry.size(), 0);
  assert.equal(scheduled, 0);
});
