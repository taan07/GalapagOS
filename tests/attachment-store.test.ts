import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAttachmentPath, storeAttachments } from "../src/adapters/attachments/store";

function tmpStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "galapagos-attach-"));
}

test("attachments land on disk under stateDir with relative, collision-proof paths", () => {
  const stateDir = tmpStateDir();
  const imageBytes = Buffer.from("fake image bytes");
  const stored = storeAttachments(stateDir, "proj1", [
    { kind: "image", mediaType: "image/png", data: imageBytes.toString("base64"), name: "shot.png", size: imageBytes.length },
    { kind: "text", text: "a big paste", name: "Pasted_Text_1.txt", size: 11 },
    { kind: "text", text: "same name!", name: "Pasted_Text_1.txt", size: 10 },
  ]);

  assert.equal(stored.length, 3);
  for (const entry of stored) {
    assert.match(entry.path, /^attachments\/proj1\/[^/]+$/, "relative, single segment below the project");
  }
  const [image, textA, textB] = stored;
  assert.ok(image && textA && textB);
  assert.equal(image.kind, "image");
  assert.deepEqual(fs.readFileSync(path.join(stateDir, image.path)), imageBytes);
  assert.equal(fs.readFileSync(path.join(stateDir, textA.path), "utf8"), "a big paste");
  assert.notEqual(textA.path, textB.path, "identical names never overwrite each other");
  assert.ok(image.path.endsWith(".png"));
  assert.ok(textA.path.endsWith(".txt"));
});

test("hostile attachment names are sanitized into the project directory", () => {
  const stateDir = tmpStateDir();
  const stored = storeAttachments(stateDir, "proj1", [
    { kind: "text", text: "gotcha", name: "../../../escape.txt", size: 6 },
  ]);
  const only = stored[0];
  assert.ok(only);
  assert.match(only.path, /^attachments\/proj1\//);
  const absolute = resolveAttachmentPath(stateDir, only.path);
  assert.ok(absolute, "what the store writes, the resolver serves");
  assert.equal(fs.readFileSync(absolute, "utf8"), "gotcha");
});

test("the resolver refuses anything outside the attachments root", () => {
  const stateDir = tmpStateDir();
  assert.equal(resolveAttachmentPath(stateDir, "attachments/p1/../../state.db"), null);
  assert.equal(resolveAttachmentPath(stateDir, "../elsewhere/file.png"), null);
  assert.equal(resolveAttachmentPath(stateDir, "state.db"), null);
  assert.equal(resolveAttachmentPath(stateDir, "attachments"), null, "the root itself is not a file");
  assert.ok(resolveAttachmentPath(stateDir, "attachments/p1/ok.png"));
});
