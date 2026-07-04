import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestVaultSpecifics } from "../src/adapters/records/ingest";
import { createRecordsStore } from "../src/adapters/records/store";
import { listAgreedSpecifics, writeAgreedSpecific } from "../src/adapters/vault/specifics";

function fixture(): { root: string; vault: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "glp-ingest-root-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  const vault = mkdtempSync(path.join(os.tmpdir(), "glp-ingest-vault-"));
  return { root, vault };
}

function seedSpecific(vault: string, question: string, answer: string, when: string): string {
  return writeAgreedSpecific({
    vaultPath: vault,
    projectSlug: "proj",
    question,
    answer,
    now: new Date(when),
  }).fileName;
}

test("agreed specifics become user_answer records linked both ways", () => {
  const { root, vault } = fixture();
  seedSpecific(vault, "Which providers at launch?", "PromptPay only.", "2026-07-01T08:00:00Z");
  const store = createRecordsStore(root, "proj");

  const result = ingestVaultSpecifics({ store, vaultPath: vault, projectSlug: "proj" });
  assert.equal(result.ingested.length, 1);
  assert.equal(result.skipped, 0);

  const [record] = result.ingested;
  assert.ok(record);
  assert.equal(record.type, "user_answer");
  assert.equal(record.status, "agreed");
  assert.equal(record.createdAt, "2026-07-01T08:00:00.000Z");
  assert.match(record.filePath, /^docs\/galapagos\/answers\/2026-07-01-/);
  assert.equal(record.frontmatter.question, "Which providers at launch?");

  const [specific] = listAgreedSpecifics(vault, "proj");
  assert.ok(specific);
  assert.equal(specific.migratedTo, record.id);
  assert.equal(record.frontmatter.source_specific, specific.fileName);
  // Body content survives the migration.
  assert.match(record.body, /PromptPay only\./);
});

test("ingestion is idempotent: a second run imports nothing", () => {
  const { root, vault } = fixture();
  seedSpecific(vault, "Q1", "A1", "2026-07-01T08:00:00Z");
  seedSpecific(vault, "Q2", "A2", "2026-07-02T08:00:00Z");
  const store = createRecordsStore(root, "proj");

  const first = ingestVaultSpecifics({ store, vaultPath: vault, projectSlug: "proj" });
  assert.equal(first.ingested.length, 2);

  const second = ingestVaultSpecifics({ store, vaultPath: vault, projectSlug: "proj" });
  assert.equal(second.ingested.length, 0);
  assert.equal(second.skipped, 2);
  assert.equal(store.list().length, 2);
});

test("record-side links prevent duplicates even if a vault stamp is lost", () => {
  const { root, vault } = fixture();
  const fileName = seedSpecific(vault, "Q", "A", "2026-07-01T08:00:00Z");
  const store = createRecordsStore(root, "proj");
  ingestVaultSpecifics({ store, vaultPath: vault, projectSlug: "proj" });

  // Simulate a lost stamp: rewrite the vault file without migrated_to.
  const filePath = path.join(vault, "Galapagos", "proj", "specifics", fileName);
  const content = readFileSync(filePath, "utf8").replace(/migrated_to: "[^"]+"\n/, "");
  writeFileSync(filePath, content, "utf8");

  const rerun = ingestVaultSpecifics({ store, vaultPath: vault, projectSlug: "proj" });
  assert.equal(rerun.ingested.length, 0);
  assert.equal(store.list().length, 1);
});

test("deferred specifics become open questions; superseded arrive closed", () => {
  const { root, vault } = fixture();
  const deferred = seedSpecific(vault, "Deferred one", "later", "2026-07-01T08:00:00Z");
  const superseded = seedSpecific(vault, "Old call", "was A", "2026-07-02T08:00:00Z");
  const specificsDir = path.join(vault, "Galapagos", "proj", "specifics");
  for (const [file, status] of [
    [deferred, "deferred"],
    [superseded, "superseded"],
  ] as const) {
    const p = path.join(specificsDir, file);
    writeFileSync(p, readFileSync(p, "utf8").replace('status: "agreed"', `status: "${status}"`), "utf8");
  }
  const store = createRecordsStore(root, "proj");

  const result = ingestVaultSpecifics({ store, vaultPath: vault, projectSlug: "proj" });
  assert.equal(result.ingested.length, 2);

  const question = store.list({ type: "open_question" });
  assert.equal(question.length, 1);
  assert.equal(question[0]?.status, "deferred");

  const answers = store.list({ type: "user_answer" });
  assert.equal(answers.length, 1);
  assert.equal(answers[0]?.status, "superseded");
});

test("a missing vault directory means zero work, not an error", () => {
  const { root, vault } = fixture();
  const store = createRecordsStore(root, "proj");
  const result = ingestVaultSpecifics({ store, vaultPath: vault, projectSlug: "proj" });
  assert.deepEqual(result, { ingested: [], skipped: 0 });
});
