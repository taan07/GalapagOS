import { NextResponse } from "next/server";
import { config } from "../../../../config";
import { listProjects } from "../../../../adapters/db/repos/projects";
import { browseDirectory } from "../../../../server/browse";
import { readDb } from "../../../../server/read-db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestedPath = new URL(request.url).searchParams.get("path") ?? undefined;
  try {
    const result = browseDirectory({
      requestedPath,
      devRoot: config.devRoot,
      registeredPaths: new Set(listProjects(readDb()).map((project) => project.root_path)),
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
