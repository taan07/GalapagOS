// Attachment disk store (track I): the daemon lands incoming attachment
// bytes under stateDir and hands back the RELATIVE paths the persisted turn
// carries. History fetches stay light (the UI pulls bytes through
// /api/attachments/<path> on demand) and Darwin reads pasted-text files
// lazily by absolute path.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  safeAttachmentFileName,
  type AttachmentImageType,
  type OutgoingAttachment,
  type StoredAttachment,
} from "../../core/attachments";

const ATTACHMENTS_ROOT = "attachments";

const IMAGE_EXTENSIONS: Record<AttachmentImageType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

function ensureExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

/**
 * Write one message's attachments to disk. Paths are
 * `attachments/<projectId>/<uuid>-<safeName>` relative to stateDir — the
 * uuid prefix makes every landing unique, so sanitized-name collisions and
 * repeated sends can never overwrite each other.
 */
export function storeAttachments(
  stateDir: string,
  projectId: string,
  attachments: OutgoingAttachment[],
): StoredAttachment[] {
  if (attachments.length === 0) {
    return [];
  }
  const dir = path.join(stateDir, ATTACHMENTS_ROOT, projectId);
  fs.mkdirSync(dir, { recursive: true });
  return attachments.map((attachment): StoredAttachment => {
    const base =
      attachment.kind === "image"
        ? ensureExtension(safeAttachmentFileName(attachment.name), IMAGE_EXTENSIONS[attachment.mediaType])
        : ensureExtension(safeAttachmentFileName(attachment.name), "txt");
    const fileName = `${randomUUID()}-${base}`;
    const absolute = path.join(dir, fileName);
    const relative = `${ATTACHMENTS_ROOT}/${projectId}/${fileName}`;
    if (attachment.kind === "image") {
      fs.writeFileSync(absolute, Buffer.from(attachment.data, "base64"));
      return {
        kind: "image",
        mediaType: attachment.mediaType,
        path: relative,
        name: attachment.name,
        size: attachment.size,
      };
    }
    fs.writeFileSync(absolute, attachment.text, "utf8");
    return { kind: "text", path: relative, name: attachment.name, size: attachment.size };
  });
}

/**
 * Resolve a persisted relative path to an absolute one, or null when it
 * escapes the attachments root — the serve route trusts nothing that came
 * back off the wire.
 */
export function resolveAttachmentPath(stateDir: string, relativePath: string): string | null {
  const root = path.resolve(stateDir, ATTACHMENTS_ROOT);
  const resolved = path.resolve(stateDir, relativePath);
  if (!resolved.startsWith(root + path.sep)) {
    return null;
  }
  return resolved;
}
