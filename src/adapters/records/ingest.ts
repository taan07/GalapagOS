// One-time (idempotent) import of Chunk-1 vault specifics into the records
// store, so Darwin's memory neither resets nor forks when the store arrives
// (chunk brief hard requirement). Each ingested vault file is stamped
// migrated_to: <record-id>, and each record links back via source_specific —
// belt and suspenders, so a failed stamp cannot cause duplicates either.
import { parseDocument } from "../../core/records/frontmatter";
import {
  listAgreedSpecifics,
  markSpecificMigrated,
  type AgreedSpecific,
} from "../vault/specifics";
import type { RecordDoc, RecordsStore } from "./store";

export type IngestResult = {
  ingested: RecordDoc[];
  skipped: number;
};

function recordCreationDate(specific: AgreedSpecific): Date | undefined {
  const parsed = new Date(specific.createdAt);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function specificBody(specific: AgreedSpecific): string {
  const body = parseDocument(specific.body).body.trim();
  return (
    body ||
    `## Question\n\n${specific.question}\n\n## Agreed answer\n\n${specific.answer}`
  );
}

function ingestOne(store: RecordsStore, specific: AgreedSpecific): RecordDoc {
  const now = recordCreationDate(specific);
  const source = { source_specific: specific.fileName };

  if (specific.status === "deferred") {
    // A deferred specific is a question the user postponed — that is an open
    // question to keep re-raising, not an agreed answer.
    return store.create({
      type: "open_question",
      title: specific.question,
      body: specificBody(specific),
      status: "deferred",
      extra: { question: specific.question, ...source },
      now,
    });
  }

  const record = store.create({
    type: "user_answer",
    title: specific.question,
    body: specificBody(specific),
    extra: { question: specific.question, answer: specific.answer, ...source },
    now,
  });

  if (specific.status === "superseded") {
    // Closed statuses are reachable only via update — keep the lifecycle
    // honest even during migration.
    return store.update({ id: record.id, status: "superseded", now });
  }
  return record;
}

/**
 * Import every not-yet-migrated agreed specific for a project. Safe to run on
 * every daemon start: already-stamped files and already-linked records are
 * skipped, and a missing vault yields zero work, never an error.
 */
export function ingestVaultSpecifics(input: {
  store: RecordsStore;
  vaultPath: string;
  projectSlug: string;
}): IngestResult {
  const specifics = listAgreedSpecifics(input.vaultPath, input.projectSlug);
  if (specifics.length === 0) {
    return { ingested: [], skipped: 0 };
  }

  const alreadyLinked = new Set(
    input.store
      .list()
      .map((doc) => doc.frontmatter.source_specific)
      .filter((value): value is string => typeof value === "string"),
  );

  const ingested: RecordDoc[] = [];
  let skipped = 0;
  for (const specific of specifics) {
    if (specific.migratedTo || alreadyLinked.has(specific.fileName)) {
      skipped += 1;
      continue;
    }
    const record = ingestOne(input.store, specific);
    markSpecificMigrated(input.vaultPath, input.projectSlug, specific.fileName, record.id);
    ingested.push(record);
  }
  return { ingested, skipped };
}
