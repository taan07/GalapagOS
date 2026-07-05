"use client";

// The /workers surface: list (lane, status, liveness) + drilldown with the
// live event stream. Read-only by design — spawning, steering, and stopping
// flow through Darwin; this page observes. Initial data comes from SQLite via
// the route handlers; liveness arrives over the daemon's SSE stream.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type {
  DaemonStreamEvent,
  WorkerDetailView,
  WorkerEventView,
  WorkerView,
} from "./types";
import { useProjectSelection } from "./use-project-selection";

function agoLabel(iso: string | null, now: number): string {
  if (!iso) {
    return "no messages yet";
  }
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (seconds < 5) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ago`;
  }
  return new Date(iso).toLocaleString();
}

const STATUS_LABEL: Record<WorkerView["status"], string> = {
  spawning: "spawning",
  running: "running",
  awaiting_input: "awaiting input",
  idle: "idle",
  stopped: "stopped",
  failed: "failed",
};

function StatusPill({ status }: { status: WorkerView["status"] }) {
  return <span className={`status-pill status-${status}`}>{STATUS_LABEL[status]}</span>;
}

const EventItem = memo(function EventItem({ event }: { event: WorkerEventView }) {
  const time = event.createdAt.slice(11, 19);
  if (event.kind === "assistant") {
    return (
      <div className="worker-event assistant">
        <div className="event-meta">
          {time} · worker
        </div>
        <div className="event-text">{String(event.payload.text ?? "")}</div>
      </div>
    );
  }
  if (event.kind === "tool_use") {
    return (
      <details className="chip">
        <summary>
          {time} · {String(event.payload.tool ?? "tool")}
        </summary>
        <pre>{JSON.stringify(event.payload.input ?? {}, null, 2)}</pre>
      </details>
    );
  }
  if (event.kind === "tool_result") {
    const isError = event.payload.isError === true;
    return (
      <details className={`chip${isError ? " chip-error" : ""}`}>
        <summary>
          {time} · tool result{isError ? " (error)" : ""}
        </summary>
        <pre>{String(event.payload.content ?? "")}</pre>
      </details>
    );
  }
  if (event.kind === "steer") {
    return (
      <div className="worker-event steer">
        <div className="event-meta">{time} · steered by Darwin</div>
        <div className="event-text">{String(event.payload.text ?? "")}</div>
      </div>
    );
  }
  if (event.kind === "result") {
    const isError = event.payload.isError === true;
    const resultText = typeof event.payload.resultText === "string" ? event.payload.resultText : "";
    return (
      <details className={`chip${isError ? " chip-error" : ""}`}>
        <summary>
          {time} · turn result — {String(event.payload.subtype ?? "?")}
        </summary>
        {resultText ? <pre>{resultText}</pre> : null}
      </details>
    );
  }
  return (
    <div className="worker-event error">
      <div className="event-meta">{time} · error</div>
      <div className="event-text">{String(event.payload.message ?? JSON.stringify(event.payload))}</div>
    </div>
  );
});

/** Statuses a live session may still be behind — the only stoppable ones. */
const STOPPABLE: readonly WorkerView["status"][] = [
  "spawning",
  "running",
  "awaiting_input",
  "idle",
];

function Drilldown({
  detail,
  now,
  stopping,
  stopNote,
  onStop,
}: {
  detail: WorkerDetailView;
  now: number;
  stopping: boolean;
  stopNote: string | null;
  onStop: () => void;
}) {
  const { worker, events, digest, attention } = detail;
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [events.length]);

  const openAttention = attention.filter((item) => item.status === "open");

  return (
    <section className="drilldown" aria-label="Worker drilldown">
      <header className="drilldown-head">
        <span className="lane-name">{worker.laneName ?? "(lane missing)"}</span>
        <StatusPill status={worker.status} />
        <span className="liveness">{agoLabel(worker.lastMessageAt, now)}</span>
        {STOPPABLE.includes(worker.status) ? (
          <button
            className="stop-worker"
            onClick={onStop}
            disabled={stopping}
            title="Escape hatch: ends the session, audits the worktree against the lane, retires the lane. Normally this flows through Darwin."
          >
            {stopping ? "Stopping…" : "Stop worker"}
          </button>
        ) : null}
      </header>
      {stopNote ? <div className="stop-note">{stopNote}</div> : null}

      <div className="lane-contract">
        <div className="contract-row">
          <span className="contract-label">allowed</span>
          <span className="contract-value mono">{worker.allowedGlobs.join("  ") || "(none)"}</span>
        </div>
        <div className="contract-row">
          <span className="contract-label">forbidden</span>
          <span className="contract-value mono">{worker.forbiddenGlobs.join("  ") || "(none)"}</span>
        </div>
        <div className="contract-row">
          <span className="contract-label">branch</span>
          <span className="contract-value mono">
            {worker.branch}
            {worker.baseSha ? ` (from ${worker.baseSha.slice(0, 8)})` : ""}
          </span>
        </div>
        <div className="contract-row">
          <span className="contract-label">worktree</span>
          <span className="contract-value mono">{worker.worktreePath}</span>
        </div>
      </div>

      {openAttention.length > 0 ? (
        <div className="attention-list">
          {openAttention.map((item) => (
            <div key={item.id} className={`attention-row priority-${item.priority}`}>
              <span className="attention-kind">{item.kind}</span>
              <span className="attention-title">{item.title}</span>
              <details>
                <summary>detail</summary>
                <pre>{item.detail}</pre>
              </details>
            </div>
          ))}
        </div>
      ) : null}

      {digest ? (
        <div className="digest-card">
          <div className="digest-label">completion digest · {digest.status}</div>
          <p className="digest-narrative">{digest.narrative}</p>
          {digest.beforeAfter.map((pair, index) => (
            <div className="digest-pair" key={index}>
              <span className="pair-before">{pair.before}</span>
              <span className="pair-arrow">→</span>
              <span className="pair-after">{pair.after}</span>
            </div>
          ))}
          {digest.claims.length > 0 ? (
            <ul className="digest-claims">
              {digest.claims.map((claim, index) => (
                <li key={index}>
                  <span className={`claim-badge evidence-${claim.evidence_kind}`}>
                    {claim.evidence_kind}
                  </span>
                  {claim.text}
                  {claim.files.length > 0 ? (
                    <span className="claim-files mono"> — {claim.files.join(", ")}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {digest.touchedAreas.length > 0 ? (
            <div className="digest-areas mono">touched: {digest.touchedAreas.join("  ")}</div>
          ) : null}
        </div>
      ) : (
        <div className="no-digest">
          No completion report — this worker is not done, whatever its transcript says.
        </div>
      )}

      <div className="event-stream" ref={streamRef}>
        {events.length === 0 ? (
          <p className="empty-note">No events yet — the session is starting up.</p>
        ) : (
          events.map((event) => <EventItem key={event.id} event={event} />)
        )}
      </div>
    </section>
  );
}

export function WorkersBoard() {
  const {
    projects,
    selectedId: selectedProjectId,
    setSelectedId: setSelectedProjectId,
  } = useProjectSelection();
  const [workers, setWorkers] = useState<WorkerView[] | null>(null);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkerDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  const [stopNote, setStopNote] = useState<{ workerId: string; text: string } | null>(null);
  const selectedWorkerRef = useRef<string | null>(null);
  selectedWorkerRef.current = selectedWorkerId;
  const projectRef = useRef<string | null>(null);
  projectRef.current = selectedProjectId;

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(interval);
  }, []);

  const refreshWorkers = useCallback(async (projectId: string) => {
    setError(null);
    const response = await fetch(`/api/workers?projectId=${encodeURIComponent(projectId)}`, {
      cache: "no-store",
    });
    const payload = (await response.json()) as { workers?: WorkerView[]; error?: string };
    const loaded = payload.workers;
    if (!response.ok || !loaded) {
      setError(payload.error ?? `Failed to load workers (${response.status}).`);
      return;
    }
    setWorkers(loaded);
    setSelectedWorkerId((current) =>
      current && loaded.some((worker) => worker.id === current)
        ? current
        : (loaded.at(-1)?.id ?? null),
    );
  }, []);

  const refreshDetail = useCallback(async (workerId: string) => {
    const response = await fetch(`/api/workers/detail?workerId=${encodeURIComponent(workerId)}`, {
      cache: "no-store",
    });
    if (response.ok) {
      setDetail((await response.json()) as WorkerDetailView);
    }
  }, []);

  useEffect(() => {
    if (selectedProjectId) {
      setWorkers(null);
      setDetail(null);
      void refreshWorkers(selectedProjectId);
    }
  }, [selectedProjectId, refreshWorkers]);

  useEffect(() => {
    if (selectedWorkerId) {
      setDetail(null);
      void refreshDetail(selectedWorkerId);
    } else {
      setDetail(null);
    }
  }, [selectedWorkerId, refreshDetail]);

  // The escape hatch (user-confirmed): stop without a chat turn. The daemon
  // runs the same finalize pass Darwin's stop_worker uses; the note reports
  // its outcome honestly.
  const stopWorker = useCallback(
    async (workerId: string) => {
      setStopping(true);
      setStopNote(null);
      try {
        const response = await fetch("/api/workers/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workerId }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          violations?: unknown[];
          hasDigest?: boolean;
          auditError?: string | null;
        };
        if (!response.ok) {
          setStopNote({ workerId, text: payload.error ?? `Stop failed (${response.status}).` });
        } else {
          const violations = Array.isArray(payload.violations) ? payload.violations.length : 0;
          setStopNote({
            workerId,
            text: [
              "Worker stopped; its lane is retired and the worktree survives for review.",
              payload.auditError
                ? `Lane audit could not run: ${payload.auditError}`
                : violations > 0
                  ? `${violations} out-of-lane change${violations === 1 ? "" : "s"} — raised as a high-priority attention item.`
                  : "Lane audit clean.",
              payload.hasDigest
                ? "A completion report was parsed."
                : "No completion report — not rendered done.",
            ].join(" "),
          });
        }
      } catch (fetchError) {
        setStopNote({
          workerId,
          text: `Stop failed: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`,
        });
      } finally {
        setStopping(false);
      }
      if (projectRef.current) {
        void refreshWorkers(projectRef.current);
      }
      void refreshDetail(workerId);
    },
    [refreshWorkers, refreshDetail],
  );

  // Live updates: append streamed events to the open drilldown, refresh the
  // list on status changes, refetch after results (digest/attention shift).
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onmessage = (message) => {
      let event: DaemonStreamEvent;
      try {
        event = JSON.parse(message.data as string) as DaemonStreamEvent;
      } catch {
        return;
      }
      const projectId = projectRef.current;
      if (event.type === "worker_event" && event.projectId === projectId) {
        setNow(Date.now());
        setWorkers((current) => {
          if (current && !current.some((worker) => worker.id === event.workerId)) {
            // A worker this page has never seen — Darwin just spawned it.
            // The live board must show it without a reload.
            void refreshWorkers(projectId ?? "");
            return current;
          }
          return current
            ? current.map((worker) =>
                worker.id === event.workerId
                  ? { ...worker, lastMessageAt: event.event.createdAt }
                  : worker,
              )
            : current;
        });
        if (event.workerId === selectedWorkerRef.current) {
          if (event.event.kind === "result" || event.event.kind === "error") {
            void refreshDetail(event.workerId);
          } else {
            setDetail((current) =>
              current && !current.events.some((existing) => existing.id === event.event.id)
                ? { ...current, events: [...current.events, event.event] }
                : current,
            );
          }
        }
      }
      if (event.type === "worker_status" && event.projectId === projectId) {
        // Status changes also move the list's digest/attention badges (a
        // stop writes attention rows, a result writes a digest), so refetch
        // the list — it is cheap and statuses change per turn, not per event.
        if (projectId) {
          void refreshWorkers(projectId);
        }
        if (event.workerId === selectedWorkerRef.current) {
          void refreshDetail(event.workerId);
        }
      }
    };
    return () => source.close();
  }, [refreshDetail, refreshWorkers]);

  const detailForSelection = detail && detail.worker.id === selectedWorkerId ? detail : null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title">
          GALAPAGOS <span>/ Workers</span>
        </div>
        <a className="nav-link" href="/">
          ← Darwin
        </a>
        <a
          className="nav-link"
          href={selectedProjectId ? `/records?projectId=${encodeURIComponent(selectedProjectId)}` : "/records"}
        >
          Records
        </a>
        <div className="picker">
          {projects && projects.length > 0 ? (
            <select
              value={selectedProjectId ?? ""}
              onChange={(event) => setSelectedProjectId(event.target.value)}
              aria-label="Project"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </header>
      <main className="workers-main">
        {error ? <div className="banner danger">{error}</div> : null}
        {workers === null && !error ? <p className="empty-note pad">Loading workers…</p> : null}
        {workers !== null && workers.length === 0 ? (
          <p className="empty-note pad">
            No workers yet. Ask Darwin to spawn one on a scoped task — each worker gets its own
            lane and worktree, and its whole event stream lands here live.
          </p>
        ) : null}
        {workers !== null && workers.length > 0 ? (
          <div className="workers-split">
            <div className="worker-list">
              {[...workers].reverse().map((worker) => (
                <button
                  key={worker.id}
                  className={`worker-card${worker.id === selectedWorkerId ? " selected" : ""}`}
                  onClick={() => setSelectedWorkerId(worker.id)}
                >
                  <div className="worker-card-head">
                    <span className="lane-name">{worker.laneName ?? "(lane missing)"}</span>
                    <StatusPill status={worker.status} />
                  </div>
                  <div className="worker-card-sub">
                    <span className="liveness">{agoLabel(worker.lastMessageAt, now)}</span>
                    {worker.openAttentionCount > 0 ? (
                      <span className="attention-count">
                        {worker.openAttentionCount} attention
                      </span>
                    ) : null}
                    {worker.hasDigest ? <span className="digest-mark">digest</span> : null}
                  </div>
                  {worker.lastSummary ? (
                    <div className="worker-card-summary">{worker.lastSummary}</div>
                  ) : null}
                </button>
              ))}
            </div>
            {detailForSelection ? (
              <Drilldown
                detail={detailForSelection}
                now={now}
                stopping={stopping}
                stopNote={
                  stopNote && stopNote.workerId === detailForSelection.worker.id
                    ? stopNote.text
                    : null
                }
                onStop={() => void stopWorker(detailForSelection.worker.id)}
              />
            ) : (
              <p className="empty-note pad">
                {selectedWorkerId ? "Loading worker…" : "Select a worker to see its stream."}
              </p>
            )}
          </div>
        ) : null}
      </main>
    </div>
  );
}
