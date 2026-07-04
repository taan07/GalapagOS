"use client";

import { useEffect, useState } from "react";
import type { ProjectView } from "./types";

export function ProjectPicker({
  projects,
  selectedId,
  onSelect,
  onAddNew,
}: {
  projects: ProjectView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddNew: () => void;
}) {
  return (
    <div className="picker">
      <select
        value={selectedId ?? ""}
        onChange={(event) => onSelect(event.target.value)}
        aria-label="Active project"
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <button onClick={onAddNew}>Add project</button>
    </div>
  );
}

export function AddProjectForm({
  onRegistered,
}: {
  onRegistered: (project: ProjectView) => void | Promise<void>;
}) {
  const [devRoot, setDevRoot] = useState<string>("~/Dev");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [gitInitPath, setGitInitPath] = useState<string | null>(null);
  const [busy, setBusy] = useState<"choose" | "create" | "register" | null>(null);

  useEffect(() => {
    void fetch("/api/daemon-health", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: { devRoot?: string }) => {
        if (payload.devRoot) {
          setDevRoot(payload.devRoot);
        }
      })
      .catch(() => undefined);
  }, []);

  const register = async (rootPath: string, initGit: boolean) => {
    setBusy("register");
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootPath, initGit }),
      });
      const payload = (await response.json()) as {
        project?: ProjectView;
        error?: string;
        needsGitInit?: boolean;
      };
      if (response.ok && payload.project) {
        await onRegistered(payload.project);
        return;
      }
      if (payload.needsGitInit) {
        setGitInitPath(rootPath);
        return;
      }
      setError(payload.error ?? `Registration failed (${response.status}).`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const chooseFolder = async () => {
    setBusy("choose");
    setError(null);
    setGitInitPath(null);
    try {
      const response = await fetch("/api/system/choose-folder", { method: "POST" });
      const payload = (await response.json()) as {
        path?: string;
        cancelled?: boolean;
        error?: string;
      };
      if (!response.ok) {
        setError(payload.error ?? `Folder chooser failed (${response.status}).`);
        return;
      }
      if (payload.cancelled || !payload.path) {
        return;
      }
      await register(payload.path, false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const createProject = async () => {
    setBusy("create");
    setError(null);
    setGitInitPath(null);
    try {
      const response = await fetch("/api/projects/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const payload = (await response.json()) as { project?: ProjectView; error?: string };
      if (response.ok && payload.project) {
        await onRegistered(payload.project);
        return;
      }
      setError(payload.error ?? `Creation failed (${response.status}).`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="add-project">
      <h1>Add a project</h1>
      <p>
        Register an existing folder for Darwin to manage — the system folder chooser opens in
        your dev folder — or create a brand-new project from a name.
      </p>
      <div className="action-row">
        <button disabled={busy !== null} onClick={() => void chooseFolder()}>
          {busy === "choose" ? "Chooser open…" : "Choose folder…"}
        </button>
        <button
          disabled={busy !== null}
          onClick={() => void fetch("/api/system/reveal", { method: "POST" })}
        >
          Open dev folder in Finder
        </button>
      </div>
      <hr className="divider" />
      <div className="create-row">
        <input
          value={newName}
          placeholder="New project name"
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && newName.trim()) {
              void createProject();
            }
          }}
        />
        <button
          disabled={busy !== null || newName.trim().length === 0}
          onClick={() => void createProject()}
        >
          {busy === "create" ? "Creating…" : "Create new project"}
        </button>
      </div>
      <span className="hint">
        Creates <code>{devRoot}/{newName.trim() || "…"}</code> with a README and git history,
        registered and Darwin-ready.
      </span>
      {error ? <div className="field-error">{error}</div> : null}
      {gitInitPath ? (
        <div className="git-offer">
          <span>
            <code>{gitInitPath}</code> has no git history. Initialize it now? (Creates an initial
            commit of the current contents, respecting any .gitignore.)
          </span>
          <button disabled={busy !== null} onClick={() => void register(gitInitPath, true)}>
            Initialize git and register
          </button>
        </div>
      ) : null}
    </div>
  );
}
