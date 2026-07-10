// The turn render model (pure, tested): chat items grouped into turns, the
// per-tool chip ranking, the settled-turn rollup plan, and the answer-first
// fold. chat.tsx stays a dumb renderer over these.
import type { ChatItem, ToolChip } from "./types";

/** A chat item with its position in the flat list — the stable render key. */
export type IndexedItem = { item: ChatItem; index: number };

/** One conversational turn: the user message that opened it + what followed. */
export type TurnGroup = {
  /** Stable key: flat-list index of the item that opened the group. */
  key: number;
  /** Null only for the preamble group (notes/re-briefs before any message). */
  user: IndexedItem | null;
  body: IndexedItem[];
  /** When the turn opened (ISO), if known. */
  at?: string;
};

/** A turn starts at every user message; anything earlier is the preamble. */
export function groupTurns(items: ChatItem[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let current: TurnGroup | null = null;
  items.forEach((item, index) => {
    if (item.kind === "user") {
      current = {
        key: index,
        user: { item, index },
        body: [],
        ...(item.at ? { at: item.at } : {}),
      };
      groups.push(current);
      return;
    }
    if (!current) {
      current = { key: index, user: null, body: [], ...(item.at ? { at: item.at } : {}) };
      groups.push(current);
    }
    current.body.push({ item, index });
  });
  return groups;
}

// Chip ranking (Taan's ruling, 2026-07-10): worker management and merges are
// the actions that change the world — they stay visible as first-class lines.
// Routine reads, record writes, and checks roll up when the turn settles.
const FIRST_CLASS_TOOLS = new Set([
  "spawn_worker",
  "resume_worker",
  "steer_worker",
  "hold_worker",
  "stop_worker",
  "merge_worker",
  "amend_lane",
]);

export function isFirstClassChip(chip: ToolChip): boolean {
  return FIRST_CLASS_TOOLS.has(chip.tool);
}

/** How a settled turn renders: everything inline except routine chips, which
 * collapse into one rollup line at the end of the turn. */
export type SettledTurnPlan = {
  inline: IndexedItem[];
  rolledUp: IndexedItem[];
};

export function planSettledTurn(body: IndexedItem[]): SettledTurnPlan {
  const inline: IndexedItem[] = [];
  const rolledUp: IndexedItem[] = [];
  for (const entry of body) {
    if (entry.item.kind === "chip" && !isFirstClassChip(entry.item.chip)) {
      rolledUp.push(entry);
    } else {
      inline.push(entry);
    }
  }
  return { inline, rolledUp };
}

/** The answer-first fold: first paragraph stands, the rest folds. */
export type AnswerFold = { lead: string; rest: string | null };

// Guards: a lead that opens an unclosed code fence must not be split (the
// fold would break the markdown); a giant first paragraph isn't a headline;
// a tiny remainder isn't worth a click.
const MAX_LEAD_CHARS = 400;
const MIN_REST_CHARS = 40;

export function splitAnswerFold(text: string): AnswerFold {
  const trimmed = text.trim();
  const boundary = trimmed.search(/\n\s*\n/);
  if (boundary === -1) {
    return { lead: trimmed, rest: null };
  }
  const lead = trimmed.slice(0, boundary).trim();
  const rest = trimmed.slice(boundary).trim();
  const fenceCount = (lead.match(/```/g) ?? []).length;
  if (fenceCount % 2 !== 0 || lead.length > MAX_LEAD_CHARS || rest.length < MIN_REST_CHARS) {
    return { lead: trimmed, rest: null };
  }
  return { lead, rest };
}
