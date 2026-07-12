// Per-project persistence for the composer's message queue — the same
// contract as the composer draft (feat/chat-responsiveness): load on project
// switch, write-through synchronously in the handler that mutated the queue
// (never via an effect — a project switch must not write the old queue under
// the new key), remove the key when empty. Pure over a Storage-like surface
// so the logic is testable without a browser.

import type { QueuedMessage } from "./types";

/** Structural localStorage surface — keeps this module DOM-lib-free for the
 * node test build. */
export type QueueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const queueStorageKey = (projectId: string): string => `galapagos.queue.${projectId}`;

/** Parse a stored queue; anything malformed loads as empty, never throws. */
export function loadQueue(storage: QueueStorage, projectId: string): QueuedMessage[] {
  const raw = storage.getItem(queueStorageKey(projectId));
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is QueuedMessage =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === "string" &&
        typeof (entry as { text?: unknown }).text === "string",
    );
  } catch {
    return [];
  }
}

/** Persist the queue; an empty queue removes the key (a reload loads []). */
export function saveQueue(
  storage: QueueStorage,
  projectId: string,
  queue: QueuedMessage[],
): void {
  if (queue.length === 0) {
    storage.removeItem(queueStorageKey(projectId));
    return;
  }
  storage.setItem(queueStorageKey(projectId), JSON.stringify(queue));
}
