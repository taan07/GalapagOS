import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { GLP_TYPES, type GlpType } from "../../core/records/schema";
import type { Frontmatter } from "../../core/records/frontmatter";
import { oneLine } from "../../core/text";
import type { GalapagosConfig } from "../../config";
import type { GalapagosDb } from "../db/db";
import {
  getAttentionItem,
  listOpenAttentionItems,
  resolveAttentionItem,
} from "../db/repos/attention";
import {
  getCompletionDigest,
  latestDigestForWorker,
  setDigestStatus,
} from "../db/repos/digests";
import { buildWorkerEvidence } from "../evidence/adapter";
import { scoreWorker } from "../../core/confidence/engine";
import { getLane, laneGlobs } from "../db/repos/lanes";
import type { ProjectRow } from "../db/repos/projects";
import { getWorker } from "../db/repos/workers";
import { runChecks, renderRunChecksResult } from "../checks/run-checks";
import {
  describeOutcome,
  type DecisionField,
  type DecisionOption,
  type DecisionOutcome,
} from "./decisions";
import { observeGitRepository, recentLog } from "../git/runner";
import { mergeBranch } from "../git/mutating-runner";
import { createRecordsStore, type RecordDoc } from "../records/store";
import { recordAgreedSpecific } from "../records/write-through";
import { listAgreedSpecifics } from "../vault/specifics";
import type { WorkerRuntime, WorkerStatusView } from "./worker-runtime";

export type ManagerToolContext = {
  projectRoot: string;
  projectSlug: string;
  vaultPath: string;
  /**
   * Worker control (chunk 3). Present only when the caller owns live worker
   * sessions — the daemon's manager turns. Absent for distillation forks,
   * whose tool surface is records-only.
   */
  workers?: WorkerRuntime;
  project?: ProjectRow;
  /**
   * Evidence and attention surface (chunk 4): run_checks, list_attention,
   * resolve_attention, review_completion need the central db. Present for
   * daemon-owned manager and triage sessions; absent for distill forks.
   */
  db?: GalapagosDb;
  config?: GalapagosConfig;
  /**
   * The chat decision channel (user-confirmed 2026-07-05): put a decision to
   * the user as clickable options and WAIT. Wired for live manager turns
   * only — a triage session must never block on the user.
   */
  askUser?: (
    question: string,
    options: DecisionOption[],
    multiSelect: boolean,
  ) => Promise<DecisionOutcome>;
  /**
   * A compact batch of 2-4 clickable questions as ONE card (2026-07-08): the
   * antidote to a wall of prose. Each field is select-only; free text still
   * arrives via the chat composer. Live manager turns only.
   */
  askBatch?: (fields: DecisionField[]) => Promise<DecisionOutcome>;
  /**
   * Play back your current understanding for the user to confirm or correct
   * ([Confirmed] / [Needs correction] + chat free-text). Live turns only.
   */
  askConfirm?: (playback: string) => Promise<DecisionOutcome>;
  /**
   * Fire-and-forget escalation (chunk 4 triage; track E made it a real card):
   * the question lands as a pending decision card in the user's chat AND a
   * high-priority queue item — without waiting. Options ride along so the
   * card is clickable, not prose; the answer wakes Darwin. Wired only for
   * triage sessions.
   */
  escalateToUser?: (
    question: string,
    context: string,
    options?: DecisionOption[],
    multiSelect?: boolean,
  ) => { attentionId: string };
  /**
   * The sign-off hook (track C): fired when update_record moves an
   * implementation_plan to "approved" — the signature that ends Interview
   * mode. Returns whether the mode actually flipped (Interview → Default);
   * the tool words its reply on that truth. Wire it in EVERY context that
   * can reach update_record (manager turns, distill forks, triage) — an
   * unwired approval would strand a project in Interview.
   */
  onPlanApproved?: () => boolean;
  /** Cancels any triage card linked to an attention item once it closes. */
  onAttentionResolved?: (attentionId: string) => void;
  onToolEvent?: (event: { tool: string; summary: string; detail: string }) => void;
};

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

export const GIT_TRUTH_SCOPES = ["status", "branches", "worktrees", "log"] as const;

export async function runGitTruth(
  projectRoot: string,
  scope: (typeof GIT_TRUTH_SCOPES)[number],
): Promise<string> {
  if (scope === "log") {
    const log = await recentLog(projectRoot);
    return log.trim() || "(no commits)";
  }

  const observation = await observeGitRepository(projectRoot);
  if (scope === "branches") {
    return JSON.stringify(
      { activeBranch: observation.activeBranch, branches: observation.branches },
      null,
      2,
    );
  }
  if (scope === "worktrees") {
    return JSON.stringify(observation.worktrees, null, 2);
  }
  return JSON.stringify(
    {
      repoRoot: observation.repoRoot,
      activeBranch: observation.activeBranch,
      headSha: observation.headSha,
      status: observation.status,
      diffSummary: {
        unstaged: observation.diffSummary.unstaged,
        staged: observation.diffSummary.staged,
      },
      dirtyFingerprint: observation.dirtyFingerprint,
      observedAt: observation.observedAt,
    },
    null,
    2,
  );
}

function describeRecord(doc: RecordDoc): string {
  return `[${doc.type}/${doc.status}] ${doc.title} (id ${doc.id}, ${doc.createdAt.slice(0, 10)}) — ${doc.filePath}`;
}

function renderFullRecord(doc: RecordDoc): string {
  const lines = [
    describeRecord(doc),
    `updated: ${doc.updatedAt}`,
    ...Object.entries(doc.frontmatter)
      .filter(([key]) => !["id", "glp_type", "title", "status", "created_at", "updated_at"].includes(key))
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    "",
    doc.body.trim(),
  ];
  return lines.join("\n");
}

function summarizeEventPayload(payload: Record<string, unknown>): string {
  if (typeof payload.text === "string") {
    return payload.text;
  }
  if (typeof payload.tool === "string") {
    return `${payload.tool} ${JSON.stringify(payload.input ?? {})}`;
  }
  if (typeof payload.message === "string") {
    return payload.message;
  }
  if (typeof payload.subtype === "string") {
    return payload.subtype;
  }
  return JSON.stringify(payload);
}

function renderWorkerStatus(view: WorkerStatusView): string {
  const { worker, lane, recentEvents, eventsTotal, digest, attention } = view;
  const globs = lane ? laneGlobs(lane) : null;
  const lines = [
    `worker ${worker.id} [${worker.status}] on lane "${lane?.name ?? "(lane missing)"}"`,
    `branch ${worker.branch} in ${worker.worktree_path} (base ${lane?.base_sha.slice(0, 8) ?? "?"})`,
    globs
      ? `lane globs — allowed: ${globs.allowedGlobs.join(", ")}; forbidden: ${globs.forbiddenGlobs.join(", ") || "(none)"}`
      : "",
    `last activity: ${worker.last_message_at ?? "(none yet)"}${worker.last_summary ? ` — ${worker.last_summary}` : ""}`,
    digest
      ? `completion digest ${digest.id} (${digest.status}): ${digest.narrative}`
      : "no completion digest — NOT done, whatever the transcript claims",
  ].filter(Boolean);

  const openAttention = attention.filter((item) => item.status === "open");
  if (openAttention.length > 0) {
    lines.push(
      "open attention:",
      ...openAttention.map((item) => `  - [${item.priority}] ${item.kind}: ${item.title}`),
    );
  }

  if (recentEvents.length > 0) {
    lines.push(
      `recent events (${eventsTotal} total, showing last ${recentEvents.length}):`,
      ...recentEvents.map((event) => {
        const payload = JSON.parse(event.payload) as Record<string, unknown>;
        return `  ${event.created_at.slice(11, 19)} ${event.kind}: ${oneLine(summarizeEventPayload(payload), 160)}`;
      }),
    );
  }
  return lines.join("\n");
}

export function createManagerToolServer(context: ManagerToolContext) {
  const emit = (toolName: string, summary: string, detail: string) => {
    context.onToolEvent?.({ tool: toolName, summary, detail });
  };
  const store = createRecordsStore(context.projectRoot, context.projectSlug);
  const requireWorkers = (): { workers: WorkerRuntime; project: ProjectRow } | null =>
    context.workers && context.project
      ? { workers: context.workers, project: context.project }
      : null;
  const requireEvidence = (): {
    db: GalapagosDb;
    config: GalapagosConfig;
    project: ProjectRow;
  } | null =>
    context.db && context.config && context.project
      ? { db: context.db, config: context.config, project: context.project }
      : null;

  return createSdkMcpServer({
    name: "galapagos",
    version: "0.1.0",
    tools: [
      tool(
        "git_truth",
        "Observe the project's real git state (read-only). Use this before making any claim about the repository.",
        { scope: z.enum(GIT_TRUTH_SCOPES) },
        async ({ scope }) => {
          const detail = await runGitTruth(context.projectRoot, scope);
          emit("git_truth", `checked git ${scope}`, detail);
          return text(detail);
        },
      ),
      tool(
        "record_specific",
        "Record ONE agreed specific the user just confirmed (a pinned-down decision). Writes a durable user_answer record in the project's records store, mirrored to the user's Obsidian vault. Use one call per distinct decision; never record vague statements.",
        { question: z.string(), answer: z.string() },
        async ({ question, answer }) => {
          const result = recordAgreedSpecific({
            store,
            vaultPath: context.vaultPath,
            projectSlug: context.projectSlug,
            question,
            answer,
          });
          const mirrorNote = result.mirrorError
            ? `Vault mirror failed (${result.mirrorError}) — the record itself is safe.`
            : `Vault mirror: ${result.mirrorFileName}`;
          emit(
            "record_specific",
            `recorded: ${result.record.title}`,
            `${describeRecord(result.record)}\n${mirrorNote}`,
          );
          return text(`Recorded user_answer ${result.record.id} at ${result.record.filePath}. ${mirrorNote}`);
        },
      ),
      tool(
        "list_specifics",
        "List every agreed specific recorded for this project. Consult this before proposing anything, and never re-ask an already-answered question.",
        {},
        async () => {
          const specifics = listAgreedSpecifics(context.vaultPath, context.projectSlug);
          emit(
            "list_specifics",
            `consulted ${specifics.length} agreed specific${specifics.length === 1 ? "" : "s"}`,
            specifics.map((item) => `- ${item.question} → ${item.answer}`).join("\n") || "(none)",
          );
          if (specifics.length === 0) {
            return text("No agreed specifics recorded for this project yet.");
          }
          return text(
            specifics
              .map(
                (item) =>
                  `[${item.status}] ${item.question}\n  answer: ${item.answer}\n  recorded: ${item.createdAt} (${item.fileName})`,
              )
              .join("\n\n"),
          );
        },
      ),
      tool(
        "read_records",
        "Read durable project records (docs/galapagos/ in the project repo). Without arguments lists everything; filter by type/status, or pass id for one full record. Consult this before proposing anything.",
        {
          type: z.enum(GLP_TYPES).optional(),
          status: z.string().optional(),
          id: z.string().optional(),
        },
        async ({ type, status, id }) => {
          if (id) {
            const doc = store.get(id);
            if (!doc) {
              emit("read_records", `no record ${id}`, "");
              return text(`No record with id ${id}. Use read_records without id to list what exists.`);
            }
            emit("read_records", `read ${doc.type} ${doc.id}`, describeRecord(doc));
            return text(renderFullRecord(doc));
          }
          const docs = store.list({ ...(type ? { type } : {}), ...(status ? { status } : {}) });
          emit(
            "read_records",
            `consulted ${docs.length} record${docs.length === 1 ? "" : "s"}`,
            docs.map(describeRecord).join("\n") || "(none)",
          );
          if (docs.length === 0) {
            return text(
              "No records match — the store has nothing durable recorded here yet. Do not invent records.",
            );
          }
          return text(docs.map(describeRecord).join("\n"));
        },
      ),
      tool(
        "write_record",
        "Write ONE durable record to the project's records store (git-committed markdown). Records are doctrine, not transcripts: short, durable, linkable — never conversation dumps. Types: manager_synthesis (your evolving understanding), active_goal, implementation_plan, open_question (unanswered/deferred — track and re-raise), user_answer (a pinned-down answer; prefer record_specific for these), routed_clarification, worker_brief, decision (requires decision_options, rollback_note, confidence_impact).",
        {
          type: z.enum(GLP_TYPES),
          title: z.string(),
          body: z.string(),
          status: z.string().optional(),
          question: z.string().optional(),
          answer: z.string().optional(),
          decision_options: z.array(z.string()).optional(),
          chosen_path: z.string().optional(),
          rollback_note: z.string().optional(),
          confidence_impact: z.string().optional(),
          parent_decision_ref: z.string().optional(),
        },
        async (input) => {
          const extra: Frontmatter = {};
          if (input.question) extra.question = input.question;
          if (input.answer) extra.answer = input.answer;
          if (input.decision_options) extra.decision_options = input.decision_options;
          if (input.chosen_path) extra.chosen_path = input.chosen_path;
          if (input.rollback_note) extra.rollback_note = input.rollback_note;
          if (input.confidence_impact) extra.confidence_impact = input.confidence_impact;
          if (input.parent_decision_ref) extra.parent_decision_ref = input.parent_decision_ref;
          try {
            const doc = store.create({
              type: input.type as GlpType,
              title: input.title,
              body: input.body,
              ...(input.status ? { status: input.status } : {}),
              extra,
            });
            emit("write_record", `wrote ${doc.type}: ${doc.title}`, renderFullRecord(doc));
            return text(`Wrote ${doc.type} ${doc.id} at ${doc.filePath}.`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            emit("write_record", `rejected ${input.type}`, message);
            return text(`Record rejected: ${message}`);
          }
        },
      ),
      tool(
        "update_record",
        "Update an existing record: change status (closed statuses — resolved/done/approved/superseded/archived — are only reachable here), append a dated note, or set chosen_path on a decision. Never rewrites history.",
        {
          id: z.string(),
          status: z.string().optional(),
          note: z.string().optional(),
          chosen_path: z.string().optional(),
        },
        async ({ id, status, note, chosen_path }) => {
          try {
            const doc = store.update({
              id,
              ...(status !== undefined ? { status } : {}),
              ...(note !== undefined ? { note } : {}),
              ...(chosen_path !== undefined ? { chosenPath: chosen_path } : {}),
            });
            emit("update_record", `updated ${doc.type} ${doc.id} → ${doc.status}`, renderFullRecord(doc));
            if (doc.type === "implementation_plan" && doc.status === "approved") {
              // The formal sign-off (track C): an approved plan is the
              // signature that ends Interview mode — but the reply only says
              // so when the flip actually happened (already in Default/Auto,
              // or an unwired context, is a plain record update).
              const flipped = context.onPlanApproved?.() ?? false;
              return text(
                flipped
                  ? `Updated ${doc.type} ${doc.id}: status approved. The plan is SIGNED — Interview mode has ended and the project is back in Default mode; building may begin.`
                  : `Updated ${doc.type} ${doc.id}: status approved.`,
              );
            }
            return text(`Updated ${doc.type} ${doc.id}: status ${doc.status}.`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            emit("update_record", `update rejected for ${id}`, message);
            return text(`Update rejected: ${message}`);
          }
        },
      ),
      tool(
        "spawn_worker",
        "Spawn ONE worker on a scoped task in its own git worktree, bound to a lane (exclusive allowed/forbidden file globs). The spawn is refused if the lane's allowed globs overlap any active lane — lanes are exclusive. Write the brief like a real hand-off: goal, constraints, how to verify; the worker sees only the brief and its worktree, none of this conversation. A worker_brief record is written and committed automatically.",
        {
          lane_name: z.string().describe("Short lane name, e.g. 'auth ui'"),
          allowed_globs: z
            .array(z.string())
            .describe("Files the worker may change, e.g. ['src/auth/**']"),
          forbidden_globs: z.array(z.string()).optional(),
          brief_title: z.string(),
          brief: z.string().describe("The full task brief — the worker's first message"),
          model: z.string().optional().describe("Override the default worker model"),
        },
        async (input) => {
          const bridge = requireWorkers();
          if (!bridge) {
            return text("Worker control is not available in this context.");
          }
          const outcome = await bridge.workers.spawn({
            project: bridge.project,
            laneName: input.lane_name,
            allowedGlobs: input.allowed_globs,
            ...(input.forbidden_globs ? { forbiddenGlobs: input.forbidden_globs } : {}),
            briefTitle: input.brief_title,
            brief: input.brief,
            ...(input.model ? { model: input.model } : {}),
          });
          if (!outcome.ok) {
            emit("spawn_worker", `spawn rejected: ${input.lane_name}`, outcome.reason);
            return text(`Spawn rejected: ${outcome.reason}`);
          }
          const detail = [
            `worker ${outcome.workerId}`,
            `lane "${input.lane_name}" — allowed: ${input.allowed_globs.join(", ")}`,
            `worktree ${outcome.worktreePath} on ${outcome.branch} (base ${outcome.baseSha.slice(0, 8)})`,
            `brief record ${outcome.briefRecordId}`,
            ...(outcome.briefCommitNote ? [outcome.briefCommitNote] : []),
          ].join("\n");
          emit("spawn_worker", `spawned worker on lane "${input.lane_name}"`, detail);
          return text(
            `Spawned worker ${outcome.workerId} on lane "${input.lane_name}".\n${detail}\nIt is working now — check on it with worker_status.`,
          );
        },
      ),
      tool(
        "resume_worker",
        "Continue a STOPPED (or failed) worker's task: a fresh session in the SAME worktree and branch, lane re-activated, briefed from the original worker_brief record plus the worktree's current git state and your continuation note. This is the ONLY way to continue stopped work — never reuse its lane name for a new spawn. Note: daemon restarts no longer stop workers (live sessions are re-attached in place — steer those as normal); resume is for workers that genuinely ended.",
        {
          id: z.string().describe("The stopped worker's id"),
          note: z
            .string()
            .optional()
            .describe("Continuation instruction — what to focus on or change"),
        },
        async ({ id, note }) => {
          const bridge = requireWorkers();
          if (!bridge) {
            return text("Worker control is not available in this context.");
          }
          const outcome = await bridge.workers.resume({
            project: bridge.project,
            workerId: id,
            ...(note ? { note } : {}),
          });
          if (!outcome.ok) {
            emit("resume_worker", `resume rejected for ${id.slice(0, 8)}`, outcome.reason);
            return text(`Resume rejected: ${outcome.reason}`);
          }
          const detail = [
            `new worker ${outcome.workerId} (continues ${id})`,
            `same worktree ${outcome.worktreePath} on ${outcome.branch}`,
            `lane "${outcome.laneSlug}" re-activated`,
          ].join("\n");
          emit("resume_worker", `resumed work as worker ${outcome.workerId.slice(0, 8)}`, detail);
          return text(
            `Resumed. ${detail}\nThe new session was briefed with the original brief plus the worktree's real state${note ? " and your note" : ""}. Check on it with worker_status.`,
          );
        },
      ),
      tool(
        "steer_worker",
        "Inject a message into a running worker mid-task: course corrections, answers to its questions, added context. The worker treats it as part of the same task. By default this waits briefly for the worker's next reply so you can confirm the steer was understood — check the reply before telling the user it landed.",
        {
          id: z.string(),
          message: z.string(),
          await_response: z
            .boolean()
            .optional()
            .describe("Wait up to ~60s for the worker's reply (default true)"),
        },
        async ({ id, message, await_response }) => {
          const bridge = requireWorkers();
          if (!bridge) {
            return text("Worker control is not available in this context.");
          }
          const outcome = await bridge.workers.steer(id, message, {
            awaitResponse: await_response ?? true,
          });
          if (!outcome.ok) {
            emit("steer_worker", `steer failed for ${id}`, outcome.reason);
            return text(`Steer failed: ${outcome.reason}`);
          }
          if (outcome.response !== null) {
            emit("steer_worker", `steered worker ${id.slice(0, 8)} — it replied`, `${message}\n\n↳ ${outcome.response}`);
            return text(`Message delivered. The worker's reply: ${outcome.response}`);
          }
          emit("steer_worker", `steered worker ${id.slice(0, 8)}`, message);
          return text(
            await_response === false
              ? `Message delivered to worker ${id}.`
              : `Message delivered to worker ${id} — no reply within the wait window yet. Check worker_status shortly; do not assume how the steer was taken.`,
          );
        },
      ),
      tool(
        "hold_worker",
        "Pause a live worker WITHOUT stopping it: sends a hold instruction — the worker states exactly where it is and waits. The lane stays active and the session stays live; release it later with steer_worker ('continue'). Use this when the user wants to think or redirect without losing the session.",
        { id: z.string() },
        async ({ id }) => {
          const bridge = requireWorkers();
          if (!bridge) {
            return text("Worker control is not available in this context.");
          }
          const outcome = await bridge.workers.hold(id, "Darwin");
          if (!outcome.ok) {
            emit("hold_worker", `hold failed for ${id}`, outcome.reason);
            return text(`Hold failed: ${outcome.reason}`);
          }
          emit(
            "hold_worker",
            `held worker ${id.slice(0, 8)}`,
            outcome.response ?? "(no acknowledgment yet)",
          );
          return text(
            outcome.response !== null
              ? `Worker held. Its position: ${outcome.response}`
              : "Hold delivered — the worker has not acknowledged within the wait window; check worker_status shortly.",
          );
        },
      ),
      tool(
        "amend_lane",
        "Widen a LIVE worker's lane mid-flight (add allowed globs) — for the moment a nearly-done task legitimately needs one file outside its lane. The amendment passes the same exclusivity gate a spawn does, and THE USER MUST APPROVE it first: this tool asks them in chat and waits. State a concrete reason; it is shown to the user verbatim.",
        {
          id: z.string().describe("The live worker's id"),
          add_globs: z.array(z.string()).describe("Globs to ADD to the allowed set"),
          reason: z.string().describe("Why the task needs this, in user terms"),
        },
        async ({ id, add_globs, reason }) => {
          const bridge = requireWorkers();
          if (!bridge) {
            return text("Worker control is not available in this context.");
          }
          if (!context.askUser) {
            return text(
              "Lane amendments require the user's approval, and no decision channel is available in this context.",
            );
          }
          const status = bridge.workers.status(id);
          if (!status) {
            return text(`No worker with id ${id}.`);
          }
          const laneName = status.lane?.name ?? "(unknown lane)";
          const decision = await context.askUser(
            `Darwin wants to widen worker lane "${laneName}" to also allow: ${add_globs.join(", ")}. Reason: ${reason}`,
            [
              {
                label: "Allow the amendment",
                implication: `The worker may now also change files matching ${add_globs.join(", ")} — the change is recorded and audited like everything else.`,
              },
              {
                label: "Deny",
                implication: "The lane stays as declared; the worker must finish without those files (or be stopped and re-scoped).",
              },
            ],
            false,
          );
          if (decision.status !== "answered") {
            emit("amend_lane", `amendment ${decision.status} for ${laneName}`, reason);
            return text("The turn was interrupted before the user answered — the lane is UNCHANGED.");
          }
          const approved = decision.answer.selections.includes("Allow the amendment");
          if (!approved) {
            emit("amend_lane", `user denied widening ${laneName}`, decision.answer.custom || reason);
            return text(
              `The user DENIED the amendment${decision.answer.custom ? ` — their note: ${decision.answer.custom}` : ""}. The lane is unchanged; adjust the plan accordingly.`,
            );
          }
          const outcome = await bridge.workers.applyLaneAmendment({
            project: bridge.project,
            workerId: id,
            addGlobs: add_globs,
            reason,
            approvedBy: "the user (in chat)",
          });
          if (!outcome.ok) {
            emit("amend_lane", `amendment failed for ${laneName}`, outcome.reason);
            return text(`The user approved, but the amendment failed: ${outcome.reason}`);
          }
          emit(
            "amend_lane",
            `lane "${laneName}" widened (user-approved)`,
            `now allows: ${outcome.allowedGlobs.join(", ")}\nreason: ${reason}`,
          );
          return text(
            `Amendment applied with the user's approval. Lane "${laneName}" now allows: ${outcome.allowedGlobs.join(", ")}. The worker has been told.${decision.answer.custom ? ` User note: ${decision.answer.custom}` : ""}`,
          );
        },
      ),
      tool(
        "merge_worker",
        "Merge a worker's branch into the project's current checkout — ONLY ever at the user's say-so. If the USER explicitly told you to merge in their message, pass user_instructed=true and it merges straight away. If YOU are proposing the merge, pass user_instructed=false and it puts a one-click Merge/Not-yet confirmation to the user and waits. Set user_instructed=true ONLY when the user's own words this turn asked for the merge; when in doubt, false. On conflict the merge is aborted and the checkout restored untouched — you report the conflicting files and hand it back. The worktree and branch are left intact.",
        {
          id: z.string().describe("The worker whose branch to merge"),
          user_instructed: z
            .boolean()
            .describe(
              "True ONLY if the user explicitly asked for this merge in their message; false when you are the one proposing it (triggers a one-click confirmation).",
            ),
        },
        async ({ id, user_instructed }) => {
          const bridge = requireWorkers();
          if (!bridge) {
            return text("Worker control is not available in this context.");
          }
          const status = bridge.workers.status(id);
          if (!status) {
            emit("merge_worker", `no worker ${id}`, "");
            return text(`No worker with id ${id}. Use list_workers to see what exists.`);
          }
          const branch = status.worker.branch;
          const laneName = status.lane?.name ?? "(unknown lane)";

          // Darwin-initiated merges need the user's one click; user-instructed
          // ones do not (they asked). This is the whole gate — the capability
          // exists, but it never fires on Darwin's own initiative.
          if (!user_instructed) {
            if (!context.askUser) {
              return text(
                "A merge you propose needs the user's confirmation, and no decision channel is available in this context.",
              );
            }
            const decision = await context.askUser(
              `Darwin suggests merging worker lane "${laneName}" (branch ${branch}) into the current checkout.`,
              [
                {
                  label: "Merge into main",
                  implication: `Branch ${branch} lands in the project's checkout as a merge commit. The worktree and branch stay for reference.`,
                },
                {
                  label: "Not yet",
                  implication: "Nothing is merged; the branch stays where it is until you say so.",
                },
              ],
              false,
            );
            if (decision.status !== "answered") {
              emit("merge_worker", `merge ${decision.status} for ${branch}`, laneName);
              return text("The turn was interrupted before the user answered — NOTHING was merged.");
            }
            if (!decision.answer.selections.includes("Merge into main")) {
              emit("merge_worker", `user declined merging ${branch}`, decision.answer.custom || laneName);
              return text(
                `The user chose NOT to merge${decision.answer.custom ? ` — their note: ${decision.answer.custom}` : ""}. Branch ${branch} is untouched.`,
              );
            }
          }

          const result = await mergeBranch({
            projectRoot: context.projectRoot,
            branch,
            message: `galapagos: merge worker lane "${laneName}" (${branch})`,
          });
          if (result.status === "conflict") {
            emit("merge_worker", `merge conflict: ${branch}`, result.files.join("\n"));
            return text(
              `Merge hit conflicts in ${result.files.length} file${result.files.length === 1 ? "" : "s"} and was aborted — your checkout is exactly as it was. Conflicting: ${result.files.join(", ")}. Resolve these by hand (or steer/resume the worker to rebase), then try again.`,
            );
          }
          if (result.status === "failed") {
            emit("merge_worker", `merge failed: ${branch}`, result.reason);
            return text(`Merge did not run: ${result.reason}. Nothing was merged.`);
          }
          emit(
            "merge_worker",
            `merged ${branch} → ${result.into}`,
            `${user_instructed ? "user-instructed" : "user-approved"} merge commit ${result.sha.slice(0, 8)}`,
          );
          return text(
            `Merged branch ${branch} into ${result.into} (merge commit ${result.sha.slice(0, 8)}). The worktree and branch remain for reference.`,
          );
        },
      ),
      tool(
        "ask_user",
        "Put a REAL decision to the user. In a live chat turn this renders clickable options and WAITS until the user answers or the turn is interrupted (the user always gets a free-text field). In a triage session it instead lands the question in the user's chat AND on the attention queue without waiting — include your recommendation in `context`. Use only for decisions that change what gets built or how; never re-ask what records already answer.",
        {
          question: z.string().describe("The decision, phrased concretely"),
          options: z
            .array(
              z.object({
                label: z.string().describe("Short choice text (1-6 words)"),
                implication: z
                  .string()
                  .describe("What choosing this means in practice, in product terms"),
              }),
            )
            .max(6)
            .optional()
            .describe("2-6 choices; omit for a pure free-text question"),
          multi_select: z
            .boolean()
            .optional()
            .describe("Allow choosing several options (default false)"),
          context: z
            .string()
            .optional()
            .describe(
              "Triage escalations: why this needs the user, what you checked, your recommendation",
            ),
        },
        async ({ question, options, multi_select, context: questionContext }) => {
          if (context.askUser) {
            const decision = await context.askUser(question, options ?? [], multi_select ?? false);
            emit(
              "ask_user",
              decision.status === "answered" ? "the user decided" : `question ${decision.status}`,
              `${question}\n↳ ${describeOutcome(decision)}`,
            );
            return text(describeOutcome(decision));
          }
          if (context.escalateToUser) {
            const triageOptions = options ?? [];
            if (
              triageOptions.length < 2 ||
              triageOptions.length > 4 ||
              triageOptions.some((option) => !option.label.trim() || !option.implication.trim())
            ) {
              return text(
                "Triage escalations require 2-4 concrete clickable options (each with a label and practical implication). Do not create a free-text-only triage card.",
              );
            }
            // Triage never blocks on the user: fire-and-forget card into chat
            // + queue; the answer arrives through Darwin. Options ride along
            // so the user clicks instead of typing prose.
            const { attentionId } = context.escalateToUser(
              question,
              questionContext ?? "",
              triageOptions,
              multi_select ?? false,
            );
            emit("ask_user", `escalated to user: ${oneLine(question, 80)}`, questionContext ?? "");
            return text(
              `Question delivered to the user as a card (attention item ${attentionId}). Do not wait for the answer — it will arrive through Darwin.`,
            );
          }
          return text(
            "The decision channel is not available in this context — ask in plain chat text instead.",
          );
        },
      ),
      tool(
        "ask_batch",
        "Put a COMPACT BATCH of 2-4 related decisions to the user as ONE clickable card — the antidote to a wall of questions in prose. Each question is select-only (the user picks; any free-text answer arrives via the chat composer, so never ask them to type into an option). Use when you have several small forks to resolve at once (e.g. tone + scope + units). Every option's implication MUST carry a concrete example so the choice is unambiguous ('Deadpan — e.g. \"Clear skies, a brisk -180°C\" with no wink'). Live chat turns only.",
        {
          questions: z
            .array(
              z.object({
                prompt: z.string().describe("The single question, phrased concretely"),
                options: z
                  .array(
                    z.object({
                      label: z.string().describe("Short choice text (1-6 words)"),
                      implication: z
                        .string()
                        .describe(
                          "What choosing this means in practice — MUST include a concrete 'e.g.' example",
                        ),
                    }),
                  )
                  .min(2)
                  .max(6)
                  .describe("2-6 choices for this question"),
                multi_select: z
                  .boolean()
                  .optional()
                  .describe("Allow choosing several options for this question (default false)"),
              }),
            )
            .min(2)
            .max(4)
            .describe("2-4 questions rendered as one card"),
        },
        async ({ questions }) => {
          if (!context.askBatch) {
            return text(
              "The batch decision channel is not available in this context — ask in plain chat text instead.",
            );
          }
          const fields: DecisionField[] = questions.map((q, index) => ({
            id: `q${index + 1}`,
            prompt: q.prompt,
            options: q.options,
            multiSelect: q.multi_select ?? false,
          }));
          const decision = await context.askBatch(fields);
          emit(
            "ask_batch",
            decision.status === "answered"
              ? `the user answered ${questions.length} questions`
              : `batch ${decision.status}`,
            `${questions.map((q) => `• ${q.prompt}`).join("\n")}\n↳ ${describeOutcome(decision, fields)}`,
          );
          return text(describeOutcome(decision, fields));
        },
      ),
      tool(
        "confirm_understanding",
        "Play back your CURRENT understanding of the task/direction in one tight paragraph and ask the user to confirm or correct it — a [Confirmed] / [Needs correction] card. Use after a material context shift or right before you spawn a worker on something consequential, NEVER as filler. 'Confirmed' means proceed; 'Needs correction' means the user will type the fix in chat — read it and update your synthesis (record_specific) before acting.",
        {
          playback: z
            .string()
            .describe("Your understanding in 2-5 sentences, concrete and checkable"),
        },
        async ({ playback }) => {
          if (!context.askConfirm) {
            return text(
              "The confirm channel is not available in this context — state your understanding in plain chat instead.",
            );
          }
          const decision = await context.askConfirm(playback);
          if (decision.status !== "answered") {
            emit("confirm_understanding", `playback ${decision.status}`, playback);
            return text("The turn was interrupted before the user confirmed. Do not assume your understanding is right.");
          }
          const confirmed =
            decision.answer.selections.includes("Confirmed") && !decision.answer.custom.trim();
          emit(
            "confirm_understanding",
            confirmed ? "user confirmed understanding" : "user asked for a correction",
            `${playback}\n↳ ${describeOutcome(decision)}`,
          );
          return text(
            confirmed
              ? "The user CONFIRMED your understanding. Proceed on it."
              : `The user wants a correction: ${describeOutcome(decision)}. Update your synthesis (record_specific) before acting.`,
          );
        },
      ),
      tool(
        "stop_worker",
        'Stop a worker: ends its session, audits every change in its worktree against the lane (out-of-lane files raise a high-priority lane_violation), retires the lane, and checks for a structured completion report. The worktree and branch survive for review. Retirement is QUALITY-GATED: intent "retire" (the default) is refused with the confidence reasons unless the completion is manager_reviewed — the monitor auto-reviews (and auto-retires) a completion whose evidence is strong with a clear queue. Use intent "abandon" to deliberately end unfinished or failing work (the abandonment is raised as an attention item).',
        {
          id: z.string(),
          intent: z.enum(["retire", "abandon"]).optional(),
          reason: z.string().optional(),
        },
        async ({ id, intent, reason }) => {
          const bridge = requireWorkers();
          if (!bridge) {
            return text("Worker control is not available in this context.");
          }
          const stopIntent = intent ?? "retire";
          const stoppedBy = reason ? `Darwin (${reason})` : "Darwin";
          const outcome = await bridge.workers.stop(id, stoppedBy, { intent: stopIntent });
          if (!outcome.ok) {
            // A refused retire carries the WHY: the same confidence report the
            // gauge shows, so Darwin can relay what is actually holding it.
            const evidenceContext = requireEvidence();
            if (stopIntent === "retire" && evidenceContext) {
              const worker = getWorker(evidenceContext.db, id);
              if (worker) {
                const lane = getLane(evidenceContext.db, worker.lane_id) ?? null;
                const evidence = await buildWorkerEvidence(evidenceContext.db, {
                  worker,
                  lane,
                  staleWorkerSeconds: evidenceContext.config.staleWorkerSeconds,
                });
                const report = scoreWorker(evidence.input);
                const capLines = report.caps.map((cap) => `  - ${cap.label}`).join("\n");
                const detail = [
                  `Retire refused: ${outcome.reason}`,
                  `Confidence ${report.score} (${report.state}) — ${report.stateReason}`,
                  capLines ? `What is holding it down:\n${capLines}` : "",
                ]
                  .filter(Boolean)
                  .join("\n");
                emit("stop_worker", `retire refused for ${id.slice(0, 8)}`, detail);
                return text(detail);
              }
            }
            emit("stop_worker", `stop failed for ${id}`, outcome.reason);
            return text(`Stop failed: ${outcome.reason}`);
          }
          const lines = [
            `Worker ${id} is ${outcome.status}; its lane is retired and its worktree survives for review.`,
            outcome.auditError
              ? `LANE AUDIT COULD NOT RUN: ${outcome.auditError} (raised as an attention item).`
              : outcome.violations.length > 0
                ? `LANE VIOLATIONS (${outcome.violations.length}, raised as a high-priority attention item):\n${outcome.violations.map((entry) => `  - ${entry.path} (${entry.reason})`).join("\n")}`
                : "Lane audit clean — every change matches the lane.",
            outcome.hasDigest
              ? "A structured completion report was parsed for this worker."
              : "No structured completion report was ever parsed — the worker is NOT done (raised as an attention item).",
          ];
          emit("stop_worker", `stopped worker ${id.slice(0, 8)}`, lines.join("\n"));
          return text(lines.join("\n"));
        },
      ),
      tool(
        "list_workers",
        "List every worker for this project with lane, status, and liveness.",
        {},
        async () => {
          const bridge = requireWorkers();
          if (!bridge) {
            return text("Worker control is not available in this context.");
          }
          const entries = bridge.workers.list(bridge.project.id);
          emit(
            "list_workers",
            `listed ${entries.length} worker${entries.length === 1 ? "" : "s"}`,
            entries
              .map(
                ({ worker, lane }) =>
                  `- ${worker.id} [${worker.status}] lane "${lane?.name ?? "?"}"`,
              )
              .join("\n") || "(none)",
          );
          if (entries.length === 0) {
            return text("No workers exist for this project yet.");
          }
          return text(
            entries
              .map(({ worker, lane }) =>
                [
                  `${worker.id} [${worker.status}] lane "${lane?.name ?? "(missing)"}"`,
                  `  last activity: ${worker.last_message_at ?? "(none yet)"}${worker.last_summary ? ` — ${worker.last_summary}` : ""}`,
                ].join("\n"),
              )
              .join("\n"),
          );
        },
      ),
      tool(
        "worker_status",
        "Full status of one worker: lane contract, liveness, completion digest (or its honest absence), open attention items, and the most recent events. Pass digest_id when narrating a queued completion so a newer digest cannot replace the one being reported.",
        { id: z.string(), digest_id: z.string().optional() },
        async ({ id, digest_id }) => {
          const bridge = requireWorkers();
          if (!bridge) {
            return text("Worker control is not available in this context.");
          }
          const view = bridge.workers.status(id);
          if (!view) {
            emit("worker_status", `no worker ${id}`, "");
            return text(`No worker with id ${id}. Use list_workers to see what exists.`);
          }
          const requestedDigest = digest_id && context.db
            ? getCompletionDigest(context.db, digest_id)
            : undefined;
          if (digest_id && (!requestedDigest || requestedDigest.worker_id !== id)) {
            return text(`Digest ${digest_id} does not belong to worker ${id}.`);
          }
          const rendered = renderWorkerStatus(
            requestedDigest ? { ...view, digest: requestedDigest } : view,
          );
          emit(
            "worker_status",
            `checked worker ${id.slice(0, 8)} [${view.worker.status}]`,
            rendered,
          );
          return text(rendered);
        },
      ),
      tool(
        "run_checks",
        "Run the project's configured checks (typecheck, lint, test, build — auto-detected from package.json scripts with the repository's selected package manager) and record the results as evidence keyed to the exact workspace state. Pass worker_id to run them in that worker's worktree — the ONLY way to verify a worker's claims; project-level runs say nothing about a diverged worktree. Omit keys to run everything configured.",
        {
          worker_id: z.string().optional(),
          keys: z
            .array(z.enum(["typecheck", "lint", "test", "build"]))
            .optional()
            .describe("Which checks to run; omitted = every configured one"),
        },
        async ({ worker_id, keys }) => {
          const bridge = requireEvidence();
          if (!bridge) {
            return text("Check running is not available in this context.");
          }
          let cwd = bridge.project.root_path;
          let workerId: string | null = null;
          if (worker_id) {
            const worker = getWorker(bridge.db, worker_id);
            if (!worker || worker.project_id !== bridge.project.id) {
              emit("run_checks", `no worker ${worker_id}`, "");
              return text(`No worker with id ${worker_id} in this project.`);
            }
            cwd = worker.worktree_path;
            workerId = worker.id;
          }
          try {
            const result = await runChecks({
              db: bridge.db,
              config: bridge.config,
              projectId: bridge.project.id,
              projectSlug: bridge.project.slug,
              cwd,
              workerId,
              ...(keys ? { keys } : {}),
            });
            const rendered = renderRunChecksResult(result);
            const failed = result.outcomes.filter((outcome) => outcome.status === "failed");
            emit(
              "run_checks",
              failed.length > 0
                ? `checks: ${failed.map((outcome) => outcome.key).join(", ")} FAILED`
                : `checks passed (${result.outcomes.length})`,
              rendered,
            );
            return text(rendered);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            emit("run_checks", "checks could not run", message);
            return text(`Checks could not run: ${message}`);
          }
        },
      ),
      tool(
        "list_attention",
        "List this project's OPEN attention items — the exception queue. Consult it before summarizing project state; an open item is a fact the user has not been shielded from yet.",
        {},
        async () => {
          const bridge = requireEvidence();
          if (!bridge) {
            return text("The attention queue is not available in this context.");
          }
          const items = listOpenAttentionItems(bridge.db, bridge.project.id);
          emit(
            "list_attention",
            `${items.length} open attention item${items.length === 1 ? "" : "s"}`,
            items.map((item) => `- [${item.priority}] ${item.kind}: ${item.title}`).join("\n") ||
              "(none)",
          );
          if (items.length === 0) {
            return text("The attention queue is empty — nothing needs anyone right now.");
          }
          return text(
            items
              .map((item) =>
                [
                  `${item.id} [${item.priority}] ${item.kind}: ${item.title}`,
                  item.worker_id ? `  worker: ${item.worker_id}` : "",
                  `  ${oneLine(item.detail, 300)}`,
                  `  raised: ${item.created_at}`,
                ]
                  .filter(Boolean)
                  .join("\n"),
              )
              .join("\n"),
          );
        },
      ),
      tool(
        "resolve_attention",
        "Close ONE attention item with the reason it no longer needs anyone: 'resolved' when the underlying fact was handled (evidence run, worker steered, answer relayed), 'dismissed' when it was noise. Never close an item you have not actually addressed — the queue is trust, not chores.",
        {
          id: z.string(),
          resolution: z.enum(["resolved", "dismissed"]),
          note: z.string().describe("What was done about it — recorded on the item"),
        },
        async ({ id, resolution, note }) => {
          const bridge = requireEvidence();
          if (!bridge) {
            return text("Attention resolution is not available in this context.");
          }
          const item = getAttentionItem(bridge.db, id);
          if (!item || item.project_id !== bridge.project.id) {
            emit("resolve_attention", `no item ${id}`, "");
            return text(`No attention item with id ${id} in this project.`);
          }
          if (item.status !== "open") {
            return text(`Attention item ${id} is already ${item.status}.`);
          }
          resolveAttentionItem(bridge.db, id, resolution, note);
          context.onAttentionResolved?.(id);
          emit("resolve_attention", `${resolution}: ${item.title}`, note);
          return text(`Attention item "${item.title}" is now ${resolution}.`);
        },
      ),
      tool(
        "review_completion",
        "Record your review verdict on a worker's latest completion digest: 'manager_reviewed' when claims, lane audit, and evidence hold together; 'escalated' when the user must see it (contradiction, failure, direction call). Verify with run_checks and worker_status BEFORE reviewing — a verdict without evidence is exactly what Galapagos exists to prevent.",
        {
          worker_id: z.string(),
          verdict: z.enum(["manager_reviewed", "escalated"]),
          note: z.string().describe("The one-line reason for the verdict"),
        },
        async ({ worker_id, verdict, note }) => {
          const bridge = requireEvidence();
          if (!bridge) {
            return text("Completion review is not available in this context.");
          }
          const worker = getWorker(bridge.db, worker_id);
          if (!worker || worker.project_id !== bridge.project.id) {
            return text(`No worker with id ${worker_id} in this project.`);
          }
          const digest = latestDigestForWorker(bridge.db, worker_id);
          if (!digest) {
            return text(
              `Worker ${worker_id} has no completion digest — there is nothing to review, and it is NOT done.`,
            );
          }
          if (verdict === "manager_reviewed") {
            // Code-level guard (adversarial review 2026-07-05, M10): a
            // persuasive narrative must not be able to talk a reviewer into
            // vouching without evidence. manager_reviewed demands fresh
            // passing required checks — the same bar auto-review holds.
            const evidence = await buildWorkerEvidence(bridge.db, {
              worker,
              lane: getLane(bridge.db, worker.lane_id) ?? null,
              staleWorkerSeconds: bridge.config.staleWorkerSeconds,
            });
            const gaps = evidence.input.checks.requiredKeys.filter((key) => {
              const run = evidence.input.checks.runs.find((entry) => entry.key === key);
              return !run || run.status === "failed" || !run.fresh;
            });
            if (gaps.length > 0) {
              emit("review_completion", `refused: required checks not fresh`, gaps.join(", "));
              return text(
                `Refused: required check${gaps.length === 1 ? "" : "s"} not freshly passing in the worker's worktree: ${gaps.join(", ")}. Run run_checks(worker_id) first — a verdict without evidence is exactly what Galapagos exists to prevent. (escalated verdicts need no evidence.)`,
              );
            }
          }
          setDigestStatus(bridge.db, digest.id, verdict);
          emit("review_completion", `${verdict}: ${oneLine(digest.narrative, 80)}`, note);
          return text(`Completion digest for worker ${worker_id} marked ${verdict}.`);
        },
      ),
    ],
  });
}
