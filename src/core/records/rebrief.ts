// Compact-by-re-brief (architecture §5): when resume fails or context bloats,
// a fresh manager session's first message is generated from the record set.
// This module only formats — reading records is the adapter's job. Pure.

export type RebriefRecord = {
  type: string;
  title: string;
  status: string;
  createdAt: string;
  body: string;
};

export type RebriefInput = {
  projectName: string;
  synthesis: RebriefRecord | null;
  goals: RebriefRecord[];
  openQuestions: RebriefRecord[];
  recentAnswers: RebriefRecord[];
};

function section(heading: string, records: RebriefRecord[], renderBody: boolean): string[] {
  if (records.length === 0) {
    return [];
  }
  const lines = [`## ${heading}`, ""];
  for (const record of records) {
    if (renderBody) {
      lines.push(`### ${record.title} (${record.status}, ${record.createdAt.slice(0, 10)})`, "");
      lines.push(record.body.trim(), "");
    } else {
      lines.push(`- [${record.status}] ${record.title} (${record.createdAt.slice(0, 10)})`);
    }
  }
  if (!renderBody) {
    lines.push("");
  }
  return lines;
}

/**
 * Build the re-brief preamble for a fresh session. Returns null when there is
 * nothing durable to seed from — the caller should say so honestly rather
 * than fabricate context.
 */
export function buildRebrief(input: RebriefInput): string | null {
  const hasAnything =
    input.synthesis !== null ||
    input.goals.length > 0 ||
    input.openQuestions.length > 0 ||
    input.recentAnswers.length > 0;
  if (!hasAnything) {
    return null;
  }

  const lines: string[] = [
    `# Re-brief from durable records — project "${input.projectName}"`,
    "",
    "Your previous session could not be resumed. Everything below comes from",
    "the committed record store (docs/galapagos/) — it is your institutional",
    "memory, not a transcript. Treat it as agreed ground truth, consult",
    "read_records for detail, and do not re-ask what is already answered.",
    "",
  ];

  if (input.synthesis) {
    lines.push("## Latest synthesis", "");
    lines.push(
      `### ${input.synthesis.title} (${input.synthesis.createdAt.slice(0, 10)})`,
      "",
      input.synthesis.body.trim(),
      "",
    );
  }
  lines.push(...section("Active goals", input.goals, true));
  lines.push(...section("Open questions", input.openQuestions, false));
  lines.push(...section("Recently agreed answers", input.recentAnswers, false));

  return lines.join("\n").trim();
}
