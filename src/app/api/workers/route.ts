import { NextResponse } from "next/server";
import { getProject } from "../../../adapters/db/repos/projects";
import { laneGlobs, getLane } from "../../../adapters/db/repos/lanes";
import { listWorkers } from "../../../adapters/db/repos/workers";
import { latestDigestForWorker } from "../../../adapters/db/repos/digests";
import { listWorkerAttentionItems } from "../../../adapters/db/repos/attention";
import { readDb } from "../../../server/read-db";
import type { WorkerView } from "../../../ui/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required." }, { status: 400 });
  }
  const db = readDb();
  const project = getProject(db, projectId);
  if (!project) {
    return NextResponse.json({ error: `Unknown project: ${projectId}` }, { status: 404 });
  }

  const workers: WorkerView[] = listWorkers(db, projectId).map((worker) => {
    const lane = getLane(db, worker.lane_id);
    const globs = lane ? laneGlobs(lane) : null;
    return {
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
      hasDigest: latestDigestForWorker(db, worker.id) !== undefined,
      openAttentionCount: listWorkerAttentionItems(db, worker.id).filter(
        (item) => item.status === "open",
      ).length,
    };
  });

  return NextResponse.json({ workers }, { headers: { "Cache-Control": "no-store" } });
}
