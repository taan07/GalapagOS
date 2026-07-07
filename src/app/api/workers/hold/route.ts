import { NextResponse } from "next/server";
import { daemonUrl } from "../../../../server/read-db";

export const dynamic = "force-dynamic";

/**
 * The pause that is not a Stop (user-confirmed ruling): sends the hold
 * instruction — the worker states where it is and waits; the lane stays
 * active and the session stays live.
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
    const upstream = await fetch(daemonUrl(`/workers/${encodeURIComponent(workerId)}/hold`), {
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
