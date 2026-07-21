import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDictationDuration,
  mergeDictationIntoDraft,
} from "../src/core/voice-dictation";

test("dictation becomes an editable draft without destroying existing text", () => {
  assert.equal(mergeDictationIntoDraft("", "  Build the review flow. "), "Build the review flow.");
  assert.equal(
    mergeDictationIntoDraft("Context already typed:", "ask me questions first"),
    "Context already typed: ask me questions first",
  );
  assert.equal(mergeDictationIntoDraft("Keep this ", "and append"), "Keep this and append");
  assert.equal(mergeDictationIntoDraft("Keep this", "   "), "Keep this");
});

test("dictation duration is stable and human-readable", () => {
  assert.equal(formatDictationDuration(-1), "0:00");
  assert.equal(formatDictationDuration(5_999), "0:05");
  assert.equal(formatDictationDuration(65_000), "1:05");
});
