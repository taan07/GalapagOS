// View types for the UI layer. The UI never imports adapters — these mirror
// the shapes served by the route handlers.
export type ProjectView = {
  id: string;
  name: string;
  slug: string;
  root_path: string;
  created_at: string;
};

export type TurnView = {
  id: string;
  turn_index: number;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  created_at: string;
};

export type SpecificView = {
  fileName: string;
  question: string;
  answer: string;
  status: "agreed" | "superseded" | "deferred";
  createdAt: string;
};

export type ToolChip = {
  tool: string;
  summary: string;
  detail: string;
};

export type RebriefView = {
  /** Turn id the clear action targets; null for pre-persistence events. */
  turnId: string | null;
  reason: string;
  /** Full seed text; null when there were no records to seed from. */
  preamble: string | null;
  cleared: boolean;
};

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "chip"; chip: ToolChip }
  | { kind: "rebrief"; rebrief: RebriefView }
  | { kind: "note"; text: string };

export type ManagerStreamEvent =
  | { type: "turn_started"; sessionId: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_use"; tool: string; summary: string; detail: string }
  | { type: "rebrief"; reason: string; preamble: string | null; turnId: string | null }
  | { type: "turn_complete"; resultText: string; sdkSessionId: string | null }
  | {
      type: "distilled";
      recordsWritten: number;
      committed: boolean;
      commitSkippedReason?: string;
      error?: string;
    }
  | { type: "turn_error"; message: string };

/** One durable record as served by /api/records — every field attributed. */
export type RecordView = {
  id: string;
  type: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  writtenBy: string;
  body: string;
  /** Where this record physically lives, relative to the project root. */
  sourceFile: string;
  /** Per-field origin, e.g. title → "frontmatter:title", body → "markdown body". */
  fieldSources: Record<string, string>;
  /** Type-specific frontmatter (question, answer, decision fields, links). */
  extra: Record<string, unknown>;
};
