import type { GalapagosDb } from "../adapters/db/db";
import {
  appendTurn,
  compactSession,
  getOrCreateActiveSession,
  listTurns,
} from "../adapters/db/repos/manager";

export const COMPACTED_NOTE =
  "Darwin's context was compacted at a clean boundary — he re-briefs himself from the committed records (plus the live thread tail and worker fleet) on his next turn.";

export const ALREADY_FRESH_REBRIEF_NOTE =
  "Darwin's context is already fresh — the next turn re-briefs from records.";

export type ManualRebriefAcknowledgement = {
  compacted: boolean;
  note: string;
  sessionId: string;
};

/**
 * The durable half of an explicit re-brief. The caller broadcasts the note to
 * other tabs, but the acknowledgement itself is sufficient for the initiating
 * tab to reconcile after a missed or half-open EventSource.
 */
export function rebriefSessionNow(
  db: GalapagosDb,
  projectId: string,
): ManualRebriefAcknowledgement {
  const session = getOrCreateActiveSession(db, projectId);
  const hasConversation = listTurns(db, session.id).some((turn) => turn.role !== "system");
  if (!hasConversation && session.seeded_from_records_at) {
    return {
      compacted: false,
      note: ALREADY_FRESH_REBRIEF_NOTE,
      sessionId: session.id,
    };
  }

  const fresh = compactSession(db, projectId, session.id);
  // The broadcast makes the state transition visible cross-tab. Persist the
  // same note in the new session so the initiating tab's direct HTTP recovery
  // produces the same history even when it never receives that broadcast.
  appendTurn(db, {
    sessionId: fresh.id,
    role: "system",
    content: JSON.stringify({ kind: "note", text: COMPACTED_NOTE }),
  });
  return { compacted: true, note: COMPACTED_NOTE, sessionId: fresh.id };
}
