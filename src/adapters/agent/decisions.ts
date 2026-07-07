// The chat decision mechanism (user-confirmed 2026-07-05): Darwin can put a
// real decision to the user as clickable options in the chat — single or
// multiple choice, always with a free-text field — and his turn WAITS for
// the answer. One broker instance lives in the daemon; the ask side runs
// inside a manager turn, the answer side is an HTTP route the UI posts to.
import { randomUUID } from "node:crypto";

export type DecisionOption = {
  label: string;
  /** Practical implication, worded for the user — what choosing this means. */
  implication: string;
};

export type DecisionRequest = {
  id: string;
  question: string;
  options: DecisionOption[];
  multiSelect: boolean;
};

export type DecisionAnswer = {
  /** Labels the user selected (empty when they only typed a custom answer). */
  selections: string[];
  /** The free-text field — always offered, may be empty. */
  custom: string;
};

export type DecisionOutcome =
  | { status: "answered"; answer: DecisionAnswer }
  | { status: "timeout" }
  | { status: "interrupted" };

type PendingDecision = {
  request: DecisionRequest;
  resolve: (outcome: DecisionOutcome) => void;
};

/** A decision left unanswered this long resolves as timeout — Darwin is told
 * to treat it as deferred, never to guess. */
export const DECISION_TIMEOUT_MS = 10 * 60 * 1000;

export type DecisionBroker = ReturnType<typeof createDecisionBroker>;

export function createDecisionBroker() {
  const pending = new Map<string, PendingDecision>();

  return {
    /**
     * Register a decision and wait for the user. Resolution: the UI answers,
     * the timeout fires, or the turn is interrupted — whichever comes first.
     */
    ask(input: {
      question: string;
      options: DecisionOption[];
      multiSelect: boolean;
      signal?: AbortSignal;
      timeoutMs?: number;
    }): { request: DecisionRequest; outcome: Promise<DecisionOutcome> } {
      const request: DecisionRequest = {
        id: randomUUID(),
        question: input.question,
        options: input.options,
        multiSelect: input.multiSelect,
      };

      const outcome = new Promise<DecisionOutcome>((resolve) => {
        const finish = (result: DecisionOutcome) => {
          if (pending.delete(request.id)) {
            clearTimeout(timer);
            input.signal?.removeEventListener("abort", onAbort);
            resolve(result);
          }
        };
        const timer = setTimeout(
          () => finish({ status: "timeout" }),
          input.timeoutMs ?? DECISION_TIMEOUT_MS,
        );
        const onAbort = () => finish({ status: "interrupted" });
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

/** Render the user's answer as tool text Darwin can act on. */
export function describeOutcome(outcome: DecisionOutcome): string {
  if (outcome.status === "answered") {
    const parts: string[] = [];
    if (outcome.answer.selections.length > 0) {
      parts.push(`The user chose: ${outcome.answer.selections.join("; ")}.`);
    }
    if (outcome.answer.custom.trim()) {
      parts.push(`Their note: ${outcome.answer.custom.trim()}`);
    }
    return parts.join(" ") || "The user answered without selecting an option or writing a note.";
  }
  if (outcome.status === "timeout") {
    return "The user did not answer within the time limit. Treat this question as deferred — record it as an open_question and do NOT guess an answer.";
  }
  return "The turn was interrupted before the user answered. Do not assume an answer.";
}
