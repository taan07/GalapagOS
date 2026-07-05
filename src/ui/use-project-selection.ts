"use client";

// The one project-selection rule for secondary pages (/workers, /records):
// ?projectId= in the URL wins, then the project the user last focused in the
// main app (galapagos.lastProjectId), then the first project. The main page
// keeps its own richer logic (it also owns registration and persistence).
import { useEffect, useState } from "react";
import type { ProjectView } from "./types";

export function useProjectSelection(): {
  projects: ProjectView[] | null;
  selectedId: string | null;
  setSelectedId: (id: string) => void;
} {
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  return { projects, selectedId, setSelectedId };
}
