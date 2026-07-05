"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AttentionView,
  ChatItem,
  DaemonStreamEvent,
  ManagerStreamEvent,
  ProjectConfidenceView,
  ProjectView,
  RebriefView,
  SpecificView,
  ToolChip,
  TurnView,
} from "./types";
import { AttentionQueue } from "./attention-queue";
import { Chat } from "./chat";
import { ConfidenceGauge } from "./confidence";
import { AddProjectForm, ProjectPicker } from "./project-picker";
import { SpecificsPanel } from "./specifics-panel";

const LAST_PROJECT_KEY = "galapagos.lastProjectId";

function turnsToChatItems(turns: TurnView[]): ChatItem[] {
  return turns.flatMap((turn): ChatItem[] => {
    if (turn.role === "user") {
      return [{ kind: "user", text: turn.content }];
    }
    if (turn.role === "assistant") {
      return [{ kind: "assistant", text: turn.content }];
    }
    if (turn.role === "tool") {
      try {
        const chip = JSON.parse(turn.content) as ToolChip;
        return [{ kind: "chip", chip }];
      } catch {
        return [];
      }
    }
    // System turns carry structured payloads (re-briefs, notes) since Chunk 2;
    // plain text stays a note for backward compatibility.
    try {
      const payload = JSON.parse(turn.content) as
        | { kind: "rebrief"; reason: string; preamble: string | null; clearedAt: string | null }
        | { kind: "note"; text: string };
      if (payload.kind === "rebrief") {
        return [
          {
            kind: "rebrief",
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
        return [{ kind: "note", text: payload.text }];
      }
    } catch {
      // fall through to plain text
    }
    return [{ kind: "note", text: turn.content }];
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
  const [queued, setQueued] = useState<string[]>([]);
  const [daemonDown, setDaemonDown] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const queueRef = useRef<string[]>([]);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

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

  const refreshSpecifics = useCallback(async (projectId: string) => {
    const response = await fetch(`/api/specifics?projectId=${encodeURIComponent(projectId)}`, {
      cache: "no-store",
    });
    if (response.ok) {
      const payload = (await response.json()) as { specifics: SpecificView[] };
      setSpecifics(payload.specifics);
    }
  }, []);

  const refreshAttention = useCallback(async (projectId: string) => {
    const response = await fetch(`/api/attention?projectId=${encodeURIComponent(projectId)}`, {
      cache: "no-store",
    });
    if (response.ok) {
      const payload = (await response.json()) as { items: AttentionView[] };
      setAttention(payload.items);
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

  const checkDaemon = useCallback(async () => {
    try {
      const response = await fetch("/api/daemon-health", { cache: "no-store" });
      setDaemonDown(!response.ok);
    } catch {
      setDaemonDown(true);
    }
  }, []);

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
    setItems([]);
    setQueued([]);
    queueRef.current = [];
    setAttention(null);
    setConfidence(null);
    void (async () => {
      const response = await fetch(
        `/api/manager/history?projectId=${encodeURIComponent(selectedId)}`,
        { cache: "no-store" },
      );
      if (response.ok) {
        const payload = (await response.json()) as { turns: TurnView[] };
        setItems(turnsToChatItems(payload.turns));
      }
      await refreshSpecifics(selectedId);
      await refreshAttention(selectedId);
      await refreshConfidence(selectedId);
    })();
  }, [selectedId, refreshSpecifics, refreshAttention, refreshConfidence]);

  // Live updates from the daemon: the monitor's tick keeps the gauge honest
  // (evidence freshness moves without any user action), attention changes
  // re-pull the queue, and triage's escalated questions land in the chat.
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onmessage = (message) => {
      let event: DaemonStreamEvent;
      try {
        event = JSON.parse(message.data as string) as DaemonStreamEvent;
      } catch {
        return;
      }
      const projectId = selectedIdRef.current;
      if (!projectId || !("projectId" in event) || event.projectId !== projectId) {
        return;
      }
      if (event.type === "attention_changed") {
        void refreshAttention(projectId);
        void refreshConfidence(projectId);
      } else if (event.type === "monitor_tick" || event.type === "digest_reviewed") {
        void refreshConfidence(projectId);
      } else if (event.type === "manager_note") {
        const text = event.text;
        setItems((current) =>
          current.some((item) => item.kind === "note" && item.text === text)
            ? current
            : [...current, { kind: "note", text }],
        );
        void refreshAttention(projectId);
      }
    };
    return () => source.close();
  }, [refreshAttention, refreshConfidence]);

  const sendNow = useCallback(
    async (projectId: string, text: string): Promise<void> => {
      setWorking(true);
      setItems((current) => [...current, { kind: "user", text }]);
      try {
        const response = await fetch("/api/manager/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, text }),
        });

        if (!response.ok || !response.body) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          setItems((current) => [
            ...current,
            { kind: "note", text: payload.error ?? `Send failed (${response.status}).` },
          ]);
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
            if (event.type === "assistant_text") {
              setItems((current) => [...current, { kind: "assistant", text: event.text }]);
            } else if (event.type === "tool_use") {
              setItems((current) => [...current, { kind: "chip", chip: event }]);
              if (event.tool === "record_specific") {
                void refreshSpecifics(projectId);
              }
            } else if (event.type === "rebrief") {
              setItems((current) => [
                ...current,
                {
                  kind: "rebrief",
                  rebrief: {
                    turnId: event.turnId,
                    reason: event.reason,
                    preamble: event.preamble,
                    cleared: false,
                  },
                },
              ]);
            } else if (event.type === "interrupted") {
              setItems((current) => [...current, { kind: "note", text: event.message }]);
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
                  ...notes.map((text) => ({ kind: "note" as const, text })),
                ]);
              }
              void refreshSpecifics(projectId);
            } else if (event.type === "turn_error") {
              setItems((current) => [
                ...current,
                { kind: "note", text: `Turn failed: ${event.message}` },
              ]);
            }
          }
        }
      } catch (error) {
        setItems((current) => [
          ...current,
          {
            kind: "note",
            text: `Connection lost mid-turn: ${error instanceof Error ? error.message : String(error)}`,
          },
        ]);
      } finally {
        setWorking(false);
      }
    },
    [refreshSpecifics],
  );

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

  // Drain the queue whenever Darwin finishes a turn.
  useEffect(() => {
    if (working || !selectedId) {
      return;
    }
    const next = queueRef.current.shift();
    setQueued([...queueRef.current]);
    if (next) {
      void sendNow(selectedId, next);
    }
  }, [working, selectedId, sendNow]);

  const handleSend = useCallback(
    (text: string) => {
      if (!selectedId) {
        return;
      }
      if (working) {
        queueRef.current.push(text);
        setQueued([...queueRef.current]);
        return;
      }
      void sendNow(selectedId, text);
    },
    [selectedId, working, sendNow],
  );

  const handleClearRebrief = useCallback(
    async (rebrief: RebriefView) => {
      if (!selectedId || !rebrief.turnId) {
        return;
      }
      const response = await fetch("/api/manager/rebrief/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: selectedId, turnId: rebrief.turnId }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
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
        {selected ? (
          <>
            <a className="nav-link" href={`/workers?projectId=${encodeURIComponent(selected.id)}`}>
              Workers
            </a>
            <a className="nav-link" href={`/records?projectId=${encodeURIComponent(selected.id)}`}>
              Records
            </a>
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
          The Galapagos daemon is not running — start it with `npm run dev`. Chat is disabled
          until it is back.
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
            queued={queued}
            disabled={daemonDown || !selected}
            projectName={selected?.name ?? ""}
            onSend={handleSend}
            onClearRebrief={handleClearRebrief}
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
                  void refreshAttention(selectedIdRef.current);
                  void refreshConfidence(selectedIdRef.current);
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
