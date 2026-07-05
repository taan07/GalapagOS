import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { GLP_TYPES, type GlpType } from "../../core/records/schema";
import type { Frontmatter } from "../../core/records/frontmatter";
import { observeGitRepository, recentLog } from "../git/runner";
import { createRecordsStore, type RecordDoc } from "../records/store";
import { recordAgreedSpecific } from "../records/write-through";
import { listAgreedSpecifics } from "../vault/specifics";

export type ManagerToolContext = {
  projectRoot: string;
  projectSlug: string;
  vaultPath: string;
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

export function createManagerToolServer(context: ManagerToolContext) {
  const emit = (toolName: string, summary: string, detail: string) => {
    context.onToolEvent?.({ tool: toolName, summary, detail });
  };
  const store = createRecordsStore(context.projectRoot, context.projectSlug);

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
    ],
  });
}
