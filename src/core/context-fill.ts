// How full is the manager's context window? Computed from the usage block the
// SDK already attaches to every result message — zero extra round-trips. Pure.

export type ModelUsageLike = {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number;
};

/**
 * The worst (fullest) context-fill ratio across the models a turn touched.
 * Input tokens plus both cache flavors approximate what the next turn must
 * carry. Returns null when nothing usable is reported (no models, zero or
 * missing windows) — callers must treat unknown pressure as NO pressure, so a
 * reporting gap can never trigger a spurious compaction.
 */
export function contextFillFromModelUsage(
  modelUsage: Record<string, ModelUsageLike> | undefined,
): number | null {
  if (!modelUsage) {
    return null;
  }
  let worst: number | null = null;
  for (const usage of Object.values(modelUsage)) {
    if (!Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
      continue;
    }
    const carried =
      (Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0) +
      (Number.isFinite(usage.cacheReadInputTokens) ? usage.cacheReadInputTokens : 0) +
      (Number.isFinite(usage.cacheCreationInputTokens) ? usage.cacheCreationInputTokens : 0);
    const fill = carried / usage.contextWindow;
    if (worst === null || fill > worst) {
      worst = fill;
    }
  }
  return worst;
}
