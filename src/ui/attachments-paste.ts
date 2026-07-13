// Clipboard image → OutgoingAttachment. Oversized pastes are silently
// downscaled client-side (Taan's ruling: every paste just works — losing
// pixel-perfect fidelity on a huge screenshot beats a rejection error).
import {
  MAX_IMAGE_BASE64_CHARS,
  isAttachmentImageType,
  type OutgoingAttachment,
} from "../core/attachments";

/** The API's optimal long edge — anything larger gets no extra fidelity. */
export const MAX_IMAGE_EDGE = 1568;

function base64FromBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const url = reader.result as string;
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Returns null only when the image can't be brought under the wire cap even
 * re-encoded as JPEG — practically never for screen content.
 */
export async function imageFileToAttachment(file: File): Promise<OutgoingAttachment | null> {
  const name = file.name || "pasted-image";
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    // Within bounds and an accepted type: ship the original bytes untouched
    // (keeps GIF animation, avoids a pointless lossy re-encode).
    if (scale === 1 && isAttachmentImageType(file.type)) {
      const data = await base64FromBlob(file);
      if (data.length <= MAX_IMAGE_BASE64_CHARS) {
        return { kind: "image", mediaType: file.type, data, name, size: file.size };
      }
    }
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    // PNG first (screenshots stay crisp); JPEG only if PNG misses the cap.
    for (const encoding of [
      { type: "image/png" as const, quality: undefined },
      { type: "image/jpeg" as const, quality: 0.85 },
    ]) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, encoding.type, encoding.quality),
      );
      if (!blob) {
        continue;
      }
      const data = await base64FromBlob(blob);
      if (data.length <= MAX_IMAGE_BASE64_CHARS) {
        return { kind: "image", mediaType: encoding.type, data, name, size: blob.size };
      }
    }
    return null;
  } finally {
    bitmap.close();
  }
}
