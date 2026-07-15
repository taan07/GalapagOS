"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseUserTurnContent, type OutgoingAttachment } from "../core/attachments";
import type {
  AttachmentView,
  AttentionView,
  AutonomyModeView,
  ChatItem,
  DaemonStreamEvent,
  DecisionView,
  LiveTurnStatusView,
  ManagerStreamEvent,
  ProjectConfidenceView,
  ProjectView,
  QueuedMessage,
  RebriefView,
  SpecificView,
  ToolChip,
  TurnView,
} from "./types";
import { AttentionQueue } from "./attention-queue";
import { Chat } from "./chat";
import { loadQueue, saveQueue } from "./queue-store";
import { createNeedsYouCue } from "./needs-you";
import { ConfidenceGauge } from "./confidence";
import { AddProjectForm, ProjectPicker } from "./project-picker";
import { SpecificsPanel } from "./specifics-panel";
import {
  createProjectActivityModel,
  createProjectRecoveryModel,
  createSingleFlightReconciler,
  type StreamConnectionState,
} from "../core/live-recovery";

const LAST_PROJECT_KEY = "galapagos.lastProjectId";
// The fallback model when Fable's usage limit is reached (see the "change to
// Opus" action on a limit-reached turn error).
const OPUS_MODEL = "claude-opus-4-8";

type MainProjectSnapshot = {
  turns: TurnView[] | null;
  live: { busy: boolean; status: LiveTurnStatusView | null; text: string } | null;
  specifics: SpecificView[] | null;
  attention: AttentionView[] | null;
  confidence: ProjectConfidenceView | null;
  projects: ProjectView[] | null;
};

function turnsToChatItems(turns: TurnView[]): ChatItem[] {
  return turns.flatMap((turn): ChatItem[] => {
    const at = turn.created_at;
    if (turn.role === "user") {
      // Attachment-bearing turns persist as a JSON payload; everything else
      // is the raw text (the parser is tolerant by contract). Bytes stay on
      // disk — the view carries only the serve-route URL.
      const { text, attachments } = parseUserTurnContent(turn.content);
      return [
        {
          kind: "user",
          text,
          at,
          ...(attachments.length > 0
            ? {
                attachments: attachments.map(
                  (attachment): AttachmentView => ({
                    kind: attachment.kind,
                    name: attachment.name,
                    size: attachment.size,
                    url: `/api/${attachment.path}`,
                  }),
                ),
              }
            : {}),
        },
      ];
    }
    if (turn.role === "assistant") {
      // History folds; live replies don't (they get the folded flag only on
      // the next reload, once they're something you scroll back to).
      return [{ kind: "assistant", text: turn.content, at, folded: true }];
    }
    if (turn.role === "tool") {
      try {
        const chip = JSON.parse(turn.content) as ToolChip;
        return [{ kind: "chip", chip, at }];
      } catch {
        return [];
      }
    }
    // System turns carry structured payloads (re-briefs, notes, decisions)
    // since Chunk 2; plain text stays a note for backward compatibility.
    try {
      const payload = JSON.parse(turn.content) as
        | { kind: "rebrief"; reason: string; preamble: string | null; clearedAt: string | null }
        | ({ kind: "decision" } & DecisionView)
        | { kind: "note"; text: string };
      if (payload.kind === "decision") {
        return [
          {
            kind: "decision",
            at,
            decision: {
              decisionId: payload.decisionId,
              cardKind: payload.cardKind ?? "decision",
              question: payload.question,
              options: payload.options,
              multiSelect: payload.multiSelect,
              fields: payload.fields ?? [],
              status: payload.status,
              selections: payload.selections,
              responses: payload.responses ?? {},
              custom: payload.custom,
            },
          },
        ];
      }
      if (payload.kind === "rebrief") {
        return [
          {
            kind: "rebrief",
            at,
            rebrief: {
              turnId: turn.id,
              reason: payload.reason,
              preamble: payload.preamble,
              cleared: payload.clearedAt !== null,
            },
          },
        ];
      }
      if (payload.kind === "note") {
        return [{ kind: "note", text: payload.text, at }];
      }
    } catch {
      // fall through to plain text
    }
    return [{ kind: "note", text: turn.content, at }];
  });
}

export function App() {
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [specifics, setSpecifics] = useState<SpecificView[]>([]);
  const [attention, setAttention] = useState<AttentionView[] | null>(null);
  const [confidence, setConfidence] = useState<ProjectConfidenceView | null>(null);
  const [working, setWorking] = useState(false);
  // The living turn: Darwin's prose streaming in (the unsettled tail below
  // the item list) and the status line naming what he's doing right now.
  const [liveText, setLiveText] = useState("");
  const [liveStatus, setLiveStatus] = useState<LiveTurnStatusView | null>(null);
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const [daemonDown, setDaemonDown] = useState(false);
  const [streamConnection, setStreamConnection] = useState<StreamConnectionState>("connecting");
  const [showAddProject, setShowAddProject] = useState(false);
  const projectActivityRef = useRef(createProjectActivityModel<QueuedMessage>());
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  // The POST stream is authoritative while attached: the tab that owns an
  // in-flight /manager/message stream ignores /events turn traffic (it sees
  // the same events firsthand); only a tab WITHOUT a live POST stream — a
  // reload mid-turn, a second window — consumes the broadcast copies.
  // A COUNT, not a boolean: turn N's stream stays open through its post-turn
  // distill while turn N+1 already streams (the drain path), and the earliest
  // finally must not disarm the gate under the later turn.
  // Turn events from /events are held off until this project's history has
  // loaded — applying a broadcast onto an empty item list would be wiped by
  // the history fetch resolving a moment later.
  const historyLoadedForRef = useRef<string | null>(null);
  const recoveryRef = useRef(createProjectRecoveryModel<MainProjectSnapshot>());
  const reconciliationRef = useRef(createSingleFlightReconciler());
  const deferredHistoryRef = useRef(new Set<string>());
  const daemonDownRef = useRef(false);

  const postStreamOwns = (projectId: string) =>
    projectActivityRef.current.ownsStream(projectId);
  const queueFor = useCallback((projectId: string): QueuedMessage[] => {
    return projectActivityRef.current.queue(projectId, () =>
      loadQueue(window.localStorage, projectId),
    );
  }, []);

  const now = () => new Date().toISOString();

  // The latest still-pending card, if any. The chat composer routes free text
  // to it instead of starting a new turn (2026-07-08 ruling).
  let pendingDecision: DecisionView | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item && item.kind === "decision" && item.decision.status === "pending") {
      pendingDecision = item.decision;
      break;
    }
  }
  const pendingDecisionRef = useRef<DecisionView | null>(null);
  pendingDecisionRef.current = pendingDecision;

  const selected = projects?.find((project) => project.id === selectedId) ?? null;

  const refreshProjects = useCallback(async () => {
    const response = await fetch("/api/projects", { cache: "no-store" });
    const payload = (await response.json()) as { projects: ProjectView[] };
    setProjects(payload.projects);
    setSelectedId((current) => {
      const exists = (id: string | null) =>
        id !== null && payload.projects.some((project) => project.id === id);
      if (exists(current)) {
        return current;
      }
      const remembered = localStorage.getItem(LAST_PROJECT_KEY);
      if (exists(remembered)) {
        return remembered;
      }
      return payload.projects[0]?.id ?? null;
    });
  }, []);

  // Remember the focused project so reopening the app lands where you left off.
  useEffect(() => {
    if (selectedId) {
      localStorage.setItem(LAST_PROJECT_KEY, selectedId);
    }
  }, [selectedId]);

  /** Fetch the entire selected-project truth as one generation-scoped unit. */
  const reconcileProject = useCallback(async (projectId: string) => {
    return reconciliationRef.current.run(projectId, async () => {
      const ticket = recoveryRef.current.begin(projectId);
      const json = async <T,>(url: string): Promise<T | null> => {
        try {
          const response = await fetch(url, { cache: "no-store" });
          return response.ok ? ((await response.json()) as T) : null;
        } catch {
          return null;
        }
      };
      // A locally attached POST is the only source allowed to replace its
      // live tail. It does not stop the rest of recovery (attention,
      // confidence, metadata) from repairing after sleep.
      const postOwnsHistory = postStreamOwns(projectId);
      const previous = recoveryRef.current.cached(projectId);
      const [history, live, specificsPayload, attentionPayload, confidencePayload, projectsPayload] =
        await Promise.all([
          postOwnsHistory
            ? Promise.resolve(null)
            : json<{ turns: TurnView[] }>(`/api/manager/history?projectId=${encodeURIComponent(projectId)}`),
          postOwnsHistory
            ? Promise.resolve(null)
            : json<{ busy: boolean; status: LiveTurnStatusView | null; text: string }>(
                `/api/manager/live?projectId=${encodeURIComponent(projectId)}`,
              ),
          json<{ specifics: SpecificView[] }>(`/api/specifics?projectId=${encodeURIComponent(projectId)}`),
          json<{ items: AttentionView[] }>(`/api/attention?projectId=${encodeURIComponent(projectId)}`),
          json<ProjectConfidenceView>(`/api/confidence?projectId=${encodeURIComponent(projectId)}`),
          json<{ projects: ProjectView[] }>("/api/projects"),
        ]);
      // A POST may begin while the HTTP reads are in flight. In that case the
      // fetched history predates the optimistic/streamed tail and must not
      // replace either rendered state or the per-project cache.
      const postOwnsAtCompletion = postStreamOwns(projectId);
      const preserveHistory = postOwnsHistory || postOwnsAtCompletion;
      if (preserveHistory) deferredHistoryRef.current.add(projectId);
      const snapshot: MainProjectSnapshot = {
        turns: preserveHistory ? (previous?.turns ?? null) : (history?.turns ?? null),
        live: preserveHistory ? (previous?.live ?? null) : live,
        specifics: specificsPayload?.specifics ?? null,
        attention: attentionPayload?.items ?? null,
        confidence: confidencePayload,
        projects: projectsPayload?.projects ?? null,
      };
      if (!recoveryRef.current.store(ticket, snapshot)) return;
      // selectedIdRef moves during render, before the selection effect updates
      // the recovery model. Guard both to close that navigation window.
      if (selectedIdRef.current !== projectId || !recoveryRef.current.mayApply(ticket)) return;
      if (snapshot.projects) setProjects(snapshot.projects);
      if (snapshot.specifics) setSpecifics(snapshot.specifics);
      if (snapshot.attention) setAttention(snapshot.attention);
      if (snapshot.confidence) setConfidence(snapshot.confidence);
      if (snapshot.turns && !postStreamOwns(projectId)) {
        setItems(turnsToChatItems(snapshot.turns));
        historyLoadedForRef.current = projectId;
      }
      if (snapshot.live && !postStreamOwns(projectId)) {
        setWorking(snapshot.live.busy);
        setLiveStatus(snapshot.live.busy ? (snapshot.live.status ?? { status: "thinking", label: "Thinking" }) : null);
        setLiveText(snapshot.live.busy ? snapshot.live.text : "");
      }
    });
  }, []);

  const checkDaemon = useCallback(async () => {
    let down = true;
    try {
      const response = await fetch("/api/daemon-health", { cache: "no-store" });
      down = !response.ok;
    } catch {
      down = true;
    }
    const wasDown = daemonDownRef.current;
    daemonDownRef.current = down;
    setDaemonDown(down);
    if (wasDown && !down && selectedIdRef.current) {
      void reconcileProject(selectedIdRef.current);
    }
  }, [reconcileProject]);

  useEffect(() => {
    void refreshProjects();
    void checkDaemon();
    const interval = setInterval(() => void checkDaemon(), 10_000);
    return () => clearInterval(interval);
  }, [refreshProjects, checkDaemon]);

  useEffect(() => {
    if (!selectedId) {
      return;
    }
    recoveryRef.current.select(selectedId);
    const cached = recoveryRef.current.cached(selectedId);
    setItems([]);
    setLiveText("");
    setLiveStatus(null);
    setSpecifics([]);
    setAttention(null);
    setConfidence(null);
    historyLoadedForRef.current = null;
    // The queue survives reloads and project hops (turn-attach): same
    // per-project localStorage contract as the composer draft.
    const selectedQueue = loadQueue(window.localStorage, selectedId);
    projectActivityRef.current.replaceQueue(selectedId, selectedQueue);
    setQueued([...selectedQueue]);
    setWorking(false);
    if (cached) {
      if (cached.turns) {
        setItems(turnsToChatItems(cached.turns));
        historyLoadedForRef.current = selectedId;
      }
      if (cached.specifics) setSpecifics(cached.specifics);
      if (cached.attention) setAttention(cached.attention);
      if (cached.confidence) setConfidence(cached.confidence);
    }
    void reconcileProject(selectedId);
  }, [selectedId, reconcileProject]);

  // Live updates from the daemon: the monitor's tick keeps the gauge honest
  // (evidence freshness moves without any user action), attention changes
  // re-pull the queue, and triage's escalated questions land in the chat.
  useEffect(() => {
    const source = new EventSource("/api/events");
    // SSE has no replay: a turn_complete broadcast during a reconnect gap is
    // gone for good, and a tab relying on it (the busyElsewhere path) would
    // stay locked forever. Every (re)open re-syncs working from the daemon's
    // live state — skipped while a POST stream is attached (it is the truth).
    source.onopen = () => {
      recoveryRef.current.setConnection("live");
      setStreamConnection("live");
      const projectId = selectedIdRef.current;
      if (projectId) void reconcileProject(projectId);
    };
    source.onerror = () => {
      recoveryRef.current.setConnection("reconnecting");
      setStreamConnection("reconnecting");
    };
    source.onmessage = (message) => {
      let event: DaemonStreamEvent;
      try {
        event = JSON.parse(message.data as string) as DaemonStreamEvent;
      } catch {
        return;
      }
      // Mode flips update the projects list for WHICHEVER project changed —
      // handled before the selected-project filter so switching back never
      // shows a stale pill.
      if (event.type === "autonomy_mode") {
        setProjects((current) =>
          current
            ? current.map((project) =>
                project.id === event.projectId
                  ? { ...project, autonomy_mode: event.mode }
                  : project,
              )
            : current,
        );
        return;
      }
      const projectId = selectedIdRef.current;
      if (!projectId || !("projectId" in event)) {
        return;
      }
      if (event.projectId !== projectId) {
        // Background projects never mutate the rendered selection. Stable
        // events refresh only that project's cache so switching back can show
        // durable truth immediately, followed by the ordinary selected fetch.
        if (event.type !== "assistant_delta" && event.type !== "turn_status") {
          void reconcileProject(event.projectId);
        }
        return;
      }
      if (event.type === "attention_changed") {
        void reconcileProject(projectId);
      } else if (event.type === "monitor_tick" || event.type === "digest_reviewed") {
        void reconcileProject(projectId);
      } else if (event.type === "manager_note") {
        const text = event.text;
        setItems((current) =>
          current.some((item) => item.kind === "note" && item.text === text)
            ? current
            : [...current, { kind: "note", text, at: now() }],
        );
        void reconcileProject(projectId);
      } else if (event.type === "decision_request") {
        // Broadcast copy of a card. The initiating tab already appended it
        // from its own stream — only tabs that DIDN'T see it add the card
        // (autonomous turns, second windows). pendingDecision then drives
        // the needs-you cue in every tab.
        setItems((current) =>
          current.some(
            (item) => item.kind === "decision" && item.decision.decisionId === event.decisionId,
          )
            ? current
            : [
                ...current,
                {
                  kind: "decision",
                  at: now(),
                  decision: {
                    decisionId: event.decisionId,
                    cardKind: event.cardKind,
                    question: event.question,
                    options: event.options,
                    multiSelect: event.multiSelect,
                    fields: event.fields,
                    status: "pending",
                    selections: [],
                    responses: {},
                    custom: "",
                  },
                },
              ],
        );
      } else if (event.type === "decision_settled") {
        setItems((current) =>
          current.map((item) =>
            item.kind === "decision" && item.decision.decisionId === event.decisionId
              ? {
                  ...item,
                  decision: {
                    ...item.decision,
                    status: event.status,
                    selections: event.selections,
                    responses: event.responses,
                    custom: event.custom,
                  },
                }
              : item,
          ),
        );
      } else if (
        event.type === "turn_started" ||
        event.type === "turn_status" ||
        event.type === "assistant_delta" ||
        event.type === "assistant_text" ||
        event.type === "tool_use" ||
        event.type === "rebrief" ||
        event.type === "interrupted" ||
        event.type === "distilled" ||
        event.type === "turn_complete" ||
        event.type === "turn_error"
      ) {
        // The re-attach path (turn-attach): a tab WITHOUT the initiating POST
        // stream follows the living turn from the broadcast. The initiating
        // tab drops these — its own stream already delivered them — and
        // nothing applies until history has loaded, or the fetch resolving
        // would wipe what we appended.
        if (postStreamOwns(projectId) || historyLoadedForRef.current !== projectId) {
          return;
        }
        if (event.type === "turn_started") {
          setWorking(true);
          setLiveText("");
          setLiveStatus({ status: "thinking", label: "Thinking" });
        } else if (event.type === "turn_status") {
          setWorking(true);
          setLiveStatus({
            status: event.status,
            label: event.label,
            ...(event.tool ? { tool: event.tool } : {}),
          });
        } else if (event.type === "assistant_delta") {
          setLiveText((current) => current + event.text);
        } else if (event.type === "assistant_text") {
          const text = event.text;
          setLiveText("");
          // The same settled block may already be in the items when the
          // history fetch raced the broadcast — content-match the tail
          // instead of trusting order.
          setItems((current) =>
            current
              .slice(-5)
              .some((item) => item.kind === "assistant" && item.text === text)
              ? current
              : [...current, { kind: "assistant", text, at: now() }],
          );
        } else if (event.type === "tool_use") {
          // Same fetch-races-broadcast straddle as assistant_text: a chip
          // persisted before the history DB-read whose broadcast lands after
          // the load would double-render without a content match on the tail.
          const chip = { tool: event.tool, summary: event.summary, detail: event.detail };
          setItems((current) =>
            current
              .slice(-5)
              .some(
                (item) =>
                  item.kind === "chip" &&
                  item.chip.tool === chip.tool &&
                  item.chip.summary === chip.summary &&
                  item.chip.detail === chip.detail,
              )
              ? current
              : [...current, { kind: "chip", chip, at: now() }],
          );
          if (event.tool === "record_specific") {
            void reconcileProject(projectId);
          }
        } else if (event.type === "rebrief") {
          setLiveText("");
          setItems((current) => [
            ...current,
            {
              kind: "rebrief",
              at: now(),
              rebrief: {
                turnId: event.turnId,
                reason: event.reason,
                preamble: event.preamble,
                cleared: false,
              },
            },
          ]);
        } else if (event.type === "interrupted") {
          setLiveText("");
          setLiveStatus(null);
          setItems((current) => [...current, { kind: "note", text: event.message, at: now() }]);
        } else if (event.type === "distilled") {
          if (event.recordsWritten > 0 || event.commitSkippedReason || event.error) {
            void reconcileProject(projectId);
          }
        } else if (event.type === "turn_complete") {
          setWorking(false);
          setLiveStatus(null);
          setLiveText("");
        } else if (event.type === "turn_error") {
          // No failedText here (the message belongs to whichever context sent
          // it), so the limit-retry card stays with the initiating tab; a
          // re-attached tab gets the honest note and an unlocked composer.
          setWorking(false);
          setLiveStatus(null);
          setLiveText("");
          setItems((current) => [
            ...current,
            { kind: "note", text: `Turn failed: ${event.message}`, at: now() },
          ]);
        }
      }
    };
    return () => source.close();
  }, [reconcileProject]);

  // Laptop sleep commonly leaves an EventSource half-open. These triggers
  // repair from HTTP truth even before the browser notices the socket died.
  useEffect(() => {
    const recover = () => {
      const projectId = selectedIdRef.current;
      if (projectId) void reconcileProject(projectId);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") recover();
    };
    window.addEventListener("focus", recover);
    window.addEventListener("online", recover);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", recover);
      window.removeEventListener("online", recover);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reconcileProject]);

  // The needs-you cue: a pending card + an unfocused tab = tab-title flash,
  // favicon badge, and a macOS notification (permission asked lazily). The
  // cue clears on focus or the moment the card settles. Same project only —
  // the /events handler above already drops other projects' events.
  const cueRef = useRef<ReturnType<typeof createNeedsYouCue> | null>(null);
  const pendingCueId = pendingDecision?.decisionId ?? null;
  const pendingCueQuestion = pendingDecision?.question ?? "";
  useEffect(() => {
    cueRef.current ??= createNeedsYouCue();
    if (pendingCueId) {
      cueRef.current.arm(pendingCueQuestion || "Darwin has a question for you.");
    } else {
      cueRef.current.disarm();
    }
  }, [pendingCueId, pendingCueQuestion]);

  const sendNow = useCallback(
    async (
      projectId: string,
      text: string,
      options?: {
        model?: string;
        echoUser?: boolean;
        requeueAtHead?: boolean;
        attachments?: OutgoingAttachment[];
      },
    ): Promise<void> => {
      const attachments = options?.attachments ?? [];
      if (selectedIdRef.current === projectId) {
        setWorking(true);
        setLiveText("");
        setLiveStatus({ status: "thinking", label: "Thinking" });
      }
      // While this fetch streams, /events turn traffic is a duplicate feed —
      // armed before the request so the first broadcast can never race it.
      projectActivityRef.current.beginStream(projectId);
      // A 409 hands the turn lock to someone else (another tab, an autonomous
      // turn): the message queues instead of dying, and `working` must stay
      // armed past the finally — /events drives it from here.
      let busyElsewhere = false;
      // The Opus retry doesn't re-echo the user bubble — the failed message is
      // already on screen above the limit note.
      if (options?.echoUser !== false) {
        // The optimistic bubble renders attachments from local bytes (data:
        // for images, a blob: URL for pasted text); once the turn persists, a
        // reload swaps them for the serve-route URLs.
        const echoAttachments = attachments.map(
          (attachment): AttachmentView =>
            attachment.kind === "image"
              ? {
                  kind: "image",
                  name: attachment.name,
                  size: attachment.size,
                  url: `data:${attachment.mediaType};base64,${attachment.data}`,
                }
              : {
                  kind: "text",
                  name: attachment.name,
                  size: attachment.size,
                  url: URL.createObjectURL(
                    new Blob([attachment.text], { type: "text/plain" }),
                  ),
                },
        );
        if (selectedIdRef.current === projectId) {
          setItems((current) => [
            ...current,
            {
              kind: "user",
              text,
              at: now(),
              ...(echoAttachments.length > 0 ? { attachments: echoAttachments } : {}),
            },
          ]);
        }
      }
      try {
        const response = await fetch("/api/manager/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId,
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(options?.model ? { model: options.model } : {}),
          }),
        });

        if (!response.ok || !response.body) {
          const payload = (await response.json().catch(() => ({}))) as {
            error?: string;
            busy?: boolean;
          };
          if (response.status === 409 && payload.busy) {
            // Darwin is mid-turn (a re-attached page raced the drain, or a
            // second tab owns the turn): queue the message instead of
            // rendering a dead error note. The optimistic bubble comes back
            // when the queue drains and the send re-echoes it.
            busyElsewhere = true;
            const queuedMessage = {
              id: crypto.randomUUID(),
              text,
              ...(attachments.length > 0 ? { attachments } : {}),
            };
            const projectQueue = queueFor(projectId);
            if (options?.requeueAtHead) {
              // A drained message that bounced goes back to the FRONT — it
              // was the head of the queue; re-queuing it behind later
              // messages would violate FIFO on contention.
              projectQueue.unshift(queuedMessage);
            } else {
              projectQueue.push(queuedMessage);
            }
            saveQueue(window.localStorage, projectId, projectQueue);
            if (selectedIdRef.current === projectId) setQueued([...projectQueue]);
            // The unlock normally arrives as a /events turn_complete — but a
            // 409 can land in the daemon's tiny post-complete window where
            // busy is still held and THAT event was already consumed by our
            // own POST stream. One delayed live-state check heals the stuck
            // case; if busy is genuinely held, /events keeps driving.
            setTimeout(() => {
              if (selectedIdRef.current !== projectId || postStreamOwns(projectId)) {
                return;
              }
              void fetch(`/api/manager/live?projectId=${encodeURIComponent(projectId)}`, {
                cache: "no-store",
              })
                .then((live) => (live.ok ? (live.json() as Promise<{ busy: boolean }>) : null))
                .then((payload) => {
                  if (payload && !payload.busy && selectedIdRef.current === projectId) {
                    setWorking(false);
                  }
                })
                .catch(() => {});
            }, 2000);
            if (options?.echoUser !== false && selectedIdRef.current === projectId) {
              setItems((current) => {
                for (let i = current.length - 1; i >= 0; i--) {
                  const item = current[i];
                  if (item && item.kind === "user" && item.text === text) {
                    return [...current.slice(0, i), ...current.slice(i + 1)];
                  }
                }
                return current;
              });
            }
            return;
          }
          if (selectedIdRef.current === projectId) {
            setItems((current) => [
              ...current,
              { kind: "note", text: payload.error ?? `Send failed (${response.status}).` },
            ]);
          }
          setDaemonDown(response.status === 502);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const dataLine = frame
              .split("\n")
              .find((line) => line.startsWith("data: "));
            if (!dataLine) {
              continue;
            }
            const event = JSON.parse(dataLine.slice(6)) as ManagerStreamEvent;
            if (selectedIdRef.current !== projectId) {
              continue;
            }
            if (event.type === "turn_complete") {
              // The turn is over — unlock the input NOW. The stream stays
              // open only to deliver the post-turn distillation note; the
              // daemon accepts the next message the moment this event fires.
              setWorking(false);
              setLiveStatus(null);
              setLiveText("");
            } else if (event.type === "turn_status") {
              setLiveStatus({
                status: event.status,
                label: event.label,
                ...(event.tool ? { tool: event.tool } : {}),
              });
            } else if (event.type === "assistant_delta") {
              setLiveText((current) => current + event.text);
            } else if (event.type === "assistant_text") {
              // The settled block replaces whatever streamed — deltas are a
              // preview, the persisted turn is the truth.
              setLiveText("");
              setItems((current) => [
                ...current,
                { kind: "assistant", text: event.text, at: now() },
              ]);
            } else if (event.type === "tool_use") {
              setItems((current) => [
                ...current,
                { kind: "chip", chip: { tool: event.tool, summary: event.summary, detail: event.detail }, at: now() },
              ]);
              if (event.tool === "record_specific") {
                void reconcileProject(projectId);
              }
            } else if (event.type === "rebrief") {
              // A rebrief means the turn is being retried on a fresh session —
              // whatever streamed from the failed attempt was never persisted.
              setLiveText("");
              setItems((current) => [
                ...current,
                {
                  kind: "rebrief",
                  at: now(),
                  rebrief: {
                    turnId: event.turnId,
                    reason: event.reason,
                    preamble: event.preamble,
                    cleared: false,
                  },
                },
              ]);
            } else if (event.type === "interrupted") {
              // Mid-block partials were never persisted; drop the live tail so
              // the screen matches what a reload would show.
              setLiveText("");
              setLiveStatus(null);
              setItems((current) => [...current, { kind: "note", text: event.message, at: now() }]);
            } else if (event.type === "decision_request") {
              // The daemon also broadcasts cards (for other tabs); whichever
              // copy lands first wins, the other is dropped by decisionId.
              setItems((current) =>
                current.some(
                  (item) =>
                    item.kind === "decision" && item.decision.decisionId === event.decisionId,
                )
                  ? current
                  : [
                      ...current,
                      {
                        kind: "decision",
                        at: now(),
                        decision: {
                          decisionId: event.decisionId,
                          cardKind: event.cardKind,
                          question: event.question,
                          options: event.options,
                          multiSelect: event.multiSelect,
                          fields: event.fields,
                          status: "pending",
                          selections: [],
                          responses: {},
                          custom: "",
                        },
                      },
                    ],
              );
            } else if (event.type === "decision_settled") {
              setItems((current) =>
                current.map((item) =>
                  item.kind === "decision" && item.decision.decisionId === event.decisionId
                    ? {
                        ...item,
                        decision: {
                          ...item.decision,
                          status: event.status,
                          selections: event.selections,
                          responses: event.responses,
                          custom: event.custom,
                        },
                      }
                    : item,
                ),
              );
            } else if (event.type === "distilled") {
              // Silent when nothing durable happened; visible when memory
              // changed or when a records commit had to be skipped.
              const notes: string[] = [];
              if (event.recordsWritten > 0) {
                notes.push(
                  `Distilled ${event.recordsWritten} record${event.recordsWritten === 1 ? "" : "s"} into durable memory${event.committed ? " (committed)" : ""}.`,
                );
              }
              if (event.commitSkippedReason) {
                notes.push(`Records commit skipped: ${event.commitSkippedReason}`);
              }
              if (event.error) {
                notes.push(`Distillation failed: ${event.error}`);
              }
              if (notes.length > 0) {
                setItems((current) => [
                  ...current,
                  ...notes.map((text) => ({ kind: "note" as const, text, at: now() })),
                ]);
              }
              void reconcileProject(projectId);
            } else if (event.type === "turn_error") {
              // A usage limit on Fable is recoverable: offer the Opus switch
              // instead of a dead error note. Once Darwin is already on Opus,
              // there's nothing to switch to — fall back to a plain note.
              if (event.limitReached && event.model && event.model !== OPUS_MODEL) {
                setItems((current) => [
                  ...current,
                  {
                    kind: "limit",
                    at: now(),
                    message: event.message,
                    failedText: text,
                    model: event.model as string,
                  },
                ]);
              } else {
                setItems((current) => [
                  ...current,
                  { kind: "note", text: `Turn failed: ${event.message}`, at: now() },
                ]);
              }
            }
          }
        }
      } catch (error) {
        if (selectedIdRef.current === projectId) {
          setItems((current) => [
            ...current,
            {
              kind: "note",
              text: `Connection lost mid-turn: ${error instanceof Error ? error.message : String(error)}`,
              at: now(),
            },
          ]);
        }
      } finally {
        const remaining = projectActivityRef.current.endStream(projectId);
        if (remaining === 0) {
          if (deferredHistoryRef.current.delete(projectId)) {
            void reconcileProject(projectId);
          }
        }
        if (!busyElsewhere && selectedIdRef.current === projectId) {
          setWorking(false);
          setLiveStatus(null);
          setLiveText("");
        }
      }
    },
    [queueFor, reconcileProject],
  );

  // The Shift+Tab autonomy axis: cycle the persisted per-project stop. The
  // daemon owns the truth (doctrine + tool allowlist change server-side); the
  // pill updates optimistically and the broadcast reconciles every tab.
  const autonomyMode: AutonomyModeView = selected?.autonomy_mode ?? "default";
  const handleCycleMode = useCallback(() => {
    const projectId = selectedIdRef.current;
    if (!projectId || daemonDown) {
      return;
    }
    const current =
      projects?.find((project) => project.id === projectId)?.autonomy_mode ?? "default";
    const next: AutonomyModeView =
      current === "interview" ? "default" : current === "default" ? "auto" : "interview";
    setProjects((existing) =>
      existing
        ? existing.map((project) =>
            project.id === projectId ? { ...project, autonomy_mode: next } : project,
          )
        : existing,
    );
    void fetch("/api/manager/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, mode: next }),
    }).then((response) => {
      if (!response.ok) {
        // The daemon refused (or is down): re-pull the truth, never render a
        // mode Darwin isn't actually in.
        void refreshProjects();
      }
    });
  }, [projects, daemonDown, refreshProjects]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !event.shiftKey) {
        return;
      }
      // The axis owns Shift+Tab in the composer (the muscle memory) and on
      // an unfocused page — but NEVER over other interactive elements, where
      // Shift+Tab is reverse focus-navigation and hijacking it would strand
      // keyboard users (review finding).
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      const inComposer = tag === "TEXTAREA";
      const inOtherInteractive =
        !inComposer &&
        (tag === "INPUT" ||
          tag === "SELECT" ||
          tag === "BUTTON" ||
          tag === "A" ||
          (target?.isContentEditable ?? false));
      if (inOtherInteractive) {
        return;
      }
      event.preventDefault();
      handleCycleMode();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleCycleMode]);

  // Triple-Esc within ~a second force-interrupts the in-flight turn, so a
  // queued message gets through without waiting Darwin out.
  const escPressesRef = useRef<number[]>([]);
  useEffect(() => {
    if (!working || !selectedId) {
      escPressesRef.current = [];
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      const now = Date.now();
      escPressesRef.current = [...escPressesRef.current.filter((t) => now - t < 900), now];
      if (escPressesRef.current.length >= 3) {
        escPressesRef.current = [];
        void fetch("/api/manager/interrupt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: selectedId }),
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [working, selectedId]);

  // Drain the queue whenever Darwin finishes a turn — and on load, when a
  // reload restored a persisted queue against an idle daemon. `queued` in the
  // deps is what makes the on-load drain fire; a drain that races a turn
  // someone else started comes back as a 409 and re-queues.
  useEffect(() => {
    if (working || !selectedId) {
      return;
    }
    const projectQueue = queueFor(selectedId);
    if (projectQueue.length === 0) return;
    const next = projectQueue.shift();
    saveQueue(window.localStorage, selectedId, projectQueue);
    setQueued([...projectQueue]);
    if (next) {
      void sendNow(selectedId, next.text, {
        requeueAtHead: true,
        ...(next.attachments && next.attachments.length > 0
          ? { attachments: next.attachments }
          : {}),
      });
    }
  }, [working, selectedId, sendNow, queued, queueFor]);

  // Steering a queued message: bump it to the head of the queue and interrupt
  // the in-flight turn. The interrupt ends the turn → `working` flips false →
  // the drain effect above sends the steered message as the next turn, with
  // Darwin's context refreshed by whatever the interrupted turn got done.
  const handleQueueSteer = useCallback(
    (id: string) => {
      if (!selectedId) return;
      const projectQueue = queueFor(selectedId);
      const index = projectQueue.findIndex((message) => message.id === id);
      if (index === -1) {
        return;
      }
      const [steered] = projectQueue.splice(index, 1);
      if (steered) {
        projectQueue.unshift(steered);
      }
      saveQueue(window.localStorage, selectedId, projectQueue);
      setQueued([...projectQueue]);
      if (working) {
        void fetch("/api/manager/interrupt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: selectedId }),
        });
      }
    },
    [working, selectedId, queueFor],
  );

  const handleQueueRemove = useCallback(
    (id: string) => {
      if (!selectedId) return;
      const remaining = queueFor(selectedId).filter((message) => message.id !== id);
      projectActivityRef.current.replaceQueue(selectedId, remaining);
      saveQueue(window.localStorage, selectedId, remaining);
      setQueued([...remaining]);
    },
    [selectedId, queueFor],
  );

  // "Change to Opus": switch this project's manager model and re-send the
  // message that hit Fable's limit. The daemon remembers the switch, so every
  // later turn stays on Opus until it restarts.
  const handleSwitchToOpus = useCallback(
    (failedText: string) => {
      if (!selectedId) {
        return;
      }
      void sendNow(selectedId, failedText, { model: OPUS_MODEL, echoUser: false });
    },
    [selectedId, sendNow],
  );

  // Post an answer to a pending chat card: the daemon resolves Darwin's
  // waiting tool call; the decision_settled event stamps the final state.
  const postDecisionAnswer = useCallback(
    async (
      projectId: string,
      decisionId: string,
      answer: { selections: string[]; responses: Record<string, string[]>; custom: string },
    ) => {
      const response = await fetch("/api/manager/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionId, ...answer }),
      });
      if (!response.ok && selectedIdRef.current === projectId) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setItems((current) => [
          ...current,
          { kind: "note", text: payload.error ?? `Answering failed (${response.status}).` },
        ]);
      }
    },
    [],
  );

  // The chat composer IS the free-text answer to a pending card: a typed
  // message settles the waiting card as the custom answer instead of starting
  // a new turn (2026-07-08 ruling — no embedded text fields).
  const handleSend = useCallback(
    (text: string, attachments: OutgoingAttachment[]) => {
      if (!selectedId) {
        return;
      }
      const pending = pendingDecisionRef.current;
      if (pending) {
        // Free-text card answers are text-only; the composer already strips
        // the tray while answering.
        void postDecisionAnswer(selectedId, pending.decisionId, {
          selections: [],
          responses: {},
          custom: text,
        });
        return;
      }
      if (working) {
        const projectQueue = queueFor(selectedId);
        projectQueue.push({
          id: crypto.randomUUID(),
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
        });
        saveQueue(window.localStorage, selectedId, projectQueue);
        setQueued([...projectQueue]);
        return;
      }
      void sendNow(selectedId, text, attachments.length > 0 ? { attachments } : {});
    },
    [selectedId, working, sendNow, postDecisionAnswer, queueFor],
  );

  // Answer a card via its clickable options: single/confirm selections, or a
  // batch's per-field responses.
  const handleAnswerDecision = useCallback(
    (
      decisionId: string,
      selections: string[],
      responses: Record<string, string[]>,
      custom: string,
    ) => {
      if (selectedId) void postDecisionAnswer(selectedId, decisionId, { selections, responses, custom });
    },
    [postDecisionAnswer, selectedId],
  );

  // The manual mirror of the boundary compaction: compact NOW, re-brief on
  // the next turn. The daemon broadcasts the confirmation note (deduped by
  // text in the /events handler), so success needs no local echo.
  const handleRebriefNow = useCallback(async () => {
    if (!selectedId) {
      return;
    }
    const projectId = selectedId;
    const response = await fetch("/api/manager/rebrief/now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      note?: string;
    };
    if (selectedIdRef.current !== projectId) return;
    if (!response.ok) {
      setItems((current) => [
        ...current,
        { kind: "note", text: payload.error ?? `Re-brief failed (${response.status}).`, at: now() },
      ]);
      return;
    }
    if (payload.note) {
      const text = payload.note;
      setItems((current) =>
        current.some((item) => item.kind === "note" && item.text === text)
          ? current
          : [...current, { kind: "note", text, at: now() }],
      );
    }
  }, [selectedId]);

  const handleClearRebrief = useCallback(
    async (rebrief: RebriefView) => {
      if (!selectedId || !rebrief.turnId) {
        return;
      }
      const projectId = selectedId;
      const response = await fetch("/api/manager/rebrief/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, turnId: rebrief.turnId }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (selectedIdRef.current !== projectId) return;
      if (!response.ok) {
        setItems((current) => [
          ...current,
          { kind: "note", text: payload.error ?? `Clearing the re-brief failed (${response.status}).` },
        ]);
        return;
      }
      setItems((current) => [
        ...current.map((item) =>
          item.kind === "rebrief" && item.rebrief.turnId === rebrief.turnId
            ? { ...item, rebrief: { ...item.rebrief, cleared: true } }
            : item,
        ),
        {
          kind: "note",
          text: "Re-brief cleared — Darwin starts the next turn from a blank context. The committed records remain on disk; he will only know them again if he reads them with his tools.",
        },
      ]);
    },
    [selectedId],
  );

  if (projects === null) {
    return <div className="app-shell" />;
  }

  const needsProject = projects.length === 0 || showAddProject;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title">
          GALAPAGOS <span>/ Darwin</span>
        </div>
        <span className={`stream-state ${streamConnection}`} aria-label={`Live updates: ${streamConnection}`}>
          {streamConnection === "live" ? "live" : streamConnection}
        </span>
        {selected ? (
          <>
            <a className="nav-link" href={`/workers?projectId=${encodeURIComponent(selected.id)}`}>
              Workers
            </a>
            <a className="nav-link" href={`/records?projectId=${encodeURIComponent(selected.id)}`}>
              Records
            </a>
            <button
              type="button"
              className="nav-link"
              disabled={working || daemonDown}
              title="Compact Darwin's context now and re-brief him from the committed records on his next turn — the manual mirror of the automatic boundary compaction."
              onClick={handleRebriefNow}
            >
              Re-brief
            </button>
          </>
        ) : null}
        {projects.length > 0 ? (
          <ProjectPicker
            projects={projects}
            selectedId={selectedId}
            onSelect={(id) => {
              setShowAddProject(false);
              setSelectedId(id);
            }}
            onAddNew={() => setShowAddProject(true)}
          />
        ) : null}
      </header>
      {daemonDown ? (
        <div className="banner danger">
          The Galapagos daemon is not running — ask the runtime owner to restore the permanent
          bench. Chat is disabled until it is back.
        </div>
      ) : null}
      {needsProject ? (
        <AddProjectForm
          onRegistered={async (project) => {
            setShowAddProject(false);
            await refreshProjects();
            setSelectedId(project.id);
          }}
        />
      ) : (
        <main className="app-main">
          <Chat
            items={items}
            working={working}
            liveText={liveText}
            liveStatus={liveStatus}
            queued={queued}
            disabled={daemonDown || !selected}
            answering={pendingDecision !== null}
            projectId={selected?.id ?? null}
            projectName={selected?.name ?? ""}
            onSend={handleSend}
            onQueueSteer={handleQueueSteer}
            onQueueRemove={handleQueueRemove}
            onClearRebrief={handleClearRebrief}
            onAnswerDecision={handleAnswerDecision}
            onSwitchToOpus={handleSwitchToOpus}
            mode={autonomyMode}
            onCycleMode={handleCycleMode}
          />
          <div className="side-stack">
            {confidence ? (
              <ConfidenceGauge
                report={confidence.project}
                label="project confidence"
                computedAt={confidence.computedAt}
              />
            ) : (
              <p className="empty-note">Confidence not computed yet.</p>
            )}
            <AttentionQueue
              items={attention}
              onChanged={() => {
                if (selectedIdRef.current) {
                  void reconcileProject(selectedIdRef.current);
                }
              }}
            />
            <SpecificsPanel specifics={specifics} />
          </div>
        </main>
      )}
    </div>
  );
}
