import { NextResponse } from "next/server";
import { daemonUrl } from "../../../../server/read-db";

export const dynamic = "force-dynamic";

/**
 * The /workers page's escape hatch (user-confirmed 2026-07-05): stopping a
 * worker normally flows through Darwin, but a stuck worker must be stoppable
 * without a chat turn. Proxies to the daemon, which owns the live session.
 */
export async function POST(request: Request) {
  let workerId: string | undefined;
  try {
    const body = (await request.json()) as { workerId?: string };
    workerId = typeof body.workerId === "string" && body.workerId.trim() ? body.workerId : undefined;
  } catch {
    // fall through to the 400 below
  }
  if (!workerId) {
    return NextResponse.json({ error: "workerId is required." }, { status: 400 });
  }

  try {
    const upstream = await fetch(daemonUrl(`/workers/${encodeURIComponent(workerId)}/stop`), {
      method: "POST",
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
