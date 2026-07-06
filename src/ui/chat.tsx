"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatItem, DecisionView, RebriefView } from "./types";

/**
 * A decision Darwin put to the user: clickable options with practical
 * implications, always a free-text field (user-confirmed 2026-07-05).
 * Single-select answers on click; multi-select collects then submits.
 */
function DecisionPrompt({
  decision,
  disabled,
  onAnswer,
}: {
  decision: DecisionView;
  disabled: boolean;
  onAnswer: (selections: string[], custom: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [sending, setSending] = useState(false);

  if (decision.status !== "pending") {
    const outcome =
      decision.status === "answered"
        ? [
            decision.selections.length > 0 ? `Chose: ${decision.selections.join("; ")}` : null,
            decision.custom ? `Note: ${decision.custom}` : null,
          ]
            .filter(Boolean)
            .join(" · ") || "Answered without a selection"
        : decision.status === "timeout"
          ? "Not answered in time — Darwin treats it as deferred"
          : decision.status === "expired"
            ? "Expired (the daemon restarted before an answer)"
            : "Interrupted before an answer";
    return (
      <div className="decision settled">
        <div className="decision-question">{decision.question}</div>
        <div className="decision-outcome">{outcome}</div>
      </div>
    );
  }

  const submit = (selections: string[]) => {
    setSending(true);
    onAnswer(selections, custom.trim());
  };

  return (
    <div className="decision">
      <div className="decision-question">{decision.question}</div>
      <div className="decision-options">
        {decision.options.map((option) => {
          const selected = picked.includes(option.label);
          return (
            <button
              key={option.label}
              className={`decision-option${selected ? " selected" : ""}`}
              disabled={disabled || sending}
              onClick={() => {
                if (decision.multiSelect) {
                  setPicked((current) =>
                    selected
                      ? current.filter((label) => label !== option.label)
                      : [...current, option.label],
                  );
                } else {
                  submit([option.label]);
                }
              }}
            >
              <span className="decision-label">{option.label}</span>
              <span className="decision-implication">{option.implication}</span>
            </button>
          );
        })}
      </div>
      <div className="decision-custom">
        <input
          value={custom}
          placeholder="Add a note, or answer in your own words…"
          disabled={disabled || sending}
          onChange={(event) => setCustom(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !decision.multiSelect && custom.trim()) {
              event.preventDefault();
              submit([]);
            }
          }}
        />
        {decision.multiSelect || decision.options.length === 0 ? (
          <button
            disabled={disabled || sending || (picked.length === 0 && !custom.trim())}
            onClick={() => submit(picked)}
          >
            {sending ? "Sending…" : "Answer"}
          </button>
        ) : custom.trim() ? (
          <button disabled={disabled || sending} onClick={() => submit([])}>
            {sending ? "Sending…" : "Answer with note only"}
          </button>
        ) : null}
      </div>
      <div className="decision-hint">Darwin is waiting on this before continuing.</div>
    </div>
  );
}

export function Chat({
  items,
  working,
  queued,
  disabled,
  projectName,
  onSend,
  onClearRebrief,
  onAnswerDecision,
}: {
  items: ChatItem[];
  working: boolean;
  queued: string[];
  disabled: boolean;
  projectName: string;
  onSend: (text: string) => void;
  onClearRebrief: (rebrief: RebriefView) => void;
  onAnswerDecision: (decisionId: string, selections: string[], custom: string) => void;
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
                onAnswer={(selections, custom) =>
                  onAnswerDecision(item.decision.decisionId, selections, custom)
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
      <div className="chat-compose">
        <textarea
          value={draft}
          placeholder={disabled ? "Chat unavailable — daemon offline." : "Message Darwin…"}
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
          {queued.length > 0 ? (
            <span className="queue-note">
              {queued.length} message{queued.length === 1 ? "" : "s"} queued — sending when Darwin
              finishes this turn.
            </span>
          ) : (
            <span className="hint">Enter to send · Shift+Enter for a new line</span>
          )}
          <button onClick={submit} disabled={disabled || draft.trim().length === 0}>
            {working ? "Queue" : "Send"}
          </button>
        </div>
      </div>
    </section>
  );
}
