import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { observeGitRepository, recentLog } from "../git/runner";
import {
  listAgreedSpecifics,
  writeAgreedSpecific,
} from "../vault/specifics";

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

export function createManagerToolServer(context: ManagerToolContext) {
  const emit = (toolName: string, summary: string, detail: string) => {
    context.onToolEvent?.({ tool: toolName, summary, detail });
  };

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
        "Record ONE agreed specific the user just confirmed (a pinned-down decision). Writes durable memory to the user's Obsidian vault. Use one call per distinct decision; never record vague statements.",
        { question: z.string(), answer: z.string() },
        async ({ question, answer }) => {
          const specific = writeAgreedSpecific({
            vaultPath: context.vaultPath,
            projectSlug: context.projectSlug,
            question,
            answer,
          });
          emit("record_specific", `recorded: ${specific.question}`, specific.body);
          return text(`Recorded agreed specific in the vault: ${specific.fileName}`);
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
        "Read durable project records (manager synthesis, goals, plans, briefs, decisions).",
        {},
        async () => {
          emit("read_records", "records store not built yet", "");
          return text(
            "The records store is not built yet — it arrives in Chunk 2 of Galapagos. Agreed specifics (list_specifics) are the only durable memory available right now. Do not invent records.",
          );
        },
      ),
    ],
  });
}
