"use client";

// The /workers surface: list (lane, status, liveness) + drilldown with the
// live event stream. Read-only by design — spawning, steering, and stopping
// flow through Darwin; this page observes. Initial data comes from SQLite via
// the route handlers; liveness arrives over the daemon's SSE stream.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type {
  DaemonStreamEvent,
  ProjectConfidenceView,
  WorkerChangesView,
  WorkerConfidenceView,
  WorkerDetailView,
  WorkerEventView,
  WorkerGithubView,
  WorkerStepView,
  WorkerView,
} from "./types";
import { ConfidenceGauge } from "./confidence";
import { useProjectSelection } from "./use-project-selection";
import { localClockTime } from "./time";

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

/** Thin done/total bar — the same math on the card and in the goal card. */
function PlanBar({ done, total }: { done: number; total: number }) {
  if (total === 0) {
    return null;
  }
  return (
    <span className="plan-bar" role="img" aria-label={`${done} of ${total} steps done`}>
      <span className="plan-bar-fill" style={{ width: `${(done / total) * 100}%` }} />
    </span>
  );
}

/**
 * The plan as one narrative line (the user's taste call: goal statement +
 * running narrative over a rigid checklist). The full checklist stays one
 * click away in a collapsed details.
 */
function planNarrative(steps: WorkerStepView[]): string {
  const done = steps.filter((step) => step.status === "done");
  const active = steps.find((step) => step.status === "active");
  const nextPlanned = steps.find((step) => step.status === "planned");
  const parts: string[] = [];
  if (done.length > 0) {
    const latest = [...done].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    parts.push(`${done.length} of ${steps.length} steps done — latest: ${latest?.title}`);
  } else {
    parts.push(`0 of ${steps.length} steps done`);
  }
  if (active) {
    parts.push(`now: ${active.title}`);
  } else if (nextPlanned) {
    parts.push(`next: ${nextPlanned.title}`);
  }
  return parts.join(" · ");
}

const STEP_MARK: Record<WorkerStepView["status"], string> = {
  done: "✓",
  active: "▸",
  planned: "·",
  abandoned: "×",
};

/** Goal + narrative + collapsed full plan; honest absence when there's none. */
function GoalCard({ goal, steps }: { goal: string | null; steps: WorkerStepView[] }) {
  if (!goal && steps.length === 0) {
    return (
      <div className="no-digest">
        No plan yet — the worker states its goal and steps in its first reply.
      </div>
    );
  }
  const done = steps.filter((step) => step.status === "done").length;
  return (
    <div className="goal-card">
      <div className="goal-label">goal</div>
      <div className="goal-text">{goal ?? "(steps without a stated goal)"}</div>
      {steps.length > 0 ? (
        <>
          <div className="goal-progress">
            <PlanBar done={done} total={steps.length} />
            <span className="goal-narrative">{planNarrative(steps)}</span>
          </div>
          <details className="chip plan-details">
            <summary>full plan · {done}/{steps.length}</summary>
            <ol className="plan-steps">
              {steps.map((step) => (
                <li key={step.ordinal} className={`plan-step step-${step.status}`}>
                  <span className="step-mark">{STEP_MARK[step.status]}</span>
                  <span className="step-title">{step.title}</span>
                  {step.detail ? <span className="step-detail">{step.detail}</span> : null}
                </li>
              ))}
            </ol>
          </details>
        </>
      ) : null}
    </div>
  );
}

const EventItem = memo(function EventItem({ event }: { event: WorkerEventView }) {
  const time = localClockTime(event.createdAt);
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
    if (event.payload.subtype === "stopped") {
      // A deliberate stop is not a failure — say who ended it.
      return (
        <div className="worker-event steer">
          <div className="event-meta">{time} · stopped</div>
          <div className="event-text">
            Stopped by {String(event.payload.stoppedBy ?? "an unspecified caller")}.
          </div>
        </div>
      );
    }
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

/**
 * The work itself (track F): commits since the lane base, the diff, and the
 * check evidence beside it. Fetched on demand per worker; the refresh button
 * re-reads the worktree — running workers commit continuously and a live
 * auto-refetch per event would hammer git for nothing.
 */
function ChangesCard({
  workerId,
  github,
  now,
}: {
  workerId: string;
  github: WorkerGithubView | null;
  now: number;
}) {
  const [changes, setChanges] = useState<WorkerChangesView | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void fetch(`/api/workers/changes?workerId=${encodeURIComponent(workerId)}`, {
      cache: "no-store",
    })
      .then(async (response) =>
        response.ok ? ((await response.json()) as WorkerChangesView) : null,
      )
      .then((payload) => {
        if (!cancelled) {
          if (payload) {
            setChanges(payload);
          } else {
            setFailed(true);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workerId, refreshToken]);

  return (
    <div className="changes-card">
      <div className="changes-label">
        the work
        <button
          className="changes-refresh"
          onClick={() => setRefreshToken((token) => token + 1)}
          title="Re-read the worktree: commits, diff, and check freshness"
        >
          refresh
        </button>
      </div>
      {failed ? <p className="empty-note">Could not read the worktree.</p> : null}
      {!failed && changes === null ? <p className="empty-note">Reading the worktree…</p> : null}
      {changes?.gone ? (
        <p className="empty-note">The worktree no longer exists — its branch holds the work.</p>
      ) : null}
      {changes && !changes.gone ? (
        <>
          {changes.checks.length > 0 ? (
            <div className="checks-row">
              {changes.checks.map((check) => (
                <span
                  key={check.key}
                  className={`check-badge check-${check.status}${check.fresh ? "" : " check-stale"}`}
                  title={`${check.summary} (${agoLabel(check.createdAt, now)})${check.fresh ? "" : " — the worktree changed since this run; re-run to trust it"}`}
                >
                  {check.status === "passed" ? "✓" : "✗"} {check.key}
                  {check.fresh ? "" : " (stale)"}
                </span>
              ))}
            </div>
          ) : (
            <p className="empty-note">No checks have run in this worktree yet.</p>
          )}
          {changes.commits.length > 0 ? (
            <ul className="commit-list">
              {changes.commits.map((commit) => (
                <li key={commit.sha} className="commit-row">
                  {github ? (
                    <a
                      className="mono"
                      href={`${github.webBase}/commit/${commit.sha}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {commit.sha}
                    </a>
                  ) : (
                    <span className="mono">{commit.sha}</span>
                  )}{" "}
                  {commit.subject}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-note">No commits since the lane base yet.</p>
          )}
          {changes.dirtyFiles.length > 0 ? (
            <p className="dirty-note">
              uncommitted: <span className="mono">{changes.dirtyFiles.join("  ")}</span>
            </p>
          ) : null}
          {changes.diff ? (
            <details className="chip">
              <summary>
                diff vs base{changes.diffTruncated ? " (truncated)" : ""}
              </summary>
              <pre className="diff-pre">{changes.diff}</pre>
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Drilldown({
  detail,
  confidence,
  computedAt,
  now,
  stopping,
  holding,
  stopNote,
  onStop,
  onHold,
  projectId,
}: {
  detail: WorkerDetailView;
  confidence: WorkerConfidenceView | null;
  computedAt: string | null;
  now: number;
  stopping: boolean;
  holding: boolean;
  stopNote: string | null;
  onStop: () => void;
  onHold: () => void;
  projectId: string | null;
}) {
  const { worker, events, digest, attention, steps, github } = detail;
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [events.length]);

  const openAttention = attention.filter((item) => item.status === "open");

  // Principle 2: even "direct" steers route through Darwin — he translates
  // intent into an effective worker prompt. The workers page never pipes text
  // to a worker; it prefills the chat composer (the per-project draft the
  // composer already persists) and hands the user to the conversation.
  const steerViaDarwin = () => {
    if (!projectId) {
      return;
    }
    const key = `galapagos.draft.${projectId}`;
    const existing = window.localStorage.getItem(key);
    const crafted = `About the worker on lane "${worker.laneName ?? "(unnamed)"}" (${worker.id.slice(0, 8)}): `;
    window.localStorage.setItem(key, existing?.trim() ? `${existing}\n${crafted}` : crafted);
    window.location.href = "/";
  };

  return (
    <section className="drilldown" aria-label="Worker drilldown">
      <header className="drilldown-head">
        <span className="lane-name">{worker.laneName ?? "(lane missing)"}</span>
        <StatusPill status={worker.status} />
        <span className="liveness">{agoLabel(worker.lastMessageAt, now)}</span>
        {github ? (
          <a
            className="gh-link"
            href={github.branchUrl}
            target="_blank"
            rel="noreferrer"
            title="This worker's branch on GitHub"
          >
            GitHub ↗
          </a>
        ) : null}
        {STOPPABLE.includes(worker.status) ? (
          <span className="worker-controls">
            <button
              className="steer-worker"
              onClick={steerViaDarwin}
              disabled={!projectId}
              title="Steer through Darwin: opens the chat with this worker named in the composer — he translates your intent into an effective worker prompt. Never a raw pipe."
            >
              Steer via Darwin
            </button>
            <button
              className="hold-worker"
              onClick={onHold}
              disabled={stopping || holding}
              title="Pause without ending: the worker states where it is and waits. The lane stays active; release it via Darwin (steer 'continue')."
            >
              {holding ? "Holding…" : "Hold"}
            </button>
            <button
              className="stop-worker"
              onClick={onStop}
              disabled={stopping || holding}
              title="Escape hatch: ends the session, audits the worktree against the lane, retires the lane. Normally this flows through Darwin."
            >
              {stopping ? "Stopping…" : "Stop worker"}
            </button>
          </span>
        ) : null}
      </header>
      {stopNote ? <div className="stop-note">{stopNote}</div> : null}

      <GoalCard goal={worker.goal} steps={steps} />

      {confidence ? (
        <ConfidenceGauge
          report={confidence.report}
          label="worker confidence"
          {...(computedAt ? { computedAt } : {})}
        />
      ) : null}

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
            {github ? (
              <a href={github.branchUrl} target="_blank" rel="noreferrer">
                {worker.branch}
              </a>
            ) : (
              worker.branch
            )}
            {worker.baseSha ? (
              <>
                {" (from "}
                {github?.baseCommitUrl ? (
                  <a href={github.baseCommitUrl} target="_blank" rel="noreferrer">
                    {worker.baseSha.slice(0, 8)}
                  </a>
                ) : (
                  worker.baseSha.slice(0, 8)
                )}
                {")"}
              </>
            ) : null}
          </span>
        </div>
        <div className="contract-row">
          <span className="contract-label">worktree</span>
          <span className="contract-value mono">{worker.worktreePath}</span>
        </div>
        {worker.resumedFrom ? (
          <div className="contract-row">
            <span className="contract-label">continues</span>
            <span className="contract-value mono">
              worker {worker.resumedFrom.slice(0, 8)} (resumed in the same worktree)
            </span>
          </div>
        ) : null}
      </div>

      <ChangesCard workerId={worker.id} github={github} now={now} />

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
              {digest.claims.map((claim, index) => {
                // claimLinks come from the same digest claims array, in order.
                const link = confidence?.claimLinks[index];
                return (
                  <li key={index}>
                    {link ? (
                      <span
                        className={`claim-badge verification-${link.verification}`}
                        title={link.reason}
                      >
                        {link.verification}
                      </span>
                    ) : null}
                    <span className={`claim-badge evidence-${claim.evidence_kind}`}>
                      {claim.evidence_kind}
                    </span>
                    {claim.text}
                    {claim.files.length > 0 ? (
                      <span className="claim-files mono">
                        {" — "}
                        {claim.files.map((file, fileIndex) => (
                          <span key={file}>
                            {fileIndex > 0 ? ", " : ""}
                            {github?.fileUrls[file] ? (
                              <a href={github.fileUrls[file]} target="_blank" rel="noreferrer">
                                {file}
                              </a>
                            ) : (
                              file
                            )}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </li>
                );
              })}
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
  const [confidence, setConfidence] = useState<ProjectConfidenceView | null>(null);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkerDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  const [holding, setHolding] = useState(false);
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

  const refreshConfidence = useCallback(async (projectId: string) => {
    const response = await fetch(`/api/confidence?projectId=${encodeURIComponent(projectId)}`, {
      cache: "no-store",
    });
    if (response.ok) {
      setConfidence((await response.json()) as ProjectConfidenceView);
    }
  }, []);

  useEffect(() => {
    if (selectedProjectId) {
      setWorkers(null);
      setDetail(null);
      setConfidence(null);
      void refreshWorkers(selectedProjectId);
      void refreshConfidence(selectedProjectId);
    }
  }, [selectedProjectId, refreshWorkers, refreshConfidence]);

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
          void refreshConfidence(projectId);
        }
        if (event.workerId === selectedWorkerRef.current) {
          void refreshDetail(event.workerId);
        }
      }
      if (event.type === "worker_plan" && event.projectId === projectId && projectId) {
        // The checklist moved: the card's count/bar and the open goal card
        // both re-fetch (the broadcast carries ids only, by design).
        void refreshWorkers(projectId);
        if (event.workerId === selectedWorkerRef.current) {
          void refreshDetail(event.workerId);
        }
      }
      if (
        projectId &&
        (event.type === "monitor_tick" ||
          event.type === "attention_changed" ||
          event.type === "digest_reviewed") &&
        event.projectId === projectId
      ) {
        // The monitor's tick moves gauges without any user action (evidence
        // freshness, staleness), and attention changes move both surfaces.
        void refreshConfidence(projectId);
        if (event.type !== "monitor_tick") {
          void refreshWorkers(projectId);
          if (selectedWorkerRef.current) {
            void refreshDetail(selectedWorkerRef.current);
          }
        }
      }
    };
    return () => source.close();
  }, [refreshDetail, refreshWorkers, refreshConfidence]);

  // Hold: pause without ending — the honest middle ground before Stop.
  const holdWorker = useCallback(
    async (workerId: string) => {
      setHolding(true);
      try {
        const response = await fetch("/api/workers/hold", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workerId }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          response?: string | null;
        };
        setStopNote({
          workerId,
          text: !response.ok
            ? (payload.error ?? `Hold failed (${response.status}).`)
            : payload.response
              ? `Held. The worker's position: ${payload.response}`
              : "Hold delivered — the worker has not acknowledged yet; its next reply will state where it is.",
        });
      } catch (fetchError) {
        setStopNote({
          workerId,
          text: `Hold failed: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`,
        });
      } finally {
        setHolding(false);
      }
      void refreshDetail(workerId);
    },
    [refreshDetail],
  );

  const detailForSelection = detail && detail.worker.id === selectedWorkerId ? detail : null;
  const confidenceByWorker = new Map(
    (confidence?.workers ?? []).map((entry) => [entry.workerId, entry]),
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title">
          GALAPAGOS <span>/ Workers</span>
        </div>
        {confidence ? (
          <ConfidenceGauge report={confidence.project} label="project" compact />
        ) : null}
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
              {[...workers].reverse().map((worker) => {
                const workerConfidence = confidenceByWorker.get(worker.id) ?? null;
                return (
                  <button
                    key={worker.id}
                    className={`worker-card${worker.id === selectedWorkerId ? " selected" : ""}`}
                    onClick={() => setSelectedWorkerId(worker.id)}
                  >
                    <div className="worker-card-head">
                      <span className="lane-name">{worker.laneName ?? "(lane missing)"}</span>
                      <StatusPill status={worker.status} />
                    </div>
                    {worker.goal ? <div className="worker-goal">{worker.goal}</div> : null}
                    {worker.stepsTotal > 0 ? (
                      <div className="worker-plan-line">
                        <span className="plan-count mono">
                          {worker.stepsDone}/{worker.stepsTotal}
                        </span>
                        <PlanBar done={worker.stepsDone} total={worker.stepsTotal} />
                        {worker.activeStepTitle ? (
                          <span className="plan-active">{worker.activeStepTitle}</span>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="worker-card-sub">
                      <span className="liveness">{agoLabel(worker.lastMessageAt, now)}</span>
                      {worker.openAttentionCount > 0 ? (
                        <span className="attention-count">
                          {worker.openAttentionCount} attention
                        </span>
                      ) : null}
                      {worker.hasDigest ? <span className="digest-mark">digest</span> : null}
                    </div>
                    {workerConfidence ? (
                      <ConfidenceGauge
                        report={workerConfidence.report}
                        label={worker.laneName ?? worker.id}
                        compact
                      />
                    ) : null}
                    {worker.lastSummary ? (
                      <div className="worker-card-summary">{worker.lastSummary}</div>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {detailForSelection ? (
              <Drilldown
                detail={detailForSelection}
                confidence={confidenceByWorker.get(detailForSelection.worker.id) ?? null}
                computedAt={confidence?.computedAt ?? null}
                now={now}
                stopping={stopping}
                holding={holding}
                stopNote={
                  stopNote && stopNote.workerId === detailForSelection.worker.id
                    ? stopNote.text
                    : null
                }
                onStop={() => void stopWorker(detailForSelection.worker.id)}
                onHold={() => void holdWorker(detailForSelection.worker.id)}
                projectId={selectedProjectId}
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
