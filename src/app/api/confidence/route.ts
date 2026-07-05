import { NextResponse } from "next/server";
import { getProject } from "../../../adapters/db/repos/projects";
import { readDb } from "../../../server/read-db";
import { projectConfidenceView } from "../../../server/confidence-views";

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
  const view = await projectConfidenceView(db, project);
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}
