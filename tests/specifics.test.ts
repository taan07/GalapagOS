import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listAgreedSpecifics,
  writeAgreedSpecific,
} from "../src/adapters/vault/specifics";

function tmpVault(): string {
  return mkdtempSync(path.join(os.tmpdir(), "glp-vault-"));
}

test("writes an agreed specific with ingestion-ready frontmatter", () => {
  const vault = tmpVault();
  const specific = writeAgreedSpecific({
    vaultPath: vault,
    projectSlug: "mali-marketplace",
    question: "Which payment providers must launch support?",
    answer: "PromptPay and bank transfer only; cards come later.",
    now: new Date("2026-07-03T10:00:00.000Z"),
  });

  assert.equal(specific.fileName, "2026-07-03-which-payment-providers-must-launch-support.md");
  const filePath = path.join(
    vault,
    "Galapagos",
    "mali-marketplace",
    "specifics",
    specific.fileName,
  );
  const content = readFileSync(filePath, "utf8");
  assert.match(content, /^---\nglp_type: "agreed_specific"\n/);
  assert.match(content, /question: "Which payment providers must launch support\?"/);
  assert.match(content, /status: "agreed"/);
  assert.match(content, /created_at: "2026-07-03T10:00:00\.000Z"/);
  assert.match(content, /## Agreed answer\n\nPromptPay and bank transfer only; cards come later\./);
});

test("never overwrites: same-day same-question gets a suffixed file", () => {
  const vault = tmpVault();
  const now = new Date("2026-07-03T10:00:00.000Z");
  const first = writeAgreedSpecific({
    vaultPath: vault,
    projectSlug: "proj",
    question: "Dark or light theme?",
    answer: "Dark.",
    now,
  });
  const second = writeAgreedSpecific({
    vaultPath: vault,
    projectSlug: "proj",
    question: "Dark or light theme?",
    answer: "Actually pure black.",
    now,
  });

  assert.notEqual(first.fileName, second.fileName);
  assert.match(second.fileName, /-2\.md$/);
  const dir = path.join(vault, "Galapagos", "proj", "specifics");
  assert.equal(readdirSync(dir).length, 2);
});

test("lists specifics in filename order with parsed frontmatter", () => {
  const vault = tmpVault();
  writeAgreedSpecific({
    vaultPath: vault,
    projectSlug: "proj",
    question: "A question",
    answer: "A answer",
    now: new Date("2026-07-01T00:00:00.000Z"),
  });
  writeAgreedSpecific({
    vaultPath: vault,
    projectSlug: "proj",
    question: "B question",
    answer: "B answer",
    now: new Date("2026-07-02T00:00:00.000Z"),
  });

  const listed = listAgreedSpecifics(vault, "proj");
  assert.deepEqual(
    listed.map((item) => [item.question, item.answer, item.status]),
    [
      ["A question", "A answer", "agreed"],
      ["B question", "B answer", "agreed"],
    ],
  );
  assert.deepEqual(listAgreedSpecifics(vault, "other-project"), []);
});

test("rejects paths that escape the vault and empty content", () => {
  const vault = tmpVault();
  assert.throws(
    () =>
      writeAgreedSpecific({
        vaultPath: vault,
        projectSlug: "../../etc",
        question: "q",
        answer: "a",
      }),
    /outside the Obsidian vault/,
  );
  assert.throws(
    () =>
      writeAgreedSpecific({
        vaultPath: vault,
        projectSlug: "proj",
        question: "  ",
        answer: "a",
      }),
    /needs both a question and an answer/,
  );
});

test("long questions and answers are summarized in frontmatter but kept whole in the body", () => {
  const vault = tmpVault();
  const longAnswer = `Multi-line detailed answer.\n\n- point one\n- point two\n${"x".repeat(300)}`;
  const specific = writeAgreedSpecific({
    vaultPath: vault,
    projectSlug: "proj",
    question: "How should search ranking work across seller tiers and locations?",
    answer: longAnswer,
  });

  assert.ok(specific.answer.length <= 160);
  assert.ok(specific.answer.endsWith("…"));
  const [listed] = listAgreedSpecifics(vault, "proj");
  assert.ok(listed);
  assert.match(listed.body, /- point one\n- point two/);
});
