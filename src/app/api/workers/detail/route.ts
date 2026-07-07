import { NextResponse } from "next/server";
import { getWorker, listWorkerEvents } from "../../../../adapters/db/repos/workers";
import { latestDigestForWorker } from "../../../../adapters/db/repos/digests";
import { listWorkerAttentionItems } from "../../../../adapters/db/repos/attention";
import { readDb } from "../../../../server/read-db";
import { toWorkerView } from "../../../../server/worker-views";
import type { WorkerDetailView } from "../../../../ui/types";

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

  const detail: WorkerDetailView = {
    worker: toWorkerView(db, worker, { attention, digest }),
    events: listWorkerEvents(db, workerId).map((event) => ({
      id: event.id,
      kind: event.kind,
      payload: parseJson<Record<string, unknown>>(event.payload, {}),
      createdAt: event.created_at,
    })),
    digest: digest
      ? {
          narrative: digest.narrative,
          beforeAfter: parseJson(digest.before_after, []),
          claims: parseJson(digest.claims, []),
          touchedAreas: parseJson(digest.touched_areas, []),
          status: digest.status,
          createdAt: digest.created_at,
        }
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
