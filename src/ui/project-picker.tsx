"use client";

import { useState } from "react";
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
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [offerGitInit, setOfferGitInit] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const register = async (initGit: boolean) => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rootPath: rootPath.trim(),
          name: name.trim() || undefined,
          initGit,
        }),
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
        setOfferGitInit(true);
        setError(null);
        return;
      }
      setError(payload.error ?? `Registration failed (${response.status}).`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="add-project">
      <h1>Register a project</h1>
      <p>
        Point Galapagos at a local repository. Darwin manages one project at a time; switch
        projects from the header.
      </p>
      <input
        value={rootPath}
        placeholder="/absolute/path/to/project"
        onChange={(event) => {
          setRootPath(event.target.value);
          setOfferGitInit(false);
        }}
      />
      <input
        value={name}
        placeholder="Display name (optional — defaults to the folder name)"
        onChange={(event) => setName(event.target.value)}
      />
      {error ? <div className="field-error">{error}</div> : null}
      {offerGitInit ? (
        <div className="git-offer">
          <span>
            This folder has no git history. Galapagos never manages a project without history —
            it needs commits for observation, checkpoints, and the decision bloodline.
          </span>
          <button disabled={submitting} onClick={() => void register(true)}>
            Initialize git and register
          </button>
        </div>
      ) : (
        <button
          disabled={submitting || rootPath.trim().length === 0}
          onClick={() => void register(false)}
        >
          Register project
        </button>
      )}
    </div>
  );
}
