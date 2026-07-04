import { NextResponse } from "next/server";
import { config } from "../../../config";
import { getProject } from "../../../adapters/db/repos/projects";
import { listAgreedSpecifics } from "../../../adapters/vault/specifics";
import { readDb } from "../../../server/read-db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required." }, { status: 400 });
  }
  const project = getProject(readDb(), projectId);
  if (!project) {
    return NextResponse.json({ error: `Unknown project: ${projectId}` }, { status: 404 });
  }
  const specifics = listAgreedSpecifics(config.vaultPath, project.slug).map(
    ({ body: _body, ...summary }) => summary,
  );
  return NextResponse.json({ specifics }, { headers: { "Cache-Control": "no-store" } });
}
