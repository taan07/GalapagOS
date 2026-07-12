import { NextResponse } from "next/server";
import { daemonUrl } from "../../../../server/read-db";

export const dynamic = "force-dynamic";

// Per-worker commits + diff + check evidence. Proxied to the daemon: the
// worktrees live under its stateDir and routes never spawn subprocesses —
// git execution stays where the work is.
export async function GET(request: Request) {
  const workerId = new URL(request.url).searchParams.get("workerId");
  if (!workerId) {
    return NextResponse.json({ error: "workerId is required." }, { status: 400 });
  }
  try {
    const upstream = await fetch(
      daemonUrl(`/workers/${encodeURIComponent(workerId)}/changes`),
      { cache: "no-store" },
    );
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "The Galapagos daemon is not reachable.", daemonDown: true },
      { status: 502 },
    );
  }
}
