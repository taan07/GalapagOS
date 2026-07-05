import { NextResponse } from "next/server";
import { listProjectTurns } from "../../../../adapters/db/repos/manager";
import { getProject } from "../../../../adapters/db/repos/projects";
import { readDb } from "../../../../server/read-db";

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
  // History spans compacted sessions: a re-brief must not wipe the visible
  // conversation, only the SDK context behind it.
  return NextResponse.json(
    { turns: listProjectTurns(db, projectId) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
