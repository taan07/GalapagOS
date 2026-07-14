"use client";

import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AttachmentView,
  AutonomyModeView,
  ChatItem,
  DecisionView,
  LiveTurnStatusView,
  QueuedMessage,
  RebriefView,
} from "./types";
import { shouldAttachPastedText, type OutgoingAttachment } from "../core/attachments";
import { imageFileToAttachment } from "./attachments-paste";
import { localClockTime, localDate, localDateTime } from "./time";
import { groupTurns, planSettledTurn, splitAnswerFold, type IndexedItem, type TurnGroup } from "./turns";

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A user message's attachments: image thumbnails open full-size in a new
 * tab; pasted-text files open as raw text. History stays scannable — the
 * thumbnail is bounded, the file is a one-line chip. */
function AttachmentStrip({ attachments }: { attachments: AttachmentView[] }) {
  return (
    <div className="msg-attachments">
      {attachments.map((attachment, index) =>
        attachment.kind === "image" ? (
          <a
            key={index}
            className="msg-attachment-image"
            href={attachment.url}
            target="_blank"
            rel="noreferrer"
            title={`${attachment.name} — open full size`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={attachment.url} alt={attachment.name} loading="lazy" />
          </a>
        ) : (
          <a
            key={index}
            className="msg-attachment-file"
            href={attachment.url}
            target="_blank"
            rel="noreferrer"
            title="Open the pasted text"
          >
            <span className="attach-icon">📄</span>
            <span className="attach-name">{attachment.name}</span>
            <span className="attach-size">{formatSize(attachment.size)}</span>
          </a>
        ),
      )}
    </div>
  );
}

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
          ? "No answer recorded (legacy card)"
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

// Covers the 240ms ::details-content ease plus a settle tail.
const EXPANSION_FOLLOW_MS = 420;

/**
 * While a disclosure eases open, the view rides the growth frame by frame —
 * the scroll IS the expansion's own motion, not a second animation queued
 * after it. Each frame nudges the scroller just enough to keep the revealed
 * message's bottom in view (so the common last-message case lands at the
 * chat's bottom); a message taller than the viewport pins to its top
 * instead, and the view never yanks upward. Already-visible expansions
 * don't move at all.
 */
function followExpansionIntoView(details: HTMLDetailsElement): void {
  if (!details.open) {
    return;
  }
  const scroller = details.closest(".chat-scroll");
  if (!scroller) {
    return;
  }
  const target = details.closest(".msg") ?? details;
  const start = performance.now();
  const frame = (now: number) => {
    if (!details.isConnected || !details.open) {
      return;
    }
    const view = scroller.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    if (rect.height > view.height) {
      const toTop = rect.top - view.top;
      if (toTop > 0) {
        scroller.scrollTop += toTop;
      }
    } else if (rect.bottom > view.bottom) {
      scroller.scrollTop += rect.bottom - view.bottom;
    }
    if (now - start < EXPANSION_FOLLOW_MS) {
      requestAnimationFrame(frame);
    }
  };
  requestAnimationFrame(frame);
}

/** Hover affordance on a message bubble: copy its text, flash confirmation. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="msg-copy"
      title="Copy message"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** A friendly model name for the limit note; the raw id is the fallback. */
function modelLabel(model: string): string {
  if (/fable/i.test(model)) {
    return "Fable";
  }
  if (/opus/i.test(model)) {
    return "Opus";
  }
  return model;
}

/**
 * A usage-limit failure: Darwin couldn't answer on Fable. One click switches
 * the project to Opus and re-sends the message. Local state so the button
 * settles the moment it's used (the retry streams into the chat above).
 */
function LimitNote({
  message,
  model,
  disabled,
  onSwitch,
}: {
  message: string;
  model: string;
  disabled: boolean;
  onSwitch: () => void;
}) {
  const [switched, setSwitched] = useState(false);
  return (
    <div className="msg system-note limit-note">
      <div className="limit-headline">
        Darwin hit the {modelLabel(model)} usage limit and couldn&apos;t finish this turn.
      </div>
      <div className="limit-detail">{message}</div>
      {switched ? (
        <div className="limit-switched">Switched to Opus — re-sending your message…</div>
      ) : (
        <button
          className="limit-switch"
          disabled={disabled}
          onClick={() => {
            setSwitched(true);
            onSwitch();
          }}
          title="Switch this project's manager to Opus and retry. Later turns stay on Opus until the daemon restarts."
        >
          Change to Opus &amp; retry
        </button>
      )}
    </div>
  );
}

/**
 * One rendered chat item. Memoized so a keystroke in the composer — or a single
 * streamed message appended to a long conversation — never re-renders (and, for
 * assistant bubbles, never re-parses the markdown of) every prior message. The
 * items array appends immutably, so each item keeps a stable reference and the
 * memo bails out for everything but the changed row.
 */
const ChatMessage = memo(function ChatMessage({
  item,
  disabled,
  working,
  onClearRebrief,
  onAnswerDecision,
  onSwitchToOpus,
}: {
  item: ChatItem;
  disabled: boolean;
  working: boolean;
  onClearRebrief: (rebrief: RebriefView) => void;
  onAnswerDecision: (
    decisionId: string,
    selections: string[],
    responses: Record<string, string[]>,
    custom: string,
  ) => void;
  onSwitchToOpus: (failedText: string) => void;
}) {
  if (item.kind === "user") {
    return (
      <div className="msg user">
        <CopyButton text={item.text} />
        {item.attachments && item.attachments.length > 0 ? (
          <AttachmentStrip attachments={item.attachments} />
        ) : null}
        {item.text}
      </div>
    );
  }
  if (item.kind === "assistant") {
    // Answer-first fold, history only (Taan's ruling, revised 2026-07-10):
    // a reply you just received renders in full; after a reload it collapses
    // to its summary paragraph so scrolling back to find something is a scan,
    // not a wall of text. Doctrine tells Darwin to write that paragraph as a
    // self-contained summary.
    const fold = item.folded ? splitAnswerFold(item.text) : null;
    if (!fold || fold.rest === null) {
      return (
        <div className="msg assistant">
          <div className="speaker">Darwin</div>
          <CopyButton text={item.text} />
          <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
          </div>
        </div>
      );
    }
    return (
      <div className="msg assistant">
        <div className="speaker">Darwin</div>
        <CopyButton text={item.text} />
        <div className="md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{fold.lead}</ReactMarkdown>
        </div>
        <details
          className="fold"
          onToggle={(event) => followExpansionIntoView(event.currentTarget)}
        >
          <summary>Details</summary>
          <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{fold.rest}</ReactMarkdown>
          </div>
        </details>
      </div>
    );
  }
  if (item.kind === "chip") {
    return (
      <details className="chip">
        <summary>{item.chip.summary}</summary>
        {item.chip.detail ? <pre>{item.chip.detail}</pre> : null}
      </details>
    );
  }
  if (item.kind === "rebrief") {
    // Quiet by default: a collapsed chip, full seed text on demand.
    // No preamble means nothing was seeded — a plain note is honest.
    if (!item.rebrief.preamble) {
      return <div className="msg system-note">{item.rebrief.reason}</div>;
    }
    return (
      <details className="chip rebrief">
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
        decision={item.decision}
        disabled={disabled}
        onAnswer={(selections, responses, custom) =>
          onAnswerDecision(item.decision.decisionId, selections, responses, custom)
        }
      />
    );
  }
  if (item.kind === "limit") {
    return (
      <LimitNote
        message={item.message}
        model={item.model}
        disabled={disabled || working}
        onSwitch={() => onSwitchToOpus(item.failedText)}
      />
    );
  }
  return <div className="msg system-note">{item.text}</div>;
});

function itemKey(entry: IndexedItem): string | number {
  return entry.item.kind === "decision" ? entry.item.decision.decisionId : entry.index;
}

/**
 * Darwin's prose streaming in, smoothed. The network delivers text in bursts;
 * revealing each burst instantly reads as jarring pops. Instead the tail
 * plays out like very fast typing: a ~30fps clock reveals a fraction of the
 * outstanding backlog per tick (full drain in ~400ms), with a 1-char floor so
 * a slow trickle still types steadily. Mounts fresh per streamed block (the
 * buffer clears when a block settles), so the reveal always starts at zero.
 */
const DRAIN_MS = 400;
const TICK_MS = 33;

// How close to the bottom (px) still counts as "riding along" — scroll up
// farther than this and the view stops following until you come back.
const STICK_PX = 160;

function LiveTail({ text }: { text: string }) {
  const [count, setCount] = useState(0);
  const textRef = useRef(text);
  textRef.current = text;
  const selfRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      setCount((current) => {
        const backlog = textRef.current.length - current;
        if (backlog <= 0) {
          return current;
        }
        const step = Math.max(1, Math.ceil((backlog * dt) / DRAIN_MS));
        return Math.min(textRef.current.length, current + step);
      });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const shown = text.slice(0, Math.min(count, text.length));

  // Ride the typing: each reveal tick nudges the scroller the few pixels the
  // text just grew, so the view crawls smoothly with the typewriter instead
  // of jumping per line — and only while the user is already at the bottom.
  // Scrolling up to read stops the follow; coming back resumes it.
  useEffect(() => {
    const scroller = selfRef.current?.closest(".chat-scroll");
    if (!scroller) {
      return;
    }
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (distance > 0 && distance < STICK_PX) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [shown]);

  if (!shown) {
    return null;
  }
  return (
    <div className="msg assistant streaming" ref={selfRef}>
      <div className="speaker">Darwin</div>
      <div className="md">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{shown}</ReactMarkdown>
      </div>
    </div>
  );
}

/**
 * One conversational turn. Live (the in-flight one) renders every event
 * chronologically as it lands; a settled turn reads as conversation — the
 * user's message (timestamped), Darwin's reply and any first-class actions
 * (worker spawns/steers/stops/resumes, merges, lane changes) inline, and the
 * routine activity collapsed to one quiet "N actions" rollup at the end.
 * Memoized: token deltas re-render only the live tail, never settled turns.
 */
const TurnBlock = memo(function TurnBlock({
  group,
  live,
  disabled,
  working,
  onClearRebrief,
  onAnswerDecision,
  onSwitchToOpus,
}: {
  group: TurnGroup;
  live: boolean;
  disabled: boolean;
  working: boolean;
  onClearRebrief: (rebrief: RebriefView) => void;
  onAnswerDecision: (
    decisionId: string,
    selections: string[],
    responses: Record<string, string[]>,
    custom: string,
  ) => void;
  onSwitchToOpus: (failedText: string) => void;
}) {
  const plan = live ? null : planSettledTurn(group.body);
  const renderEntry = (entry: IndexedItem) => (
    <ChatMessage
      key={itemKey(entry)}
      item={entry.item}
      disabled={disabled}
      working={working}
      onClearRebrief={onClearRebrief}
      onAnswerDecision={onAnswerDecision}
      onSwitchToOpus={onSwitchToOpus}
    />
  );
  return (
    <div className="turn">
      {group.user ? (
        <div className="turn-row">
          {group.at ? (
            <span className="turn-time" title={localDateTime(group.at)}>
              {localClockTime(group.at)}
            </span>
          ) : null}
          {renderEntry(group.user)}
        </div>
      ) : null}
      {(plan ? plan.inline : group.body).map(renderEntry)}
      {plan && plan.rolledUp.length > 0 ? (
        <details className="rollup" onToggle={(event) => followExpansionIntoView(event.currentTarget)}>
          <summary>
            {plan.rolledUp.length} action{plan.rolledUp.length === 1 ? "" : "s"}
          </summary>
          <div className="rollup-body">{plan.rolledUp.map(renderEntry)}</div>
        </details>
      ) : null}
    </div>
  );
});

/**
 * The message composer. Owns its own draft state so a keystroke re-renders only
 * this component, never the (potentially long, markdown-heavy) message list
 * above it. The draft is persisted per project in localStorage, so typed-but-
 * unsent text survives a reload or a hop to /workers and back.
 *
 * The free-text answer to a pending card arrives here too (2026-07-08 ruling):
 * `onSend` routes it to the waiting decision instead of starting a new turn.
 */
const MODE_LABELS: Record<AutonomyModeView, string> = {
  interview: "Interview/Plan",
  default: "Default",
  auto: "Auto",
};

const MODE_HINTS: Record<AutonomyModeView, string> = {
  interview:
    "Clarity phase: Darwin interrogates and plans; starting new workers is off. He proposes the formal sign-off when the plan is ready — signing it returns to Default. Shift+Tab cycles.",
  default:
    "Balanced: Darwin acts on what is clearly agreed and asks about the rest. Shift+Tab cycles.",
  auto: "Long leash over workers: Darwin spawns, steers, and retires freely. Ambiguity still interrupts; main and direction calls still need your yes. Shift+Tab cycles.",
};

function Composer({
  projectId,
  disabled,
  answering,
  working,
  queued,
  mode,
  onCycleMode,
  onSend,
}: {
  projectId: string | null;
  disabled: boolean;
  answering: boolean;
  working: boolean;
  queued: QueuedMessage[];
  mode: AutonomyModeView;
  onCycleMode: () => void;
  onSend: (text: string, attachments: OutgoingAttachment[]) => void;
}) {
  const storageKey = projectId ? `galapagos.draft.${projectId}` : null;
  const [draft, setDraft] = useState("");
  // The attachment tray: pasted images (downscaled, base64) and intercepted
  // large-text pastes waiting to ride the next send. Ephemeral by design —
  // unlike the text draft, chips don't survive a reload (image bytes have no
  // sane localStorage story); they're re-pasteable.
  const [tray, setTray] = useState<OutgoingAttachment[]>([]);
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  // Paste events don't carry modifier state — track Shift at the window so
  // Shift+paste can bypass the large-text interception (openwebui §6).
  const shiftHeldRef = useRef(false);
  useEffect(() => {
    const track = (event: KeyboardEvent) => {
      shiftHeldRef.current = event.shiftKey;
    };
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
    };
  }, []);

  // Load the persisted draft whenever the focused project changes. Reads run
  // client-side only (this is a "use client" tree), so useState starts empty
  // and the stored value lands on mount / project switch.
  useEffect(() => {
    if (!storageKey) {
      setDraft("");
    } else {
      setDraft(window.localStorage.getItem(storageKey) ?? "");
    }
    setTray([]);
    setPasteNote(null);
  }, [storageKey]);

  // Persist on edit (not via an effect, to avoid a project switch briefly
  // writing the old draft under the new project's key).
  const edit = (value: string) => {
    setDraft(value);
    if (!storageKey) {
      return;
    }
    if (value) {
      window.localStorage.setItem(storageKey, value);
    } else {
      window.localStorage.removeItem(storageKey);
    }
  };

  const submit = () => {
    const text = draft.trim();
    // A bare screenshot is a valid message; attachments never answer a
    // pending card (the free-text answer contract is text-only).
    const attachments = answering ? [] : tray;
    if ((!text && attachments.length === 0) || disabled) {
      return;
    }
    setDraft("");
    setTray([]);
    setPasteNote(null);
    if (storageKey) {
      window.localStorage.removeItem(storageKey);
    }
    onSend(text, attachments);
  };

  /**
   * openwebui §6 parity: pasted images become tray chips (downscaled to
   * API-safe bounds); plain text past the threshold becomes a .txt chip
   * unless Shift is held (the escape hatch back to an inline paste). Normal
   * pastes fall through to the browser default. Disabled while a card is
   * answering — that path is text-only.
   */
  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (answering || disabled) {
      return;
    }
    const clipboard = event.clipboardData;
    const imageFiles: File[] = [];
    for (const item of Array.from(clipboard.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          imageFiles.push(file);
        }
      }
    }
    if (imageFiles.length > 0) {
      event.preventDefault();
      setPasteNote(null);
      void Promise.all(imageFiles.map((file) => imageFileToAttachment(file).catch(() => null))).then(
        (results) => {
          const attached = results.filter((entry): entry is OutgoingAttachment => entry !== null);
          if (attached.length > 0) {
            setTray((current) => [...current, ...attached]);
          }
          if (attached.length < results.length) {
            setPasteNote("Couldn't attach that image (unreadable or too large).");
          }
        },
      );
      return;
    }
    const text = clipboard.getData("text/plain");
    if (shouldAttachPastedText(text, shiftHeldRef.current)) {
      event.preventDefault();
      setPasteNote(null);
      setTray((current) => [
        ...current,
        {
          kind: "text",
          text,
          name: `Pasted_Text_${Date.now()}.txt`,
          size: text.length,
        },
      ]);
    }
  };

  const removeFromTray = (index: number) => {
    setTray((current) => current.filter((_, i) => i !== index));
  };

  return (
    <div className={`chat-compose${answering ? " answering" : ""}`}>
      {tray.length > 0 && !answering ? (
        <div className="attach-tray">
          {tray.map((attachment, index) => (
            <span
              key={index}
              className={`attach-chip ${attachment.kind === "image" ? "image" : "file"}`}
            >
              {attachment.kind === "image" ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={`data:${attachment.mediaType};base64,${attachment.data}`}
                  alt={attachment.name}
                />
              ) : (
                <>
                  <span className="attach-icon">📄</span>
                  <span className="attach-name">{attachment.name}</span>
                  <span className="attach-size">{formatSize(attachment.size)}</span>
                </>
              )}
              <button
                type="button"
                className="attach-remove"
                title="Remove attachment"
                onClick={() => removeFromTray(index)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
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
        onChange={(event) => edit(event.target.value)}
        onPaste={handlePaste}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="compose-row">
        <button
          type="button"
          className={`mode-pill mode-${mode}`}
          onClick={onCycleMode}
          disabled={disabled}
          title={MODE_HINTS[mode]}
        >
          {MODE_LABELS[mode]} <span className="mode-key">⇧⇥</span>
        </button>
        {answering ? (
          <span className="hint">Your message answers the question above.</span>
        ) : pasteNote ? (
          <span className="queue-note">{pasteNote}</span>
        ) : queued.length > 0 ? (
          <span className="queue-note">
            Queued — sending in order when Darwin finishes, or Steer to interrupt.
          </span>
        ) : (
          <span className="hint">Enter to send · Shift+Enter for a new line</span>
        )}
        <button
          onClick={submit}
          disabled={
            disabled ||
            (draft.trim().length === 0 && (answering || tray.length === 0))
          }
        >
          {answering ? "Answer" : working ? "Queue" : "Send"}
        </button>
      </div>
    </div>
  );
}

export function Chat({
  items,
  working,
  liveText,
  liveStatus,
  queued,
  disabled,
  answering,
  projectId,
  projectName,
  onSend,
  onQueueSteer,
  onQueueRemove,
  onClearRebrief,
  onAnswerDecision,
  onSwitchToOpus,
  mode,
  onCycleMode,
}: {
  items: ChatItem[];
  working: boolean;
  /** Darwin's prose streaming in — the unsettled tail under the last turn. */
  liveText: string;
  /** What Darwin is doing right now; null when no turn is in flight. */
  liveStatus: LiveTurnStatusView | null;
  queued: QueuedMessage[];
  disabled: boolean;
  /** A card is waiting — the composer becomes its free-text answer. */
  answering: boolean;
  /** Focused project id — the key the composer persists its draft under. */
  projectId: string | null;
  projectName: string;
  onSend: (text: string, attachments: OutgoingAttachment[]) => void;
  /** Interrupt the current turn and send this queued message next. */
  onQueueSteer: (id: string) => void;
  onQueueRemove: (id: string) => void;
  onClearRebrief: (rebrief: RebriefView) => void;
  onAnswerDecision: (
    decisionId: string,
    selections: string[],
    responses: Record<string, string[]>,
    custom: string,
  ) => void;
  onSwitchToOpus: (failedText: string) => void;
  /** The project's autonomy stop; the composer pill renders and cycles it. */
  mode: AutonomyModeView;
  onCycleMode: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Settles (a message lands, a chip/card appears, the turn ends) smoothly
  // fall to the bottom and "lock in" — but only when the user is riding the
  // bottom; a deliberate scroll-up to read is never yanked back. The live
  // stream itself is followed by LiveTail's own per-tick crawl, not here.
  //
  // A fresh history load (first paint, project switch) instead PINS the
  // bottom for a few frames: content-visibility:auto reports estimated
  // heights for offscreen turns, so a single scroll-to-bottom targets a
  // scrollHeight that then shifts as real heights render in — on long
  // conversations that landed the view mid-history. The pin re-asserts the
  // bottom each frame until it stops moving.
  const prevCountRef = useRef(0);
  const stickRef = useRef(true);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    const freshLoad = prevCountRef.current === 0 && items.length > 0;
    prevCountRef.current = items.length;
    if (freshLoad) {
      let stableFrames = 0;
      let totalFrames = 0;
      const pin = () => {
        const scroller = scrollRef.current;
        if (!scroller) {
          return;
        }
        const bottom = scroller.scrollHeight - scroller.clientHeight;
        if (Math.abs(scroller.scrollTop - bottom) > 1) {
          scroller.scrollTop = bottom;
          stableFrames = 0;
        } else {
          stableFrames += 1;
        }
        totalFrames += 1;
        if (stableFrames < 3 && totalFrames < 60) {
          requestAnimationFrame(pin);
        }
      };
      pin();
      return;
    }
    if (items.length > 0 && stickRef.current) {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    }
  }, [items, working]);

  // Turn grouping recomputes only when items change — token deltas and
  // status flips leave the groups (and every settled TurnBlock) untouched.
  const groups = useMemo(() => groupTurns(items), [items]);

  return (
    <section className="chat" aria-label="Darwin chat">
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={() => {
          const node = scrollRef.current;
          if (node) {
            stickRef.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 240;
          }
        }}
      >
        {items.length === 0 && !working ? (
          <p className="empty-note">
            This is Darwin, your manager for {projectName || "this project"}. Tell him what you
            want to build — and expect questions until the specifics are pinned down.
          </p>
        ) : null}
        {groups.map((group, index) => {
          const previous = index > 0 ? groups[index - 1] : undefined;
          const newDay =
            group.at && previous?.at && localDate(previous.at) !== localDate(group.at);
          return (
            <Fragment key={group.key}>
              {newDay && group.at ? (
                <div className="date-divider">{localDate(group.at)}</div>
              ) : null}
              <TurnBlock
                group={group}
                live={working && index === groups.length - 1}
                disabled={disabled}
                working={working}
                onClearRebrief={onClearRebrief}
                onAnswerDecision={onAnswerDecision}
                onSwitchToOpus={onSwitchToOpus}
              />
            </Fragment>
          );
        })}
        {liveText ? <LiveTail text={liveText} /> : null}
        {working ? (
          <div className="working">
            <span className="working-label">{liveStatus?.label ?? "Darwin is working"}</span>
            <span className="working-hint">Esc ×3 to stop</span>
          </div>
        ) : null}
      </div>
      {queued.length > 0 ? (
        <div className="queue-list" aria-label="Queued messages">
          {queued.map((message, index) => (
            <div className="queue-item" key={message.id}>
              <span className="queue-pos">{index + 1}</span>
              <span className="queue-text">{message.text}</span>
              {working ? (
                <button
                  className="queue-steer"
                  onClick={() => onQueueSteer(message.id)}
                  title="Interrupt Darwin's current turn and send this message now — he picks up with this as the new direction."
                >
                  Steer
                </button>
              ) : null}
              <button
                className="queue-remove"
                onClick={() => onQueueRemove(message.id)}
                title="Remove from the queue without sending"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <Composer
        projectId={projectId}
        disabled={disabled}
        answering={answering}
        working={working}
        queued={queued}
        mode={mode}
        onCycleMode={onCycleMode}
        onSend={onSend}
      />
    </section>
  );
}
