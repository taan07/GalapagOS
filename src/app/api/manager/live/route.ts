import { NextResponse } from "next/server";
import { daemonUrl } from "../../../../server/read-db";

export const dynamic = "force-dynamic";

// The re-attach handshake: history tells a loading client what HAPPENED,
// this tells it what is happening RIGHT NOW — the busy flag plus the live
// tail its POST-less page never streamed. Pure passthrough to the daemon,
// which owns the in-memory turn state a SQLite read can never see.
export async function GET(request: Request) {
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required." }, { status: 400 });
  }
  try {
    const upstream = await fetch(
      daemonUrl(`/manager/live?projectId=${encodeURIComponent(projectId)}`),
      { cache: "no-store" },
    );
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    // A daemon that is DOWN cannot be mid-turn (a restart kills the turn), so
    // idle is honest there. A merely TRANSIENT failure while a turn is live
    // briefly renders idle too — accepted: the next turn_status broadcast
    // re-arms working within a tick, and erring busy would lock the composer
    // on a genuinely dead daemon.
    return NextResponse.json({ busy: false, status: null, text: "" }, { status: 200 });
  }
}
