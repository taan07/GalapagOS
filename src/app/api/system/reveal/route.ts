import { NextResponse } from "next/server";
import { daemonUrl } from "../../../../server/read-db";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const upstream = await fetch(daemonUrl("/system/reveal-dev-root"), { method: "POST" });
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
