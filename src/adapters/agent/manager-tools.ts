import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { GLP_TYPES, type GlpType } from "../../core/records/schema";
import type { Frontmatter } from "../../core/records/frontmatter";
import type { ProjectRow } from "../db/repos/projects";
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

function renderWorkerStatus(view: WorkerStatusView): string {
  const { worker, lane, events, digest, attention } = view;
  const lines = [
    `worker ${worker.id} [${worker.status}] on lane "${lane?.name ?? "(lane missing)"}"`,
    `branch ${worker.branch} in ${worker.worktree_path} (base ${lane?.base_sha.slice(0, 8) ?? "?"})`,
    lane
      ? `lane globs — allowed: ${JSON.parse(lane.allowed_globs).join(", ")}; forbidden: ${JSON.parse(lane.forbidden_globs).join(", ") || "(none)"}`
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

  const recent = events.slice(-10);
  if (recent.length > 0) {
    lines.push(
      `recent events (${events.length} total, showing last ${recent.length}):`,
      ...recent.map((event) => {
        const payload = JSON.parse(event.payload) as Record<string, unknown>;
        const summary =
          typeof payload.text === "string"
            ? payload.text
            : typeof payload.tool === "string"
              ? `${payload.tool} ${JSON.stringify(payload.input ?? {})}`
              : typeof payload.message === "string"
                ? payload.message
                : typeof payload.subtype === "string"
                  ? payload.subtype
                  : JSON.stringify(payload);
        const oneLine = summary.replace(/\s+/g, " ").trim();
        return `  ${event.created_at.slice(11, 19)} ${event.kind}: ${oneLine.length > 160 ? `${oneLine.slice(0, 159)}…` : oneLine}`;
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
        "steer_worker",
        "Inject a message into a running worker mid-task: course corrections, answers to its questions, added context. The worker treats it as part of the same task.",
        { id: z.string(), message: z.string() },
        async ({ id, message }) => {
          const bridge = requireWorkers();
          if (!bridge) {
            return text("Worker control is not available in this context.");
          }
          const outcome = bridge.workers.steer(id, message);
          if (!outcome.ok) {
            emit("steer_worker", `steer failed for ${id}`, outcome.reason);
            return text(`Steer failed: ${outcome.reason}`);
          }
          emit("steer_worker", `steered worker ${id.slice(0, 8)}`, message);
          return text(`Message delivered to worker ${id}.`);
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
          const outcome = await bridge.workers.stop(id);
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
