"use client";

// Plain browser of the active project's durable records (chunk 2 brief):
// type, title, status, date, body — every field source-attributed, no
// editing UI. Reading happens against the committed files via /api/records.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectView, RecordView } from "./types";

function Field(props: { label: string; value: string; source: string }) {
  return (
    <div className="record-field">
      <span className="record-field-label">{props.label}</span>
      <span className="record-field-value">{props.value}</span>
      <span className="record-source" title={`source: ${props.source}`}>
        {props.source}
      </span>
    </div>
  );
}

function RecordCard({ record }: { record: RecordView }) {
  const extraEntries = Object.entries(record.extra);
  return (
    <article className="record-card">
      <header className="record-head">
        <span className={`record-type type-${record.type}`}>{record.type}</span>
        <span className="record-title">{record.title}</span>
        <span className="record-status">{record.status}</span>
      </header>
      <div className="record-fields">
        <Field label="id" value={record.id} source={record.fieldSources.id ?? ""} />
        <Field
          label="created"
          value={record.createdAt || "(missing)"}
          source={record.fieldSources.createdAt ?? ""}
        />
        <Field
          label="updated"
          value={record.updatedAt || "(missing)"}
          source={record.fieldSources.updatedAt ?? ""}
        />
        <Field
          label="written by"
          value={record.writtenBy || "(missing)"}
          source={record.fieldSources.writtenBy ?? ""}
        />
        {extraEntries.map(([key, value]) => (
          <Field
            key={key}
            label={key}
            value={
              value === null
                ? "(null)"
                : Array.isArray(value)
                  ? value.join(" · ")
                  : String(value)
            }
            source={record.fieldSources[key] ?? ""}
          />
        ))}
      </div>
      <details className="record-body">
        <summary>
          body <span className="record-source">{record.fieldSources.body}</span>
        </summary>
        <pre>{record.body.trim() || "(empty body)"}</pre>
      </details>
      <footer className="record-file" title="file this record lives in">
        {record.sourceFile}
      </footer>
    </article>
  );
}

export function RecordsBrowser() {
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [records, setRecords] = useState<RecordView[] | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/projects", { cache: "no-store" });
      const payload = (await response.json()) as { projects: ProjectView[] };
      setProjects(payload.projects);
      const fromQuery = new URLSearchParams(window.location.search).get("projectId");
      const exists = (id: string | null) =>
        id !== null && payload.projects.some((project) => project.id === id);
      setSelectedId(
        exists(fromQuery)
          ? fromQuery
          : exists(localStorage.getItem("galapagos.lastProjectId"))
            ? localStorage.getItem("galapagos.lastProjectId")
            : (payload.projects[0]?.id ?? null),
      );
    })();
  }, []);

  const refresh = useCallback(async (projectId: string) => {
    setError(null);
    setRecords(null);
    const response = await fetch(`/api/records?projectId=${encodeURIComponent(projectId)}`, {
      cache: "no-store",
    });
    const payload = (await response.json()) as { records?: RecordView[]; error?: string };
    if (!response.ok || !payload.records) {
      setError(payload.error ?? `Failed to load records (${response.status}).`);
      return;
    }
    setRecords(payload.records);
  }, []);

  useEffect(() => {
    if (selectedId) {
      void refresh(selectedId);
    }
  }, [selectedId, refresh]);

  const types = useMemo(
    () => Array.from(new Set((records ?? []).map((record) => record.type))).sort(),
    [records],
  );
  const visible = (records ?? [])
    .filter((record) => typeFilter === "all" || record.type === typeFilter)
    .slice()
    .reverse(); // newest first

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title">
          GALAPAGOS <span>/ Records</span>
        </div>
        <a className="nav-link" href="/">
          ← Darwin
        </a>
        <a
          className="nav-link"
          href={selectedId ? `/workers?projectId=${encodeURIComponent(selectedId)}` : "/workers"}
        >
          Workers
        </a>
        <div className="picker">
          {projects && projects.length > 0 ? (
            <select
              value={selectedId ?? ""}
              onChange={(event) => setSelectedId(event.target.value)}
              aria-label="Project"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          ) : null}
          {types.length > 0 ? (
            <select
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
              aria-label="Record type"
            >
              <option value="all">all types</option>
              {types.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </header>
      <main className="records-main">
        {error ? <div className="banner danger">{error}</div> : null}
        {records === null && !error ? <p className="empty-note">Loading records…</p> : null}
        {records !== null && records.length === 0 ? (
          <p className="empty-note">
            No durable records yet. They appear here the moment Darwin records a goal, an
            answer, a plan, or a decision — committed to docs/galapagos/ in the project repo.
          </p>
        ) : null}
        {visible.map((record) => (
          <RecordCard key={`${record.type}-${record.id}`} record={record} />
        ))}
      </main>
    </div>
  );
}
