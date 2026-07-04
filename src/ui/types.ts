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

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "chip"; chip: ToolChip }
  | { kind: "note"; text: string };

export type ManagerStreamEvent =
  | { type: "turn_started"; sessionId: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_use"; tool: string; summary: string; detail: string }
  | { type: "rebrief"; reason: string }
  | { type: "turn_complete"; resultText: string; sdkSessionId: string | null }
  | { type: "turn_error"; message: string };
