import { NextResponse } from "next/server";
import { getOrCreateActiveSession, listTurns } from "../../../../adapters/db/repos/manager";
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
  const session = getOrCreateActiveSession(db, projectId);
  return NextResponse.json(
    { sessionId: session.id, turns: listTurns(db, session.id) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
