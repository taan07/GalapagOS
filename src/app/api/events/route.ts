import { NextResponse } from "next/server";
import { daemonUrl } from "../../../server/read-db";

export const dynamic = "force-dynamic";

/** Pass the daemon's live event stream (worker events/status) through to the UI. */
export async function GET() {
  try {
    const upstream = await fetch(daemonUrl("/events"), { cache: "no-store" });
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "The Galapagos daemon is not reachable.", daemonDown: true },
      { status: 502 },
    );
  }
}
