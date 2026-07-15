import { NextResponse } from "next/server";
import { daemonUrl } from "../../../../server/read-db";

export const dynamic = "force-dynamic";

// The Shift+Tab autonomy axis. Mode changes Darwin's server-side behavior
// (doctrine + tool allowlist per turn), so the daemon owns it — the UI only
// requests and renders.
export async function POST(request: Request) {
  try {
    const upstream = await fetch(daemonUrl("/manager/mode"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
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
