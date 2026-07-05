import { NextResponse } from "next/server";
import { daemonUrl } from "../../../../server/read-db";

export const dynamic = "force-dynamic";

/** Resolve/dismiss from the queue UI — a write, proxied to the daemon. */
export async function POST(request: Request) {
  let id: string | undefined;
  let resolution: string | undefined;
  let note: string | undefined;
  try {
    const body = (await request.json()) as { id?: string; resolution?: string; note?: string };
    id = typeof body.id === "string" && body.id.trim() ? body.id : undefined;
    resolution = body.resolution;
    note = typeof body.note === "string" && body.note.trim() ? body.note : undefined;
  } catch {
    // fall through to the 400 below
  }
  if (!id || (resolution !== "resolved" && resolution !== "dismissed")) {
    return NextResponse.json(
      { error: 'id and resolution ("resolved" | "dismissed") are required.' },
      { status: 400 },
    );
  }

  try {
    const upstream = await fetch(daemonUrl(`/attention/${encodeURIComponent(id)}/resolve`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolution, ...(note ? { note } : {}) }),
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
