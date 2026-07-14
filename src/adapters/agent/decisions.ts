// The chat decision mechanism (user-confirmed 2026-07-05, extended 2026-07-08):
// Darwin can put a real decision to the user as clickable options in the chat —
// single or multiple choice, OR a compact batch of 2-4 such questions in one
// card, OR an understanding playback to confirm. His turn WAITS for the answer.
// One broker instance lives in the daemon; the ask side runs inside a manager
// turn, the answer side is an HTTP route the UI posts to.
//
// The free-text "other" answer is NOT an embedded field — it is the chat input
// itself (2026-07-08 ruling): cards are click-only, and anything the user types
// in the composer while a card is pending settles it as the custom answer.
import { randomUUID } from "node:crypto";

export type DecisionOption = {
  label: string;
  /** Practical implication, worded for the user — what choosing this means.
   * Doctrine requires a concrete "e.g." example so the choice is unambiguous. */
  implication: string;
};

/** One question inside a batch card. Select-only — free text goes to the chat. */
export type DecisionField = {
  id: string;
  prompt: string;
  options: DecisionOption[];
  multiSelect: boolean;
};

/** How a card presents: a single decision, a batch of questions, or an
 * understanding playback the user confirms or corrects. */
export type DecisionKind = "decision" | "batch" | "confirm";

export type DecisionRequest = {
  id: string;
  kind: DecisionKind;
  /** The single-question prompt (or the playback text for a confirm). */
  question: string;
  /** Single-decision / confirm options. Empty for a batch. */
  options: DecisionOption[];
  multiSelect: boolean;
  /** Present only for a batch: the 2-4 questions rendered as one card. */
  fields: DecisionField[];
};

export type DecisionAnswer = {
  /** Labels selected on a single-decision / confirm card (empty for a batch
   * answered via fields, or when the user only typed a custom answer). */
  selections: string[];
  /** Per-field selected labels for a batch, keyed by field id. Omitted on the
   * single-decision path. */
  responses?: Record<string, string[]>;
  /** The free text the user typed in the chat composer — always may be empty. */
  custom: string;
};

export type DecisionOutcome =
  | { status: "answered"; answer: DecisionAnswer }
  | { status: "interrupted" };

type PendingDecision = {
  request: DecisionRequest;
  resolve: (outcome: DecisionOutcome) => void;
};

export type DecisionBroker = ReturnType<typeof createDecisionBroker>;

type AskInput = {
  kind?: DecisionKind;
  question?: string;
  options?: DecisionOption[];
  multiSelect?: boolean;
  fields?: DecisionField[];
  signal?: AbortSignal;
};

export function createDecisionBroker() {
  const pending = new Map<string, PendingDecision>();

  return {
    /**
     * Register a decision and wait for the user. Resolution is only the UI's
     * answer or interruption of the owning turn. A pending card has no timer.
     * Handles single decisions, batches (fields), and confirms uniformly.
     */
    ask(input: AskInput): { request: DecisionRequest; outcome: Promise<DecisionOutcome> } {
      const request: DecisionRequest = {
        id: randomUUID(),
        kind: input.kind ?? "decision",
        question: input.question ?? "",
        options: input.options ?? [],
        multiSelect: input.multiSelect ?? false,
        fields: input.fields ?? [],
      };

      const outcome = new Promise<DecisionOutcome>((resolve) => {
        let onAbort: () => void;
        const finish = (result: DecisionOutcome) => {
          if (pending.delete(request.id)) {
            input.signal?.removeEventListener("abort", onAbort);
            resolve(result);
          }
        };

        // An already-aborted owning turn cannot receive an answer. Do not add
        // an entry that no later event can settle.
        if (input.signal?.aborted) {
          resolve({ status: "interrupted" });
          return;
        }
        onAbort = () => finish({ status: "interrupted" });
        input.signal?.addEventListener("abort", onAbort, { once: true });
        pending.set(request.id, { request, resolve: finish });
      });

      return { request, outcome };
    },

    /** The UI's answer. False when the decision is unknown or already settled. */
    answer(decisionId: string, answer: DecisionAnswer): boolean {
      const entry = pending.get(decisionId);
      if (!entry) {
        return false;
      }
      entry.resolve({ status: "answered", answer });
      return true;
    },

    /** Is this decision still waiting? (UI guard against stale buttons.) */
    isPending(decisionId: string): boolean {
      return pending.has(decisionId);
    },
  };
}

/** Render the user's answer as tool text Darwin can act on. Pass a batch's
 * fields to label each response with its question. */
export function describeOutcome(outcome: DecisionOutcome, fields: DecisionField[] = []): string {
  if (outcome.status === "interrupted") {
    return "The turn was interrupted before the user answered. Do not assume an answer.";
  }

  const { selections, custom } = outcome.answer;
  const responses = outcome.answer.responses ?? {};
  const parts: string[] = [];

  // Batch: map each field's chosen labels back to its prompt.
  if (fields.length > 0) {
    for (const field of fields) {
      const chosen = responses[field.id] ?? [];
      if (chosen.length > 0) {
        parts.push(`${field.prompt} → ${chosen.join("; ")}`);
      }
    }
  } else if (selections.length > 0) {
    parts.push(`The user chose: ${selections.join("; ")}.`);
  }

  if (custom.trim()) {
    parts.push(`Their note: ${custom.trim()}`);
  }
  return parts.join(" ") || "The user answered without selecting an option or writing a note.";
}
