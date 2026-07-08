import { NextResponse } from "next/server";
import { daemonUrl } from "../../../../server/read-db";

export const dynamic = "force-dynamic";

/** The user's answer to a chat decision — proxied to the waiting daemon turn. */
export async function POST(request: Request) {
  try {
    const upstream = await fetch(daemonUrl("/manager/decision"), {
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
