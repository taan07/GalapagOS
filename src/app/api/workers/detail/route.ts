import { NextResponse } from "next/server";
import { getLane, laneGlobs } from "../../../../adapters/db/repos/lanes";
import { getWorker, listWorkerEvents } from "../../../../adapters/db/repos/workers";
import { latestDigestForWorker } from "../../../../adapters/db/repos/digests";
import { listWorkerAttentionItems } from "../../../../adapters/db/repos/attention";
import { readDb } from "../../../../server/read-db";
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

  const lane = getLane(db, worker.lane_id);
  const globs = lane ? laneGlobs(lane) : null;
  const digest = latestDigestForWorker(db, workerId);

  const detail: WorkerDetailView = {
    worker: {
      id: worker.id,
      status: worker.status,
      laneName: lane?.name ?? null,
      allowedGlobs: globs?.allowedGlobs ?? [],
      forbiddenGlobs: globs?.forbiddenGlobs ?? [],
      baseSha: lane?.base_sha ?? null,
      branch: worker.branch,
      worktreePath: worker.worktree_path,
      lastMessageAt: worker.last_message_at,
      lastSummary: worker.last_summary,
      createdAt: worker.created_at,
      hasDigest: digest !== undefined,
      openAttentionCount: listWorkerAttentionItems(db, workerId).filter(
        (item) => item.status === "open",
      ).length,
    },
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
    attention: listWorkerAttentionItems(db, workerId).map((item) => ({
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
