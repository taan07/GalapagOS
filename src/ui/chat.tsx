"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatItem } from "./types";

export function Chat({
  items,
  working,
  queued,
  disabled,
  projectName,
  onSend,
}: {
  items: ChatItem[];
  working: boolean;
  queued: string[];
  disabled: boolean;
  projectName: string;
  onSend: (text: string) => void;
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
          return (
            <div className="msg system-note" key={index}>
              {item.text}
            </div>
          );
        })}
        {working ? <div className="working">Darwin is working</div> : null}
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
