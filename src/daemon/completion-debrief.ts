export type RetirementDebriefState =
  | { status: "succeeded" }
  | { status: "pending" | "running" }
  | { status: "failed"; reason: string; retryable: boolean };

export function buildCompletionDebrief(input: {
  digestId: string;
  workerId: string;
  laneName: string;
  retirement: RetirementDebriefState;
}): { noteText: string; seed: string } {
  const { digestId, workerId, laneName, retirement } = input;
  const retirementFact =
    retirement.status === "succeeded"
      ? "The worker and lane were retired successfully after verification."
      : retirement.status === "failed"
        ? `Retirement FAILED after verification: ${retirement.reason} This failure is ${retirement.retryable ? "classified transient and will be retried" : "classified non-retryable and needs intervention"}. Do not describe the worker as retired.`
        : "Retirement has not completed yet. Do not describe the worker as retired.";
  const noteText =
    retirement.status === "succeeded"
      ? `Worker "${laneName}" finished, passed the quality gate, and retired — Darwin is preparing the debrief.`
      : `Worker "${laneName}" finished and passed the quality gate, but retirement did not complete — Darwin is preparing an honest debrief.`;
  const seed =
    `SYSTEM — worker completion.\n\n` +
    `Worker ${workerId} (lane "${laneName}") finished its task and completion digest ${digestId} PASSED the quality gate (digest status manager_reviewed). Verification and retirement are separate facts. ${retirementFact}\n\n` +
    `Debrief the user now, per your narrating-worker-events doctrine:\n` +
    `1. Call worker_status with id ${workerId} AND digest_id ${digestId} — this digest-bound lookup is required because the worker may have a newer report. Use that digest's narrative, before → after, claims and evidence.\n` +
    `2. Compose the debrief in your reply: what the worker set out to do, what actually changed, the verified claims with their evidence status, and point the user at the diffs, commits, and green checks on the workers page (lane "${laneName}").\n` +
    `3. State the retirement outcome exactly as supplied above. Say plainly anything unfinished, deferred, failed, or worth a follow-up.\n` +
    `Answer-first and short — a colleague reporting a landed change, not a log dump.`;
  return { noteText, seed };
}
