// ONE attachment contract (track I): clipboard images and pasted-large-text
// travel the same pipe — composer tray → POST body → daemon persistence →
// SDK content blocks → history chips. Pure module: shapes, thresholds, and
// the parsers both ends of the wire trust.

/** Pasted text longer than this becomes an attachment chip instead of flooding
 * the composer (openwebui §6 parity). Shift-paste bypasses. */
export const LARGE_PASTE_THRESHOLD = 1000;

/** The SDK's Base64ImageSource media types — the clipboard filter. */
export const ATTACHMENT_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export type AttachmentImageType = (typeof ATTACHMENT_IMAGE_TYPES)[number];

export function isAttachmentImageType(value: unknown): value is AttachmentImageType {
  return (
    typeof value === "string" && (ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(value)
  );
}

/** One pasted image, base64 on the wire, capped per attachment. */
export const MAX_IMAGE_BASE64_CHARS = 8_000_000; // ~6MB of image bytes

/** The whole message body cap the daemon enforces (413 past it). */
export const MAX_MESSAGE_BODY_BYTES = 16 * 1024 * 1024;

/** What the composer sends: image bytes inline (base64), text inline. */
export type OutgoingAttachment =
  | { kind: "image"; mediaType: AttachmentImageType; data: string; name: string; size: number }
  | { kind: "text"; text: string; name: string; size: number };

export type ImageAttachment = Extract<OutgoingAttachment, { kind: "image" }>;

/** What a persisted user turn carries: BOTH kinds live on DISK under
 * stateDir — image bytes so history fetches stay light, pasted text so
 * Darwin reads it lazily by path instead of carrying it in context (Taan's
 * ruling, 2026-07-13). `path` is RELATIVE to stateDir — never absolute,
 * never outside it. */
export type StoredAttachment =
  | { kind: "image"; mediaType: AttachmentImageType; path: string; name: string; size: number }
  | { kind: "text"; path: string; name: string; size: number };

/** The JSON a user turn's content column holds when attachments ride along.
 * Plain-string user turns (every turn before track I) remain valid forever. */
export type UserTurnPayload = {
  kind: "user";
  text: string;
  attachments: StoredAttachment[];
};

/** openwebui §6: large text becomes a file UNLESS Shift is held (the escape
 * hatch back to a plain inline paste). */
export function shouldAttachPastedText(text: string, shiftHeld: boolean): boolean {
  return !shiftHeld && text.length > LARGE_PASTE_THRESHOLD;
}

/**
 * Parse a user turn's content column: attachment-bearing turns are JSON with
 * kind "user"; everything else (all history before track I) is the raw text.
 * Never throws — malformed JSON is just a message that looks like JSON.
 */
export function parseUserTurnContent(content: string): {
  text: string;
  attachments: StoredAttachment[];
} {
  if (content.startsWith("{")) {
    try {
      const parsed = JSON.parse(content) as Partial<UserTurnPayload>;
      if (parsed.kind === "user" && typeof parsed.text === "string") {
        return {
          text: parsed.text,
          attachments: Array.isArray(parsed.attachments)
            ? parsed.attachments.filter(isStoredAttachment)
            : [],
        };
      }
    } catch {
      // fall through — the user literally typed JSON-looking text
    }
  }
  return { text: content, attachments: [] };
}

function isStoredAttachment(value: unknown): value is StoredAttachment {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  if (entry.kind === "image") {
    return (
      isAttachmentImageType(entry.mediaType) &&
      typeof entry.path === "string" &&
      typeof entry.name === "string" &&
      typeof entry.size === "number"
    );
  }
  if (entry.kind === "text") {
    return (
      typeof entry.path === "string" &&
      typeof entry.name === "string" &&
      typeof entry.size === "number"
    );
  }
  return false;
}

/**
 * Validate the wire's attachments array — the daemon trusts nothing. Returns
 * null when ANY entry is malformed or over cap (the send is rejected whole;
 * a silently-dropped attachment would be worse than an error).
 */
export function parseOutgoingAttachments(raw: unknown): OutgoingAttachment[] | null {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  const parsed: OutgoingAttachment[] = [];
  for (const value of raw) {
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const entry = value as Record<string, unknown>;
    if (entry.kind === "image") {
      if (
        !isAttachmentImageType(entry.mediaType) ||
        typeof entry.data !== "string" ||
        entry.data.length === 0 ||
        entry.data.length > MAX_IMAGE_BASE64_CHARS ||
        typeof entry.name !== "string" ||
        typeof entry.size !== "number"
      ) {
        return null;
      }
      parsed.push({
        kind: "image",
        mediaType: entry.mediaType,
        data: entry.data,
        name: entry.name,
        size: entry.size,
      });
      continue;
    }
    if (entry.kind === "text") {
      if (
        typeof entry.text !== "string" ||
        entry.text.length === 0 ||
        typeof entry.name !== "string" ||
        typeof entry.size !== "number"
      ) {
        return null;
      }
      parsed.push({ kind: "text", text: entry.text, name: entry.name, size: entry.size });
      continue;
    }
    return null;
  }
  return parsed;
}

/**
 * The one-line reading of a user turn for transcript-shaped consumers (the
 * re-brief thread tail): the text plus attachment names, never raw payload
 * JSON.
 */
export function userTurnPlainText(content: string): string {
  const { text, attachments } = parseUserTurnContent(content);
  if (attachments.length === 0) {
    return text;
  }
  const names = attachments.map((entry) => entry.name).join(", ");
  return text ? `${text} [attached: ${names}]` : `[attached: ${names}]`;
}

/**
 * A stored name that is safe as a single path segment anywhere: no
 * separators, no traversal, no shell-hostile characters. The store prefixes
 * a random id, so collisions after sanitizing don't matter.
 */
export function safeAttachmentFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "attachment";
}

/**
 * The prompt-side pointer at pasted-text files. Darwin receives PATHS, not
 * contents — he reads a file only when it's relevant, so a 100KB paste never
 * bloats his context uninvited (Taan's ruling, 2026-07-13). Images don't
 * appear here; they ride the same turn as SDK image blocks.
 */
export function attachmentPromptNote(
  attachments: StoredAttachment[],
  stateDir: string,
): string | null {
  const files = attachments.filter((entry) => entry.kind === "text");
  if (files.length === 0) {
    return null;
  }
  const lines = files.map(
    (file) => `- ${file.name} (${file.size} chars): ${stateDir}/${file.path}`,
  );
  return [
    "[The user attached pasted-text file(s) to this message. Read one with the Read tool when its contents matter to your reply:",
    ...lines,
    "]",
  ].join("\n");
}
