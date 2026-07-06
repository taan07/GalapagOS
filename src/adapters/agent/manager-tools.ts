import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { GLP_TYPES, type GlpType } from "../../core/records/schema";
import type { Frontmatter } from "../../core/records/frontmatter";
import { oneLine } from "../../core/text";
import { laneGlobs } from "../db/repos/lanes";
import type { ProjectRow } from "../db/repos/projects";
import { describeOutcome, type DecisionOption, type DecisionOutcome } from "./decisions";
import { observeGitRepository, recentLog } from "../git/runner";
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
   * The chat decision channel (user-confirmed 2026-07-05): put a decision to
   * the user as clickable options and wait. Absent outside live manager
   * turns; tools that need approval degrade to an honest unavailable text.
   */
  askUser?: (
    question: string,
    options: DecisionOption[],
    multiSelect: boolean,
  ) => Promise<DecisionOutcome>;
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
      ? `completion digest (${digest.status}): ${digest.narrative}`
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
        "Continue a STOPPED (or failed) worker's task: a fresh session in the SAME worktree and branch, lane re-activated, briefed from the original worker_brief record plus the worktree's current git state and your continuation note. This is the ONLY way to continue stopped work — never reuse its lane name for a new spawn.",
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
            return text(
              decision.status === "timeout"
                ? "The user did not answer — the lane is UNCHANGED. Treat the amendment as deferred; do not retry without new cause."
                : "The turn was interrupted before the user answered — the lane is UNCHANGED.",
            );
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
        "ask_user",
        "Put a REAL decision to the user as clickable options in the chat, and wait for the answer. Use for decisions that change what gets built or how — never for things you can decide at your altitude, and never re-ask what records already answer. Word each option practically and give its implication in product terms; the user always gets a free-text field too. Your turn pauses until they answer (or a 10-minute timeout).",
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
        },
        async ({ question, options, multi_select }) => {
          if (!context.askUser) {
            return text("The decision channel is not available in this context — ask in plain chat text instead.");
          }
          const decision = await context.askUser(question, options ?? [], multi_select ?? false);
          emit(
            "ask_user",
            decision.status === "answered" ? "the user decided" : `question ${decision.status}`,
            `${question}\n↳ ${describeOutcome(decision)}`,
          );
          return text(describeOutcome(decision));
        },
      ),
      tool(
        "stop_worker",
        "Stop a worker: ends its session, audits every change in its worktree against the lane (out-of-lane files raise a high-priority lane_violation), retires the lane, and checks for a structured completion report. The worktree and branch survive for review.",
        { id: z.string() },
        async ({ id }) => {
          const bridge = requireWorkers();
          if (!bridge) {
            return text("Worker control is not available in this context.");
          }
          const outcome = await bridge.workers.stop(id, "Darwin");
          if (!outcome.ok) {
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
        "Full status of one worker: lane contract, liveness, completion digest (or its honest absence), open attention items, and the most recent events.",
        { id: z.string() },
        async ({ id }) => {
          const bridge = requireWorkers();
          if (!bridge) {
            return text("Worker control is not available in this context.");
          }
          const view = bridge.workers.status(id);
          if (!view) {
            emit("worker_status", `no worker ${id}`, "");
            return text(`No worker with id ${id}. Use list_workers to see what exists.`);
          }
          const rendered = renderWorkerStatus(view);
          emit(
            "worker_status",
            `checked worker ${id.slice(0, 8)} [${view.worker.status}]`,
            rendered,
          );
          return text(rendered);
        },
      ),
    ],
  });
}
