import test from "node:test";
import assert from "node:assert/strict";
import {
  composeDocument,
  parseDocument,
  serializeFrontmatter,
  type Frontmatter,
} from "../src/core/records/frontmatter";

test("round-trips scalars, arrays, and the body", () => {
  const data: Frontmatter = {
    id: "a1b2c3d4",
    glp_type: "decision",
    title: 'Choose the "durable" store',
    status: "proposed",
    priority: 2,
    reversible: true,
    parent_decision_ref: null,
    decision_options: ["sqlite rows", "git-committed markdown"],
  };
  const body = "# Heading\n\nDoctrine, not transcripts.\n\n- point";
  const markdown = composeDocument(data, body);
  const parsed = parseDocument(markdown);

  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.body.trim(), body);
});

test("escapes and restores quotes, backslashes, and newlines in strings", () => {
  const data: Frontmatter = {
    answer: 'Use "wx" flag\nnever overwrite \\ paths',
  };
  const parsed = parseDocument(composeDocument(data, "body"));
  assert.equal(parsed.data.answer, 'Use "wx" flag\nnever overwrite \\ paths');
});

test("empty arrays serialize inline and parse back empty", () => {
  const markdown = composeDocument({ decision_options: [] }, "b");
  assert.match(markdown, /decision_options: \[\]/);
  assert.deepEqual(parseDocument(markdown).data.decision_options, []);
});

test("a document without frontmatter yields empty data and full body", () => {
  const parsed = parseDocument("just prose\n\nwith paragraphs");
  assert.deepEqual(parsed.data, {});
  assert.equal(parsed.body, "just prose\n\nwith paragraphs");
});

test("unquoted scalars parse as their natural types", () => {
  const parsed = parseDocument("---\ncount: 3\nok: true\nnope: false\nnothing: null\nword: plain\n---\nb");
  assert.deepEqual(parsed.data, { count: 3, ok: true, nope: false, nothing: null, word: "plain" });
});

test("frontmatter delimiters inside the body are not re-parsed", () => {
  const body = "before\n\n---\n\nafter a horizontal rule";
  const parsed = parseDocument(composeDocument({ id: "x" }, body));
  assert.equal(parsed.data.id, "x");
  assert.match(parsed.body, /horizontal rule/);
});

test("serializeFrontmatter skips undefined values", () => {
  const data = { kept: "yes", dropped: undefined } as unknown as Frontmatter;
  const block = serializeFrontmatter(data);
  assert.match(block, /kept: "yes"/);
  assert.doesNotMatch(block, /dropped/);
});
