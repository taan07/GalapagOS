import { NextResponse } from "next/server";
import { listProjectAttentionItems } from "../../../adapters/db/repos/attention";
import { getProject } from "../../../adapters/db/repos/projects";
import { readDb } from "../../../server/read-db";
import type { AttentionView } from "../../../ui/types";

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
  const items: AttentionView[] = listProjectAttentionItems(db, projectId).map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    detail: item.detail,
    priority: item.priority,
    status: item.status,
    createdAt: item.created_at,
    workerId: item.worker_id,
  }));
  return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
}
