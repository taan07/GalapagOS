// Pure parser for the worker completion report contract (architecture §6):
// the final result message must end with a fenced ```galapagos-completion
// JSON block. Three honest outcomes — parsed, missing (no block at all;
// mid-task turns are conversation, not failed completions), malformed (a
// block exists but does not satisfy the contract, with every problem named).
export const EVIDENCE_KINDS = [
  "typecheck",
  "lint",
  "test",
  "build",
  "diff",
  "manual",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export type CompletionClaim = {
  text: string;
  evidence_kind: EvidenceKind;
  files: string[];
};

export type CompletionReport = {
  narrative: string;
  before_after: { before: string; after: string }[];
  claims: CompletionClaim[];
  touched_areas: string[];
};

export type CompletionParseResult =
  | { status: "parsed"; report: CompletionReport }
  | { status: "missing" }
  | { status: "malformed"; problems: string[] };

const FENCE_PATTERN = /```galapagos-completion[ \t]*\r?\n([\s\S]*?)```/g;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateReport(value: unknown): { report?: CompletionReport; problems: string[] } {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { problems: ["The block must contain a single JSON object."] };
  }
  const candidate = value as Record<string, unknown>;

  if (typeof candidate.narrative !== "string" || !candidate.narrative.trim()) {
    problems.push('"narrative" must be a non-empty string (three sentences max).');
  }

  const beforeAfter = candidate.before_after;
  if (!Array.isArray(beforeAfter)) {
    problems.push('"before_after" must be an array of { before, after } objects.');
  } else {
    beforeAfter.forEach((entry, index) => {
      const pair = entry as Record<string, unknown> | null;
      if (
        typeof pair !== "object" ||
        pair === null ||
        typeof pair.before !== "string" ||
        typeof pair.after !== "string"
      ) {
        problems.push(`"before_after[${index}]" must be { before: string, after: string }.`);
      }
    });
  }

  const claims = candidate.claims;
  if (!Array.isArray(claims)) {
    problems.push('"claims" must be an array of { text, evidence_kind, files } objects.');
  } else {
    claims.forEach((entry, index) => {
      const claim = entry as Record<string, unknown> | null;
      if (typeof claim !== "object" || claim === null) {
        problems.push(`"claims[${index}]" must be an object.`);
        return;
      }
      if (typeof claim.text !== "string" || !claim.text.trim()) {
        problems.push(`"claims[${index}].text" must be a non-empty string.`);
      }
      if (!(EVIDENCE_KINDS as readonly string[]).includes(claim.evidence_kind as string)) {
        problems.push(
          `"claims[${index}].evidence_kind" must be one of ${EVIDENCE_KINDS.join("|")}.`,
        );
      }
      if (claim.files !== undefined && !isStringArray(claim.files)) {
        problems.push(`"claims[${index}].files" must be an array of file paths when present.`);
      }
    });
  }

  if (!isStringArray(candidate.touched_areas)) {
    problems.push('"touched_areas" must be an array of path strings.');
  }

  if (problems.length > 0) {
    return { problems };
  }
  return {
    problems: [],
    report: {
      narrative: (candidate.narrative as string).trim(),
      before_after: (beforeAfter as { before: string; after: string }[]).map((pair) => ({
        before: pair.before,
        after: pair.after,
      })),
      claims: (claims as Record<string, unknown>[]).map((claim) => ({
        text: claim.text as string,
        evidence_kind: claim.evidence_kind as EvidenceKind,
        files: (claim.files as string[] | undefined) ?? [],
      })),
      touched_areas: candidate.touched_areas as string[],
    },
  };
}

/**
 * Parse a worker's result text for the completion report. When several
 * blocks exist the LAST one wins — it is the report the worker ended on.
 */
export function parseCompletionReport(resultText: string): CompletionParseResult {
  const blocks = Array.from(resultText.matchAll(FENCE_PATTERN));
  const last = blocks.at(-1);
  if (!last) {
    return { status: "missing" };
  }
  const raw = last[1] ?? "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: "malformed",
      problems: [
        `The galapagos-completion block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const { report, problems } = validateReport(parsed);
  if (!report) {
    return { status: "malformed", problems };
  }
  return { status: "parsed", report };
}
