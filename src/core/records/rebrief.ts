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
  /**
   * "How to work with me" (principle 7a): the user's standing working
   * preferences, seeded into EVERY re-brief. When no style_contract record
   * exists yet, the caller passes the built-in baseline so behavior never
   * resets across a compaction.
   */
  styleContracts: RebriefRecord[];
  /**
   * Where the thread stood (7b): one line per undistilled turn of the session
   * that was compacted — the conversational tail records never captured.
   */
  threadState: string[];
  /** Live worker fleet (7c): one line per live worker at compose time. */
  fleet: string[];
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
 * than fabricate context. Thread state and fleet lines alone never justify a
 * preamble (they are ephemera); records — including a style contract — do.
 */
export function buildRebrief(input: RebriefInput): string | null {
  const hasAnything =
    input.synthesis !== null ||
    input.goals.length > 0 ||
    input.openQuestions.length > 0 ||
    input.recentAnswers.length > 0 ||
    input.styleContracts.length > 0;
  if (!hasAnything) {
    return null;
  }

  const lines: string[] = [
    `# Re-brief from durable records — project "${input.projectName}"`,
    "",
    "Your previous session ended (compacted or unresumable). Everything below",
    "comes from the committed record store (docs/galapagos/) plus a snapshot",
    "of the moment — it is your institutional memory, not a transcript. Treat",
    "it as agreed ground truth, consult read_records for detail, and do not",
    "re-ask what is already answered.",
    "",
  ];

  lines.push(...section("How to work with the user", input.styleContracts, true));

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

  if (input.threadState.length > 0) {
    lines.push(
      "## Where the thread stood",
      "",
      "The last exchanges before this re-brief, newest last — conversational",
      "tail the records have not distilled yet:",
      "",
    );
    for (const line of input.threadState) {
      lines.push(`- ${line}`);
    }
    lines.push("");
  }

  if (input.fleet.length > 0) {
    lines.push(
      "## Live workers right now",
      "",
      "These sessions are running THIS INSTANT — they survived the compaction",
      "untouched. Check worker_status before assuming anything about them:",
      "",
    );
    for (const line of input.fleet) {
      lines.push(`- ${line}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}
