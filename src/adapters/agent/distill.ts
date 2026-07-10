// Post-turn distillation (architecture §5): one cheap follow-up prompt on a
// FORK of the manager session (resume + forkSession) so Darwin's main context
// never accumulates distillation chatter. Nothing from the fork is persisted
// except the records it writes; the fork runs the small distill model, and
// docs/galapagos/ is auto-committed in the target repo afterwards — covering
// both fork writes and records Darwin wrote mid-turn.
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { GalapagosConfig } from "../../config";
import type { GalapagosDb } from "../db/db";
import { nowIso } from "../db/db";
import { createJob, failJob, finishJob, startJob } from "../db/repos/jobs";
import { markTurnsDistilled } from "../db/repos/manager";
import type { ProjectRow } from "../db/repos/projects";
import { commitRecords, type CommitRecordsResult } from "../git/mutating-runner";
import { createManagerToolServer } from "./manager-tools";
import { baseQueryOptions } from "./spawn";

const DISTILL_ALLOWED_TOOLS = [
  "mcp__galapagos__read_records",
  "mcp__galapagos__write_record",
  "mcp__galapagos__update_record",
];

const DISTILL_PROMPT = `Post-turn distillation pass. Record any durable outcomes of this exchange
using write_record (or update_record to resolve/supersede an existing record —
check read_records before writing to avoid duplicates). Durable means: an
agreed answer, a goal, a plan the user accepted, an open or deferred
question, a real decision the user made.
A proposal the user has NOT yet accepted is none of those — record it as an
open_question ("user has not yet decided: <the call to make>") so it keeps
being re-raised, or write nothing; never write implementation_plan or
decision records for directions the user has not approved.
If the exchange reversed or revised a previously recorded answer, mark the
old record superseded via update_record with a note naming the replacement —
a stale record left standing as agreed is memory corruption, worse than a
missing one. Doctrine, not transcripts — never dump conversation. Write
nothing if nothing durable happened; in that case reply exactly "nothing
durable".`;

const DISTILL_SYSTEM_PROMPT = `You are the Galapagos distillation pass running on a fork of the manager's
session. Your ONLY job is extracting durable outcomes of the latest exchange
into the records store via the galapagos tools. You do not converse, plan, or
propose. Records are doctrine, not transcripts: short, durable, linkable.
If nothing durable happened, write nothing.`;

export type DistillOutcome = {
  ran: boolean;
  recordsWritten: number;
  commit: CommitRecordsResult;
  error: string | null;
};

export async function runDistillJob(input: {
  db: GalapagosDb;
  config: GalapagosConfig;
  project: ProjectRow;
  sessionId: string;
  /** Resume pointer of the manager session to fork; null = nothing to fork. */
  sdkSessionId: string | null;
  /** Shared with the main turn: a triple-Esc during distill aborts the fork. */
  abortController?: AbortController;
}): Promise<DistillOutcome> {
  const { db, config, project } = input;
  const job = createJob(db, "distill", {
    projectId: project.id,
    sessionId: input.sessionId,
    sdkSessionId: input.sdkSessionId,
  });
  startJob(db, job.id);
  // Coverage boundary: this pass forks the session as it exists NOW. A user
  // turn that lands while the fork runs (a preempting message) is not in it
  // and must stay undistilled for the next pass.
  const coverageCutoff = nowIso();

  let recordsWritten = 0;
  let ran = false;
  let distillError: string | null = null;

  if (input.sdkSessionId) {
    const toolServer = createManagerToolServer({
      projectRoot: project.root_path,
      projectSlug: project.slug,
      vaultPath: config.vaultPath,
      onToolEvent: (event) => {
        if (event.tool === "write_record" && event.summary.startsWith("wrote ")) {
          recordsWritten += 1;
        }
        if (event.tool === "update_record" && event.summary.startsWith("updated ")) {
          recordsWritten += 1;
        }
      },
    });

    try {
      const stream = query({
        prompt: DISTILL_PROMPT,
        options: {
          ...baseQueryOptions({
            config,
            cwd: project.root_path,
            resume: input.sdkSessionId,
            forkSession: true,
          }),
          ...(input.abortController ? { abortController: input.abortController } : {}),
          model: config.distillModel,
          systemPrompt: DISTILL_SYSTEM_PROMPT,
          mcpServers: { galapagos: toolServer },
          allowedTools: DISTILL_ALLOWED_TOOLS,
          maxTurns: 12,
        },
      });
      for await (const message of stream) {
        if (message.type === "result") {
          ran = message.subtype === "success" && !message.is_error;
          if (!ran) {
            distillError = `distill fork ended with ${message.subtype}`;
          }
        }
      }
      if (ran) {
        // Fork content is discarded by design; only coverage is stamped —
        // and only for turns that existed when this pass began.
        markTurnsDistilled(db, input.sessionId, coverageCutoff);
      }
    } catch (error) {
      // Auth or spawn failure: never retry on a fresh session (a fork without
      // the parent's context has nothing to distill) — surface and move on.
      distillError = input.abortController?.signal.aborted
        ? "distillation interrupted by user"
        : error instanceof Error
          ? error.message
          : String(error);
    }
  }

  // Commit regardless of the fork's fate: Darwin may have written records
  // mid-turn (record_specific / write_record) that must land in history.
  const commit = await commitRecords(
    project.root_path,
    `galapagos(records): distill ${recordsWritten > 0 ? `${recordsWritten} record${recordsWritten === 1 ? "" : "s"}` : "turn outcomes"}`,
  );

  const outcome: DistillOutcome = { ran, recordsWritten, commit, error: distillError };
  if (distillError) {
    failJob(db, job.id, distillError);
  } else {
    finishJob(db, job.id, outcome);
  }
  return outcome;
}
