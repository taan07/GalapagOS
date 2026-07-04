import { NextResponse } from "next/server";
import { listProjects } from "../../../adapters/db/repos/projects";
import { daemonUrl, readDb } from "../../../server/read-db";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { projects: listProjects(readDb()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  // Registration is a command (it can git-init the project) — daemon owns it.
  try {
    const body = await request.text();
    const upstream = await fetch(daemonUrl("/projects"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return NextResponse.json(
      { error: "The Galapagos daemon is not reachable.", daemonDown: true },
      { status: 502 },
    );
  }
}
