"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatItem, RebriefView } from "./types";

export function Chat({
  items,
  working,
  queued,
  disabled,
  projectName,
  onSend,
  onClearRebrief,
}: {
  items: ChatItem[];
  working: boolean;
  queued: string[];
  disabled: boolean;
  projectName: string;
  onSend: (text: string) => void;
  onClearRebrief: (rebrief: RebriefView) => void;
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
