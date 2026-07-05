// The one worker→WorkerView mapper: the list and the drilldown must describe
// the same worker identically, so the lane join, digest presence, and open
// attention count are computed in exactly one place.
import type { GalapagosDb } from "../adapters/db/db";
import type { AttentionItemRow } from "../adapters/db/repos/attention";
import { listWorkerAttentionItems } from "../adapters/db/repos/attention";
import type { CompletionDigestRow } from "../adapters/db/repos/digests";
import { latestDigestForWorker } from "../adapters/db/repos/digests";
import { getLane, laneGlobs } from "../adapters/db/repos/lanes";
import type { WorkerRow } from "../adapters/db/repos/workers";
import type { WorkerView } from "../ui/types";

export function toWorkerView(
  db: GalapagosDb,
  worker: WorkerRow,
  preloaded: {
    attention?: AttentionItemRow[];
    digest?: CompletionDigestRow | null;
  } = {},
): WorkerView {
  const lane = getLane(db, worker.lane_id);
  const globs = lane ? laneGlobs(lane) : null;
  const digest =
    preloaded.digest !== undefined ? preloaded.digest : (latestDigestForWorker(db, worker.id) ?? null);
  const attention = preloaded.attention ?? listWorkerAttentionItems(db, worker.id);
  return {
    id: worker.id,
    status: worker.status,
    laneName: lane?.name ?? null,
    allowedGlobs: globs?.allowedGlobs ?? [],
    forbiddenGlobs: globs?.forbiddenGlobs ?? [],
    baseSha: lane?.base_sha ?? null,
    branch: worker.branch,
    worktreePath: worker.worktree_path,
    lastMessageAt: worker.last_message_at,
    lastSummary: worker.last_summary,
    createdAt: worker.created_at,
    hasDigest: digest !== null,
    openAttentionCount: attention.filter((item) => item.status === "open").length,
  };
}
