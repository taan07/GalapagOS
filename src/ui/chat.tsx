"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatItem, DecisionView, RebriefView } from "./types";

/** Render a settled card's outcome as one scannable line. */
function settledSummary(decision: DecisionView): string {
  const fields = decision.fields ?? [];
  if (fields.length > 0) {
    const parts = fields
      .map((field) => {
        const chosen = decision.responses?.[field.id] ?? [];
        return chosen.length > 0 ? `${field.prompt}: ${chosen.join(", ")}` : null;
      })
      .filter(Boolean) as string[];
    if (decision.custom) {
      parts.push(`Note: ${decision.custom}`);
    }
    return parts.length > 0 ? parts.join(" · ") : "Answered";
  }
  const parts = [
    decision.selections.length > 0 ? `Chose: ${decision.selections.join("; ")}` : null,
    decision.custom ? `Note: ${decision.custom}` : null,
  ].filter(Boolean);
  return parts.join(" · ") || "Answered without a selection";
}

/**
 * A card Darwin put to the user — clickable options ONLY. There is no embedded
 * free-text field (2026-07-08 ruling): the chat composer IS the "other"
 * answer. A single decision/confirm submits on click; a multi-select or a
 * batch of questions collects picks then submits.
 */
function DecisionPrompt({
  decision,
  disabled,
  onAnswer,
}: {
  decision: DecisionView;
  disabled: boolean;
  onAnswer: (selections: string[], responses: Record<string, string[]>, custom: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [responses, setResponses] = useState<Record<string, string[]>>({});
  const [sending, setSending] = useState(false);
  const fields = decision.fields ?? [];
  const isBatch = fields.length > 0;
  const isConfirm = decision.cardKind === "confirm";

  if (decision.status !== "pending") {
    const summary =
      decision.status === "answered"
        ? settledSummary(decision)
        : decision.status === "timeout"
          ? "Not answered in time — Darwin treats it as deferred"
          : decision.status === "expired"
            ? "Expired (the daemon restarted before an answer)"
            : "Interrupted before an answer";
    return (
      <div className={`decision settled${isConfirm ? " confirm" : ""}${isBatch ? " batch" : ""}`}>
        <div className="decision-question">{decision.question || "Batch decision"}</div>
        <div className="decision-outcome">{summary}</div>
      </div>
    );
  }

  const submit = (payload: { selections?: string[]; responses?: Record<string, string[]> }) => {
    setSending(true);
    onAnswer(payload.selections ?? [], payload.responses ?? {}, "");
  };

  const optionButton = (
    option: { label: string; implication: string },
    selected: boolean,
    onPick: () => void,
  ) => (
    <button
      key={option.label}
      className={`decision-option${selected ? " selected" : ""}`}
      disabled={disabled || sending}
      onClick={onPick}
    >
      <span className="decision-label">{option.label}</span>
      <span className="decision-implication">{option.implication}</span>
    </button>
  );

  if (isBatch) {
    const complete = fields.every((field) => (responses[field.id]?.length ?? 0) > 0);
    return (
      <div className="decision batch">
        {decision.question ? <div className="decision-question">{decision.question}</div> : null}
        {fields.map((field) => (
          <div className="decision-field" key={field.id}>
            <div className="decision-field-prompt">{field.prompt}</div>
            <div className="decision-options">
              {field.options.map((option) => {
                const chosen = responses[field.id]?.includes(option.label) ?? false;
                return optionButton(option, chosen, () =>
                  setResponses((current) => {
                    const prev = current[field.id] ?? [];
                    const next = field.multiSelect
                      ? chosen
                        ? prev.filter((label) => label !== option.label)
                        : [...prev, option.label]
                      : [option.label];
                    return { ...current, [field.id]: next };
                  }),
                );
              })}
            </div>
          </div>
        ))}
        <div className="decision-actions">
          <button
            className="decision-submit"
            disabled={disabled || sending || !complete}
            onClick={() => submit({ responses })}
          >
            {sending ? "Sending…" : "Submit answers"}
          </button>
          <span className="decision-hint">…or just type your answer below.</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`decision${isConfirm ? " confirm" : ""}`}>
      <div className="decision-question">{decision.question}</div>
      <div className="decision-options">
        {decision.options.map((option) => {
          const selected = picked.includes(option.label);
          return optionButton(option, selected, () => {
            if (decision.multiSelect) {
              setPicked((current) =>
                selected
                  ? current.filter((label) => label !== option.label)
                  : [...current, option.label],
              );
            } else {
              submit({ selections: [option.label] });
            }
          });
        })}
      </div>
      <div className="decision-actions">
        {decision.multiSelect ? (
          <button
            className="decision-submit"
            disabled={disabled || sending || picked.length === 0}
            onClick={() => submit({ selections: picked })}
          >
            {sending ? "Sending…" : "Submit selection"}
          </button>
        ) : null}
        <span className="decision-hint">…or just type your answer below.</span>
      </div>
    </div>
  );
}

export function Chat({
  items,
  working,
  queued,
  disabled,
  answering,
  projectName,
  onSend,
  onClearRebrief,
  onAnswerDecision,
}: {
  items: ChatItem[];
  working: boolean;
  queued: string[];
  disabled: boolean;
  /** A card is waiting — the composer becomes its free-text answer. */
  answering: boolean;
  projectName: string;
  onSend: (text: string) => void;
  onClearRebrief: (rebrief: RebriefView) => void;
  onAnswerDecision: (
    decisionId: string,
    selections: string[],
    responses: Record<string, string[]>,
    custom: string,
  ) => void;
}) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, working]);

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) {
      return;
    }
    setDraft("");
    onSend(text);
  };

  return (
    <section className="chat" aria-label="Darwin chat">
      <div className="chat-scroll" ref={scrollRef}>
        {items.length === 0 && !working ? (
          <p className="empty-note">
            This is Darwin, your manager for {projectName || "this project"}. Tell him what you
            want to build — and expect questions until the specifics are pinned down.
          </p>
        ) : null}
        {items.map((item, index) => {
          if (item.kind === "user") {
            return (
              <div className="msg user" key={index}>
                {item.text}
              </div>
            );
          }
          if (item.kind === "assistant") {
            return (
              <div className="msg assistant" key={index}>
                <div className="speaker">Darwin</div>
                {item.text}
              </div>
            );
          }
          if (item.kind === "chip") {
            return (
              <details className="chip" key={index}>
                <summary>{item.chip.summary}</summary>
                {item.chip.detail ? <pre>{item.chip.detail}</pre> : null}
              </details>
            );
          }
          if (item.kind === "rebrief") {
            // Quiet by default: a collapsed chip, full seed text on demand.
            // No preamble means nothing was seeded — a plain note is honest.
            if (!item.rebrief.preamble) {
              return (
                <div className="msg system-note" key={index}>
                  {item.rebrief.reason}
                </div>
              );
            }
            return (
              <details className="chip rebrief" key={index}>
                <summary>
                  Darwin re-briefed from records{item.rebrief.cleared ? " (cleared)" : ""}
                </summary>
                <div className="rebrief-detail">
                  <p className="rebrief-reason">{item.rebrief.reason}</p>
                  <pre>{item.rebrief.preamble}</pre>
                  {item.rebrief.cleared ? (
                    <p className="rebrief-reason">
                      This re-brief was cleared — it is no longer in Darwin's context.
                    </p>
                  ) : (
                    <button
                      onClick={() => onClearRebrief(item.rebrief)}
                      disabled={disabled || working || !item.rebrief.turnId}
                      title="Retire this context entirely: Darwin's next turn starts blank. Records stay on disk."
                    >
                      Clear this re-brief — start Darwin blank
                    </button>
                  )}
                </div>
              </details>
            );
          }
          if (item.kind === "decision") {
            return (
              <DecisionPrompt
                key={item.decision.decisionId}
                decision={item.decision}
                disabled={disabled}
                onAnswer={(selections, responses, custom) =>
                  onAnswerDecision(item.decision.decisionId, selections, responses, custom)
                }
              />
            );
          }
          return (
            <div className="msg system-note" key={index}>
              {item.text}
            </div>
          );
        })}
        {working ? <div className="working">Darwin is working — Esc ×3 to stop</div> : null}
      </div>
      <div className={`chat-compose${answering ? " answering" : ""}`}>
        <textarea
          value={draft}
          placeholder={
            disabled
              ? "Chat unavailable — daemon offline."
              : answering
                ? "Pick above, or type your own answer here…"
                : "Message Darwin…"
          }
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="compose-row">
          {answering ? (
            <span className="hint">Your message answers the question above.</span>
          ) : queued.length > 0 ? (
            <span className="queue-note">
              {queued.length} message{queued.length === 1 ? "" : "s"} queued — sending when Darwin
              finishes this turn.
            </span>
          ) : (
            <span className="hint">Enter to send · Shift+Enter for a new line</span>
          )}
          <button onClick={submit} disabled={disabled || draft.trim().length === 0}>
            {answering ? "Answer" : working ? "Queue" : "Send"}
          </button>
        </div>
      </div>
    </section>
  );
}
