import test from "node:test";
import assert from "node:assert/strict";
import { loadQueue, queueStorageKey, saveQueue, type QueueStorage } from "../src/ui/queue-store";

function fakeStorage(seed: Record<string, string> = {}): QueueStorage & { dump(): Record<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

test("a saved queue round-trips per project", () => {
  const storage = fakeStorage();
  const queue = [
    { id: "a", text: "first" },
    { id: "b", text: "second" },
  ];
  saveQueue(storage, "p1", queue);
  assert.deepEqual(loadQueue(storage, "p1"), queue);
  assert.deepEqual(loadQueue(storage, "p2"), [], "projects never share a queue");
});

test("an empty queue removes the key — a reload loads clean", () => {
  const storage = fakeStorage();
  saveQueue(storage, "p1", [{ id: "a", text: "pending" }]);
  saveQueue(storage, "p1", []);
  assert.equal(storage.dump()[queueStorageKey("p1")], undefined);
  assert.deepEqual(loadQueue(storage, "p1"), []);
});

test("malformed or hostile stored values load as empty, never throw", () => {
  const key = queueStorageKey("p1");
  assert.deepEqual(loadQueue(fakeStorage({ [key]: "not json {" }), "p1"), []);
  assert.deepEqual(loadQueue(fakeStorage({ [key]: '{"id":"a"}' }), "p1"), [], "non-array");
  assert.deepEqual(
    loadQueue(fakeStorage({ [key]: '[{"id":1,"text":"x"},{"id":"ok","text":"kept"},null]' }), "p1"),
    [{ id: "ok", text: "kept" }],
    "bad entries are dropped, good ones survive",
  );
});

test("attachments ride the queue in memory but are never persisted", () => {
  const storage = fakeStorage();
  saveQueue(storage, "p1", [
    {
      id: "a",
      text: "with an image",
      attachments: [
        { kind: "image", mediaType: "image/png", data: "aGk=", name: "shot.png", size: 2 },
      ],
    },
  ]);
  const raw = storage.dump()[queueStorageKey("p1")];
  assert.ok(raw && !raw.includes("attachments"), "base64 bytes must never hit localStorage");
  assert.deepEqual(loadQueue(storage, "p1"), [{ id: "a", text: "with an image" }]);
});
