import { promises as fs } from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

import { resolveAttachmentPath } from "../../../../adapters/attachments/store";
import { config } from "../../../../config";

export const dynamic = "force-dynamic";

// Bytes stay off the history wire (turns carry only relative paths); the UI
// pulls a thumbnail or a pasted-text file through here on demand.
const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const segments = (await params).path;
  const relative = ["attachments", ...segments].join("/");
  const absolute = resolveAttachmentPath(config.stateDir, relative);
  if (!absolute) {
    return NextResponse.json({ error: "Invalid attachment path." }, { status: 400 });
  }
  const contentType = CONTENT_TYPES[path.extname(absolute).toLowerCase()];
  if (!contentType) {
    return NextResponse.json({ error: "Unknown attachment type." }, { status: 400 });
  }
  try {
    const bytes = await fs.readFile(absolute);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": contentType,
        // Attachment files are immutable once written (uuid-prefixed names).
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
  }
}
