import test from "node:test";
import assert from "node:assert/strict";
import {
  LARGE_PASTE_THRESHOLD,
  MAX_IMAGE_BASE64_CHARS,
  attachmentPromptNote,
  parseOutgoingAttachments,
  parseUserTurnContent,
  safeAttachmentFileName,
  shouldAttachPastedText,
  userTurnPlainText,
  type StoredAttachment,
  type UserTurnPayload,
} from "../src/core/attachments";

const storedImage: StoredAttachment = {
  kind: "image",
  mediaType: "image/png",
  path: "attachments/p1/abc-shot.png",
  name: "shot.png",
  size: 1234,
};
const storedText: StoredAttachment = {
  kind: "text",
  path: "attachments/p1/def-paste.txt",
  name: "paste.txt",
  size: 2048,
};

test("large-paste interception: over threshold attaches, Shift bypasses", () => {
  const big = "x".repeat(LARGE_PASTE_THRESHOLD + 1);
  assert.equal(shouldAttachPastedText(big, false), true);
  assert.equal(shouldAttachPastedText(big, true), false, "Shift is the escape hatch");
  assert.equal(shouldAttachPastedText("x".repeat(LARGE_PASTE_THRESHOLD), false), false);
});

test("user turn payload round-trips; plain-string history stays valid forever", () => {
  const payload: UserTurnPayload = {
    kind: "user",
    text: "look at this",
    attachments: [storedImage, storedText],
  };
  const parsed = parseUserTurnContent(JSON.stringify(payload));
  assert.equal(parsed.text, "look at this");
  assert.deepEqual(parsed.attachments, [storedImage, storedText]);

  assert.deepEqual(parseUserTurnContent("plain old message"), {
    text: "plain old message",
    attachments: [],
  });
  const jsonLooking = '{"kind":"other","weird":true}';
  assert.deepEqual(parseUserTurnContent(jsonLooking), { text: jsonLooking, attachments: [] });
});

test("malformed stored attachments are filtered, not fatal", () => {
  const content = JSON.stringify({
    kind: "user",
    text: "hi",
    attachments: [storedImage, { kind: "text", name: "no-path.txt", size: 3 }, null, 42],
  });
  assert.deepEqual(parseUserTurnContent(content).attachments, [storedImage]);
});

test("outgoing parse: valid entries pass, any bad entry rejects the send whole", () => {
  assert.deepEqual(parseOutgoingAttachments(undefined), []);
  assert.deepEqual(parseOutgoingAttachments(null), []);
  assert.equal(parseOutgoingAttachments("nope"), null);

  const image = { kind: "image", mediaType: "image/png", data: "aGk=", name: "a.png", size: 2 };
  const textFile = { kind: "text", text: "hello", name: "p.txt", size: 5 };
  assert.deepEqual(parseOutgoingAttachments([image, textFile]), [image, textFile]);

  assert.equal(
    parseOutgoingAttachments([image, { kind: "image", mediaType: "image/tiff", data: "x", name: "b", size: 1 }]),
    null,
    "unknown media type rejects everything",
  );
  assert.equal(
    parseOutgoingAttachments([{ ...image, data: "x".repeat(MAX_IMAGE_BASE64_CHARS + 1) }]),
    null,
    "over the per-image cap",
  );
  assert.equal(parseOutgoingAttachments([{ kind: "text", text: "", name: "e.txt", size: 0 }]), null);
});

test("userTurnPlainText: words plus attachment names, never payload JSON", () => {
  const content = JSON.stringify({
    kind: "user",
    text: "see attached",
    attachments: [storedImage, storedText],
  } satisfies UserTurnPayload);
  assert.equal(userTurnPlainText(content), "see attached [attached: shot.png, paste.txt]");
  assert.equal(
    userTurnPlainText(JSON.stringify({ kind: "user", text: "", attachments: [storedImage] })),
    "[attached: shot.png]",
  );
  assert.equal(userTurnPlainText("just words"), "just words");
});

test("safe file names: single segment, no traversal, never empty", () => {
  assert.equal(safeAttachmentFileName("../../etc/passwd"), "etc_passwd");
  assert.equal(safeAttachmentFileName("shot (1).png"), "shot_1_.png");
  assert.equal(safeAttachmentFileName("...."), "attachment");
  assert.equal(safeAttachmentFileName(""), "attachment");
  assert.ok(safeAttachmentFileName("x".repeat(500)).length <= 120);
});

test("prompt note points at text files on disk; images never appear in it", () => {
  assert.equal(attachmentPromptNote([storedImage], "/state"), null);
  const note = attachmentPromptNote([storedImage, storedText], "/state");
  assert.ok(note);
  assert.match(note, /paste\.txt/);
  assert.match(note, /\/state\/attachments\/p1\/def-paste\.txt/);
  assert.match(note, /Read/);
  assert.ok(!note.includes("shot.png"));
});
