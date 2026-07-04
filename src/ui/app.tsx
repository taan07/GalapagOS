"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatItem,
  ManagerStreamEvent,
  ProjectView,
  SpecificView,
  ToolChip,
  TurnView,
} from "./types";
import { Chat } from "./chat";
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
    return [{ kind: "note", text: turn.content }];
  });
}

export function App() {
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [specifics, setSpecifics] = useState<SpecificView[]>([]);
  const [working, setWorking] = useState(false);
  const [queued, setQueued] = useState<string[]>([]);
  const [daemonDown, setDaemonDown] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const queueRef = useRef<string[]>([]);

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
    })();
  }, [selectedId, refreshSpecifics]);

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
              setItems((current) => [...current, { kind: "note", text: event.reason }]);
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
          />
          <SpecificsPanel specifics={specifics} />
        </main>
      )}
    </div>
  );
}
