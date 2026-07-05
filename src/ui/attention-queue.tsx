"use client";

// The attention queue: the ONE loud surface (vision). Open items ranked
// high-before-normal, each resolvable or dismissible in place; closed items
// rest behind a collapsed history. Quiet when empty — nothing demands
// attention that doesn't need it.
import { useState } from "react";
import type { AttentionView } from "./types";

const KIND_LABEL: Record<string, string> = {
  lane_violation: "lane violation",
  stale_worker: "stale worker",
  question_for_user: "question for you",
  unsupported_claim: "unsupported claim",
  check_failed: "check failed",
  decision_needed: "decision needed",
  unstructured_completion: "unstructured completion",
  worker_failed: "worker failed",
};

function QueueRow({
  item,
  acting,
  onResolve,
}: {
  item: AttentionView;
  acting: boolean;
  onResolve: (id: string, resolution: "resolved" | "dismissed") => void;
}) {
  return (
    <div className={`queue-item priority-${item.priority}`}>
      <div className="queue-item-head">
        <span className="attention-kind">{KIND_LABEL[item.kind] ?? item.kind}</span>
        <span className="queue-item-title">{item.title}</span>
      </div>
      <details className="chip queue-detail">
        <summary>detail</summary>
        <pre>{item.detail}</pre>
      </details>
      <div className="queue-actions">
        <span className="queue-when">{item.createdAt.slice(0, 16).replace("T", " ")}</span>
        <button disabled={acting} onClick={() => onResolve(item.id, "resolved")}>
          Resolve
        </button>
        <button disabled={acting} className="dismiss" onClick={() => onResolve(item.id, "dismissed")}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function AttentionQueue({
  items,
  onChanged,
}: {
  items: AttentionView[] | null;
  /** Called after a successful resolve/dismiss so the owner refetches. */
  onChanged: () => void;
}) {
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (id: string, resolution: "resolved" | "dismissed") => {
    setActingId(id);
    setError(null);
    try {
      const response = await fetch("/api/attention/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, resolution }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? `Action failed (${response.status}).`);
      }
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setActingId(null);
      onChanged();
    }
  };

  if (items === null) {
    return (
      <section className="attention-queue" aria-label="Attention queue">
        <h2>Attention</h2>
        <p className="empty-note">Loading the queue…</p>
      </section>
    );
  }

  const open = items.filter((item) => item.status === "open");
  const closed = items.filter((item) => item.status !== "open");

  return (
    <section className="attention-queue" aria-label="Attention queue">
      <h2>
        Attention
        {open.length > 0 ? <span className="queue-count">{open.length}</span> : null}
      </h2>
      {error ? <div className="banner danger">{error}</div> : null}
      {open.length === 0 ? (
        <p className="empty-note">Nothing needs you — the monitor and triage are on it.</p>
      ) : (
        open.map((item) => (
          <QueueRow key={item.id} item={item} acting={actingId === item.id} onResolve={resolve} />
        ))
      )}
      {closed.length > 0 ? (
        <details className="queue-history">
          <summary>
            {closed.length} handled item{closed.length === 1 ? "" : "s"}
          </summary>
          {closed.map((item) => (
            <div key={item.id} className="queue-item closed">
              <div className="queue-item-head">
                <span className="attention-kind">{KIND_LABEL[item.kind] ?? item.kind}</span>
                <span className="queue-item-title">{item.title}</span>
                <span className="queue-status">{item.status}</span>
              </div>
              <details className="chip queue-detail">
                <summary>detail</summary>
                <pre>{item.detail}</pre>
              </details>
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}
