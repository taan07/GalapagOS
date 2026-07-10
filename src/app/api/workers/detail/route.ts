import { NextResponse } from "next/server";
import { getWorker, listWorkerEvents } from "../../../../adapters/db/repos/workers";
import { latestDigestForWorker } from "../../../../adapters/db/repos/digests";
import { listWorkerAttentionItems } from "../../../../adapters/db/repos/attention";
import { listWorkerSteps } from "../../../../adapters/db/repos/worker-steps";
import { getProject } from "../../../../adapters/db/repos/projects";
import { deriveWorkerGithub } from "../../../../server/github-links";
import { readDb } from "../../../../server/read-db";
import { toWorkerView } from "../../../../server/worker-views";
import type { DigestView, WorkerDetailView } from "../../../../ui/types";

export const dynamic = "force-dynamic";

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function GET(request: Request) {
  const workerId = new URL(request.url).searchParams.get("workerId");
  if (!workerId) {
    return NextResponse.json({ error: "workerId is required." }, { status: 400 });
  }
  const db = readDb();
  const worker = getWorker(db, workerId);
  if (!worker) {
    return NextResponse.json({ error: `Unknown worker: ${workerId}` }, { status: 404 });
  }

  const digest = latestDigestForWorker(db, workerId) ?? null;
  const attention = listWorkerAttentionItems(db, workerId);
  const digestView: DigestView | null = digest
    ? {
        narrative: digest.narrative,
        beforeAfter: parseJson(digest.before_after, []),
        claims: parseJson(digest.claims, []),
        touchedAreas: parseJson(digest.touched_areas, []),
        status: digest.status,
        createdAt: digest.created_at,
      }
    : null;
  const project = getProject(db, worker.project_id);
  const workerView = toWorkerView(db, worker, { attention, digest });

  const detail: WorkerDetailView = {
    worker: workerView,
    events: listWorkerEvents(db, workerId).map((event) => ({
      id: event.id,
      kind: event.kind,
      payload: parseJson<Record<string, unknown>>(event.payload, {}),
      createdAt: event.created_at,
    })),
    digest: digestView,
    steps: listWorkerSteps(db, workerId).map((step) => ({
      ordinal: step.ordinal,
      title: step.title,
      detail: step.detail,
      status: step.status,
      updatedAt: step.updated_at,
    })),
    github: project
      ? deriveWorkerGithub({
          rootPath: project.root_path,
          branch: workerView.branch,
          baseSha: workerView.baseSha,
          claimFiles: digestView?.claims.flatMap((claim) => claim.files) ?? [],
        })
      : null,
    attention: attention.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      detail: item.detail,
      priority: item.priority,
      status: item.status,
      createdAt: item.created_at,
    })),
  };

  return NextResponse.json(detail, { headers: { "Cache-Control": "no-store" } });
}
