import { NextResponse } from "next/server";
import { daemonUrl } from "../../../../server/read-db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let attentionId: string | undefined;
  try {
    const body = (await request.json()) as { attentionId?: unknown };
    attentionId =
      typeof body.attentionId === "string" && body.attentionId.trim()
        ? body.attentionId
        : undefined;
  } catch {
    // fall through to validation
  }
  if (!attentionId) {
    return NextResponse.json({ error: "attentionId is required." }, { status: 400 });
  }
  try {
    const upstream = await fetch(daemonUrl("/completion-debriefs/rearm"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attentionId }),
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
