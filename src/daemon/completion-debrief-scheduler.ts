import type { GalapagosDb } from "../adapters/db/db";
import {
  createAttentionItem,
  getAttentionItem,
  resolveAttentionItem,
} from "../adapters/db/repos/attention";
import {
  DEBRIEF_MAX_ATTEMPTS,
  debriefForAttention,
  ensureCompletionDebrief,
  ensureReviewedDebriefs,
  failDebriefAttempt,
  failDebriefPreflight,
  getCompletionDebrief,
  linkDebriefAttention,
  nextDueDebrief,
  rearmDebrief,
  recoverRunningDebriefs,
  startDebriefAttempt,
  succeedDebriefAttempt,
  type CompletionDebriefRow,
  type DebriefFailureKind,
} from "../adapters/db/repos/debriefs";

export type DebriefAttemptContext = {
  digestId: string;
  workerId: string;
  laneName: string;
  retirementStatus: string;
  retirementFailureKind: string | null;
  retirementError: string | null;
  model: string;
  seed: string;
  noteText: string;
};

export type DebriefRunResult =
  | { ok: true }
  | {
      ok: false;
      failureKind: DebriefFailureKind;
      errorCode: string;
      error: string;
    };

export function createCompletionDebriefScheduler(input: {
  db: GalapagosDb;
  now?: () => Date;
  isProjectBusy: (projectId: string) => boolean;
  buildContext: (row: CompletionDebriefRow) => DebriefAttemptContext | null;
  runAttempt: (
    row: CompletionDebriefRow,
    context: DebriefAttemptContext,
    begin: (actualContext: DebriefAttemptContext) => void,
  ) => Promise<DebriefRunResult>;
  onAttentionChanged?: (projectId: string) => void;
}) {
  const now = () => (input.now ? input.now() : new Date());
  const draining = new Set<string>();

  const closeFailureAttention = (row: CompletionDebriefRow): void => {
    if (!row.attention_id) {
      return;
    }
    const attention = getAttentionItem(input.db, row.attention_id);
    if (attention?.status === "open") {
      resolveAttentionItem(
        input.db,
        attention.id,
        "resolved",
        "Darwin delivered the completion debrief successfully.",
      );
      input.onAttentionChanged?.(row.project_id);
    }
    linkDebriefAttention(input.db, row.digest_id, null);
  };

  const raiseTerminalFailure = (row: CompletionDebriefRow): void => {
    if (row.attention_id && getAttentionItem(input.db, row.attention_id)?.status === "open") {
      return;
    }
    const reason =
      row.last_failure_kind === "non_retryable"
        ? "The failure is non-retryable."
        : `All ${DEBRIEF_MAX_ATTEMPTS} automatic attempts were used.`;
    const attention = createAttentionItem(input.db, {
      projectId: row.project_id,
      workerId: row.worker_id,
      kind: "completion_debrief_failed",
      title: "Darwin could not deliver a verified completion debrief",
      detail:
        `Digest ${row.digest_id} is still verified, but its user debrief failed. ${reason}\n` +
        `Last failure [${row.last_error_code ?? "unknown"}, ${row.last_failure_kind ?? "unknown"}]: ${row.last_error ?? "no reason recorded"}\n` +
        `Attempts: ${row.attempts}; last attempt: ${row.last_attempt_at ?? "never"}. Use Retry debrief after correcting the cause.`,
      priority: "high",
    });
    linkDebriefAttention(input.db, row.digest_id, attention.id);
    input.onAttentionChanged?.(row.project_id);
  };

  const settleFailure = (
    row: CompletionDebriefRow,
    attemptId: string,
    result: Exclude<DebriefRunResult, { ok: true }>,
  ): CompletionDebriefRow => {
    const failed = failDebriefAttempt(input.db, {
      digestId: row.digest_id,
      attemptId,
      kind: result.failureKind,
      errorCode: result.errorCode,
      error: result.error,
      at: now().toISOString(),
    });
    if (result.failureKind === "non_retryable" || failed.attempts >= DEBRIEF_MAX_ATTEMPTS) {
      raiseTerminalFailure(failed);
    }
    return failed;
  };

  const drain = async (projectId: string): Promise<void> => {
    if (draining.has(projectId) || input.isProjectBusy(projectId)) {
      return;
    }
    draining.add(projectId);
    try {
      ensureReviewedDebriefs(input.db, projectId, now().toISOString());
      for (;;) {
        if (input.isProjectBusy(projectId)) {
          return;
        }
        const row = nextDueDebrief(input.db, projectId, now().toISOString());
        if (!row) {
          return;
        }
        // Resolve digest-bound context at the instant the model call begins:
        // delayed work cannot drift to a newer digest or stale retirement.
        const context = input.buildContext(row);
        if (!context) {
          const attempt = startDebriefAttempt(input.db, {
            digestId: row.digest_id,
            context: { error: "digest-bound context unavailable" },
            at: now().toISOString(),
          });
          settleFailure(row, attempt.id, {
            ok: false,
            failureKind: "non_retryable",
            errorCode: "context_missing",
            error: "The digest, worker, project, or lane required for narration no longer exists.",
          });
          continue;
        }
        let attemptId: string | null = null;
        const begin = (actualContext: DebriefAttemptContext) => {
          if (attemptId) {
            return;
          }
          // The callback is invoked immediately before runManagerTurn. Time
          // spent queued, busy, or waiting for a distillation fork is free.
          attemptId = startDebriefAttempt(input.db, {
            digestId: row.digest_id,
            context: actualContext,
            at: now().toISOString(),
          }).id;
        };
        let result: DebriefRunResult;
        try {
          result = await input.runAttempt(row, context, begin);
        } catch (error) {
          result = {
            ok: false,
            failureKind: "transient",
            errorCode: "runner_exception",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        if (!attemptId) {
          // The runner failed before any model call began. Record the reason
          // without consuming an attempt; transient preflight retries use the
          // scheduler poll, while missing context is immediately visible.
          if (!result.ok) {
            const failed = failDebriefPreflight(input.db, {
              digestId: row.digest_id,
              kind: result.failureKind,
              errorCode: result.errorCode,
              error: result.error,
              at: now().toISOString(),
            });
            if (result.failureKind === "non_retryable") {
              raiseTerminalFailure(failed);
            }
          }
          return;
        }
        if (result.ok) {
          succeedDebriefAttempt(input.db, {
            digestId: row.digest_id,
            attemptId,
            at: now().toISOString(),
          });
          closeFailureAttention(getCompletionDebrief(input.db, row.digest_id)!);
        } else {
          settleFailure(row, attemptId, result);
        }
      }
    } finally {
      draining.delete(projectId);
    }
  };

  return {
    ensure(inputRow: { digestId: string; projectId: string; workerId: string }): CompletionDebriefRow {
      return ensureCompletionDebrief(input.db, {
        ...inputRow,
        at: now().toISOString(),
      });
    },
    drain,
    recover(): CompletionDebriefRow[] {
      const recovered = recoverRunningDebriefs(input.db, now().toISOString());
      for (const row of recovered) {
        if (row.last_failure_kind === "non_retryable" || row.attempts >= DEBRIEF_MAX_ATTEMPTS) {
          raiseTerminalFailure(row);
        }
      }
      return recovered;
    },
    rearmByAttention(attentionId: string): CompletionDebriefRow | null {
      const row = debriefForAttention(input.db, attentionId);
      if (!row || row.status !== "failed") {
        return null;
      }
      const attention = getAttentionItem(input.db, attentionId);
      if (attention?.status === "open") {
        resolveAttentionItem(
          input.db,
          attention.id,
          "resolved",
          "The user explicitly re-armed the completion debrief.",
        );
      }
      linkDebriefAttention(input.db, row.digest_id, null);
      input.onAttentionChanged?.(row.project_id);
      return rearmDebrief(input.db, row.digest_id, now().toISOString());
    },
  };
}
