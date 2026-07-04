"use client";

import { useCallback, useEffect, useState } from "react";
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

type BrowseEntry = {
  name: string;
  path: string;
  isGitRepo: boolean;
  isRegistered: boolean;
};

type BrowseResult = {
  path: string;
  parent: string | null;
  devRoot: string;
  entries: BrowseEntry[];
};

export function AddProjectForm({
  onRegistered,
}: {
  onRegistered: (project: ProjectView) => void | Promise<void>;
}) {
  const [mode, setMode] = useState<"browse" | "create">("browse");
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [gitInitPath, setGitInitPath] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadDir = useCallback(async (dirPath?: string) => {
    setError(null);
    setGitInitPath(null);
    const search = dirPath ? `?path=${encodeURIComponent(dirPath)}` : "";
    const response = await fetch(`/api/fs/browse${search}`, { cache: "no-store" });
    const payload = (await response.json()) as BrowseResult & { error?: string };
    if (!response.ok) {
      setError(payload.error ?? `Browse failed (${response.status}).`);
      return;
    }
    setBrowse(payload);
  }, []);

  useEffect(() => {
    void loadDir();
  }, [loadDir]);

  const register = async (rootPath: string, initGit: boolean) => {
    setSubmitting(true);
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
      setSubmitting(false);
    }
  };

  const createProject = async () => {
    setSubmitting(true);
    setError(null);
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
      setSubmitting(false);
    }
  };

  return (
    <div className="add-project">
      <h1>Add a project</h1>
      <div className="tabs" role="tablist">
        <button
          className={mode === "browse" ? "tab active" : "tab"}
          onClick={() => setMode("browse")}
        >
          Browse existing
        </button>
        <button
          className={mode === "create" ? "tab active" : "tab"}
          onClick={() => setMode("create")}
        >
          Create new
        </button>
      </div>

      {mode === "browse" ? (
        <>
          <p>
            Pick a folder for Darwin to manage. Folders without git history get a one-click init
            — Galapagos never manages a project without history.
          </p>
          {browse ? (
            <>
              <div className="crumb-row">
                <button
                  disabled={!browse.parent}
                  onClick={() => browse.parent && void loadDir(browse.parent)}
                  aria-label="Up one folder"
                >
                  ↑ Up
                </button>
                <code className="crumb">{browse.path}</code>
                {browse.path !== browse.devRoot ? (
                  <button onClick={() => void loadDir(browse.devRoot)}>Dev folder</button>
                ) : null}
              </div>
              <div className="browser">
                {browse.entries.length === 0 ? (
                  <p className="empty-note">No subfolders here.</p>
                ) : (
                  browse.entries.map((entry) => (
                    <div className="browser-row" key={entry.path}>
                      <button className="dir-name" onClick={() => void loadDir(entry.path)}>
                        {entry.name}/
                      </button>
                      <span className="badges">
                        {entry.isGitRepo ? <span className="badge git">git</span> : null}
                        {entry.isRegistered ? (
                          <span className="badge registered">registered</span>
                        ) : null}
                      </span>
                      <button
                        disabled={submitting || entry.isRegistered}
                        onClick={() => void register(entry.path, false)}
                      >
                        {entry.isRegistered ? "Added" : "Register"}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <p className="empty-note">Loading folders…</p>
          )}
        </>
      ) : (
        <>
          <p>
            Name a brand-new project. Galapagos creates the folder in your dev folder, seeds a
            README, starts git history, and registers it — ready for Darwin immediately.
          </p>
          <input
            value={newName}
            placeholder="Project name"
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && newName.trim()) {
                void createProject();
              }
            }}
          />
          {browse ? (
            <span className="hint">
              Will create: <code>{browse.devRoot}/{newName.trim() || "…"}</code>
            </span>
          ) : null}
          <button
            disabled={submitting || newName.trim().length === 0}
            onClick={() => void createProject()}
          >
            Create and register
          </button>
        </>
      )}

      {error ? <div className="field-error">{error}</div> : null}
      {gitInitPath ? (
        <div className="git-offer">
          <span>
            <code>{gitInitPath}</code> has no git history. Initialize it now? (Creates an initial
            commit of the current contents, respecting any .gitignore.)
          </span>
          <button disabled={submitting} onClick={() => void register(gitInitPath, true)}>
            Initialize git and register
          </button>
        </div>
      ) : null}
    </div>
  );
}
