import { query } from "@anthropic-ai/claude-agent-sdk";
import type { GalapagosConfig } from "../../config";
import type { GalapagosDb } from "../db/db";
import {
  appendTurn,
  getOrCreateActiveSession,
  latestSdkSessionId,
  markSessionResumed,
  updateTurnSdkSessionId,
} from "../db/repos/manager";
import type { ProjectRow } from "../db/repos/projects";
import { buildManagerDoctrine } from "../../daemon/doctrine";
import { createManagerToolServer } from "./manager-tools";

export type ManagerTurnEvent =
  | { type: "turn_started"; sessionId: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_use"; tool: string; summary: string; detail: string }
  | { type: "rebrief"; reason: string }
  | { type: "turn_complete"; resultText: string; sdkSessionId: string | null }
  | { type: "turn_error"; message: string };

export type EmitManagerTurnEvent = (event: ManagerTurnEvent) => void;

const MANAGER_ALLOWED_TOOLS = [
  "mcp__galapagos__git_truth",
  "mcp__galapagos__record_specific",
  "mcp__galapagos__list_specifics",
  "mcp__galapagos__read_records",
  "Read",
  "Glob",
  "Grep",
];

export async function runManagerTurn(input: {
  db: GalapagosDb;
  config: GalapagosConfig;
  project: ProjectRow;
  userText: string;
  emit: EmitManagerTurnEvent;
}): Promise<void> {
  const { db, config, project, userText, emit } = input;
  const session = getOrCreateActiveSession(db, project.id);
  const resumeId = latestSdkSessionId(db, session.id);
  emit({ type: "turn_started", sessionId: session.id });

  appendTurn(db, { sessionId: session.id, role: "user", content: userText });

  let sdkSessionId: string | null = null;
  let lastPersistedTurnId: string | null = null;

  const toolServer = createManagerToolServer({
    projectRoot: project.root_path,
    projectSlug: project.slug,
    vaultPath: config.vaultPath,
    onToolEvent: (event) => {
      const turn = appendTurn(db, {
        sessionId: session.id,
        role: "tool",
        content: JSON.stringify(event),
        sdkSessionIdAfter: sdkSessionId,
      });
      lastPersistedTurnId = turn.id;
      emit({ type: "tool_use", ...event });
    },
  });

  const runQuery = async (resume: string | null): Promise<void> => {
    const stream = query({
      prompt: userText,
      options: {
        ...(resume ? { resume } : {}),
        cwd: project.root_path,
        model: config.managerModel,
        systemPrompt: buildManagerDoctrine({
          projectName: project.name,
          projectRoot: project.root_path,
          projectSlug: project.slug,
        }),
        mcpServers: { galapagos: toolServer },
        allowedTools: MANAGER_ALLOWED_TOOLS,
        permissionMode: "dontAsk",
        maxTurns: 25,
      },
    });

    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        sdkSessionId = message.session_id;
        if (resume && message.session_id !== resume) {
          emit({
            type: "rebrief",
            reason:
              "The previous manager session could not be resumed — Darwin restarted from a fresh session. Recorded specifics are intact; recent conversational nuance may be lost.",
          });
        } else if (resume) {
          markSessionResumed(db, session.id);
        }
        continue;
      }

      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim().length > 0) {
            const turn = appendTurn(db, {
              sessionId: session.id,
              role: "assistant",
              content: block.text,
              sdkSessionIdAfter: sdkSessionId ?? message.session_id,
            });
            lastPersistedTurnId = turn.id;
            emit({ type: "assistant_text", text: block.text });
          }
        }
        continue;
      }

      if (message.type === "result") {
        sdkSessionId = message.session_id;
        if (lastPersistedTurnId) {
          updateTurnSdkSessionId(db, lastPersistedTurnId, message.session_id);
        }
        const resultText =
          message.subtype === "success" ? message.result : `Turn ended with ${message.subtype}.`;
        emit({ type: "turn_complete", resultText, sdkSessionId: message.session_id });
      }
    }
  };

  try {
    await runQuery(resumeId);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (resumeId) {
      emit({
        type: "rebrief",
        reason: `Resuming the previous session failed (${messageText}). Darwin restarted from a fresh session; recorded specifics are intact.`,
      });
      try {
        await runQuery(null);
        return;
      } catch (retryError) {
        const retryText = retryError instanceof Error ? retryError.message : String(retryError);
        emit({ type: "turn_error", message: retryText });
        return;
      }
    }
    emit({ type: "turn_error", message: messageText });
  }
}
