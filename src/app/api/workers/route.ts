import { NextResponse } from "next/server";
import { getProject } from "../../../adapters/db/repos/projects";
import { listWorkers } from "../../../adapters/db/repos/workers";
import { readDb } from "../../../server/read-db";
import { toWorkerView } from "../../../server/worker-views";

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

  const workers = listWorkers(db, projectId).map((worker) => toWorkerView(db, worker));
  return NextResponse.json({ workers }, { headers: { "Cache-Control": "no-store" } });
}
