import { NextResponse } from "next/server";
import { daemonUrl } from "../../../server/read-db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const upstream = await fetch(daemonUrl("/health"), { cache: "no-store" });
    return NextResponse.json(await upstream.json(), { status: upstream.status });
  } catch {
    return NextResponse.json({ ok: false, daemonDown: true }, { status: 502 });
  }
}
