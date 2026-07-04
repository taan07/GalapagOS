// record_specific write-through (chunk 2 brief): the records store is the
// memory, the Obsidian vault file is its human-readable mirror. One memory,
// two views — never two diverging memories. The record write must succeed;
// the mirror is best-effort and reports its failure instead of blocking.
import { writeAgreedSpecific } from "../vault/specifics";
import type { RecordDoc, RecordsStore } from "./store";

export type WriteThroughResult = {
  record: RecordDoc;
  mirrorFileName: string | null;
  mirrorError: string | null;
};

/** Frontmatter carries one-line summaries; the full text lives in the body. */
function summarize(value: string, max = 160): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function recordAgreedSpecific(input: {
  store: RecordsStore;
  vaultPath: string;
  projectSlug: string;
  question: string;
  answer: string;
  now?: Date;
}): WriteThroughResult {
  const question = input.question.trim();
  const answer = input.answer.trim();
  if (!question || !answer) {
    throw new Error("An agreed specific needs both a question and an answer.");
  }

  const record = input.store.create({
    type: "user_answer",
    title: question,
    body: `## Question\n\n${question}\n\n## Agreed answer\n\n${answer}`,
    extra: { question: summarize(question), answer: summarize(answer) },
    now: input.now,
  });

  try {
    const mirror = writeAgreedSpecific({
      vaultPath: input.vaultPath,
      projectSlug: input.projectSlug,
      question,
      answer,
      migratedTo: record.id,
      now: input.now,
    });
    return { record, mirrorFileName: mirror.fileName, mirrorError: null };
  } catch (error) {
    return {
      record,
      mirrorFileName: null,
      mirrorError: error instanceof Error ? error.message : String(error),
    };
  }
}
