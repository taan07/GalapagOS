import { NextResponse } from "next/server";
import { daemonUrl } from "../../../../server/read-db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const upstream = await fetch(daemonUrl("/manager/message"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
    });

    if (!upstream.ok && upstream.headers.get("content-type")?.includes("json")) {
      return new NextResponse(await upstream.text(), {
        status: upstream.status,
        headers: { "Content-Type": "application/json" },
      });
    }

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
