import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestVaultSpecifics } from "../src/adapters/records/ingest";
import { createRecordsStore } from "../src/adapters/records/store";
import { recordAgreedSpecific } from "../src/adapters/records/write-through";
import { listAgreedSpecifics } from "../src/adapters/vault/specifics";

function fixture(): { root: string; vault: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "glp-wt-root-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  const vault = mkdtempSync(path.join(os.tmpdir(), "glp-wt-vault-"));
  return { root, vault };
}

test("record_specific writes one memory with two views", () => {
  const { root, vault } = fixture();
  const store = createRecordsStore(root, "proj");
  const result = recordAgreedSpecific({
    store,
    vaultPath: vault,
    projectSlug: "proj",
    question: "Which theme ships first?",
    answer: "Dark only at launch.",
    now: new Date("2026-07-04T10:00:00Z"),
  });

  assert.equal(result.record.type, "user_answer");
  assert.equal(result.record.frontmatter.answer, "Dark only at launch.");
  assert.equal(result.mirrorError, null);

  // The vault mirror points at the record, so ingestion never re-imports it.
  const [specific] = listAgreedSpecifics(vault, "proj");
  assert.ok(specific);
  assert.equal(specific.fileName, result.mirrorFileName);
  assert.equal(specific.migratedTo, result.record.id);

  const ingest = ingestVaultSpecifics({ store, vaultPath: vault, projectSlug: "proj" });
  assert.equal(ingest.ingested.length, 0);
  assert.equal(store.list().length, 1);
});

test("a failing vault mirror never blocks the record write", () => {
  const { root, vault } = fixture();
  const store = createRecordsStore(root, "proj");
  // A vault path that is a file, not a directory → the mirror write must fail.
  const notADir = path.join(vault, "not-a-vault");
  writeFileSync(notADir, "plain file\n");

  const result = recordAgreedSpecific({
    store,
    vaultPath: notADir,
    projectSlug: "proj",
    question: "Q",
    answer: "A",
  });
  assert.equal(result.mirrorFileName, null);
  assert.ok(result.mirrorError);
  assert.equal(store.list().length, 1);
});

test("empty question or answer is rejected before anything is written", () => {
  const { root, vault } = fixture();
  const store = createRecordsStore(root, "proj");
  assert.throws(
    () =>
      recordAgreedSpecific({ store, vaultPath: vault, projectSlug: "proj", question: " ", answer: "A" }),
    /needs both a question and an answer/,
  );
  assert.equal(store.list().length, 0);
});
