import { query } from "@anthropic-ai/claude-agent-sdk";
import type { GalapagosConfig } from "../../config";
import { buildRebrief, type RebriefRecord } from "../../core/records/rebrief";
import { isClosedStatus } from "../../core/records/schema";
import type { GalapagosDb } from "../db/db";
import {
  appendTurn,
  compactSession,
  deleteTurns,
  getOrCreateActiveSession,
  latestSdkSessionId,
  listTurns,
  markSessionResumed,
  updateTurnSdkSessionId,
  type ManagerTurnRow,
} from "../db/repos/manager";
import type { ProjectRow } from "../db/repos/projects";
import { buildManagerDoctrine } from "../../daemon/doctrine";
import { createRecordsStore, type RecordDoc, type RecordsStore } from "../records/store";
import { createManagerToolServer } from "./manager-tools";
import { baseQueryOptions } from "./spawn";

export type ManagerTurnEvent =
  | { type: "turn_started"; sessionId: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_use"; tool: string; summary: string; detail: string }
  | {
      type: "rebrief";
      reason: string;
      /** The full seed text; null when the store had nothing to seed from. */
      preamble: string | null;
      /** Persisted turn id — the clear-re-brief action targets this. */
      turnId: string | null;
    }
  | { type: "turn_complete"; resultText: string; sdkSessionId: string | null }
  | { type: "interrupted"; message: string }
  | { type: "turn_error"; message: string };

/** Persisted payload of a system re-brief turn (manager_turns.content). */
export type RebriefTurnPayload = {
  kind: "rebrief";
  reason: string;
  preamble: string | null;
  clearedAt: string | null;
};

export type EmitManagerTurnEvent = (event: ManagerTurnEvent) => void;

export type ManagerTurnOutcome = {
  /** The (possibly compacted-and-replaced) manager session the turn ran in. */
  sessionId: string;
  /** Resume pointer after the turn; null when the turn never completed. */
  sdkSessionId: string | null;
  completed: boolean;
  /** True when the user force-stopped the turn (triple-Esc). */
  interrupted: boolean;
};

const MANAGER_ALLOWED_TOOLS = [
  "mcp__galapagos__git_truth",
  "mcp__galapagos__record_specific",
  "mcp__galapagos__list_specifics",
  "mcp__galapagos__read_records",
  "mcp__galapagos__write_record",
  "mcp__galapagos__update_record",
  "Read",
  "Glob",
  "Grep",
];

/** Thrown when a resumed query silently restarts blank (init id mismatch). */
class ResumeMismatchError extends Error {
  constructor(resume: string, got: string) {
    super(`Resume ${resume} came back as a different blank session (${got}).`);
  }
}

function toRebriefRecord(doc: RecordDoc): RebriefRecord {
  return {
    type: doc.type,
    title: doc.title,
    status: doc.status,
    createdAt: doc.createdAt,
    body: doc.body,
  };
}

/** Seed for a fresh session, per architecture §5. Null = store is empty. */
function rebriefPreamble(store: RecordsStore, projectName: string): string | null {
  const syntheses = store.list({ type: "manager_synthesis" });
  const synthesis =
    syntheses.filter((doc) => !isClosedStatus(doc.status)).at(-1) ?? syntheses.at(-1) ?? null;
  const goals = store.list({ type: "active_goal", status: "active" });
  const openQuestions = store
    .list({ type: "open_question" })
    .filter((doc) => !isClosedStatus(doc.status));
  const recentAnswers = store.list({ type: "user_answer", status: "agreed" }).slice(-10);
  return buildRebrief({
    projectName,
    synthesis: synthesis ? toRebriefRecord(synthesis) : null,
    goals: goals.map(toRebriefRecord),
    openQuestions: openQuestions.map(toRebriefRecord),
    recentAnswers: recentAnswers.map(toRebriefRecord),
  });
}

export async function runManagerTurn(input: {
  db: GalapagosDb;
  config: GalapagosConfig;
  project: ProjectRow;
  userText: string;
  emit: EmitManagerTurnEvent;
  /** Aborting this kills the in-flight SDK turn (triple-Esc interrupt). */
  abortController?: AbortController;
}): Promise<ManagerTurnOutcome> {
  const { db, config, project, userText, emit } = input;
  const store = createRecordsStore(project.root_path, project.slug);

  let session = getOrCreateActiveSession(db, project.id);
  let resumeId = latestSdkSessionId(db, session.id);
  // Only conversation counts as lost context. System turns (re-brief markers,
  // the "re-brief cleared" note) carry no SDK state — a deliberately blanked
  // session must start blank, not trigger another records-seeded re-brief.
  const hasHistory = listTurns(db, session.id).some((turn) => turn.role !== "system");
  emit({ type: "turn_started", sessionId: session.id });

  let userTurn: ManagerTurnRow = appendTurn(db, {
    sessionId: session.id,
    role: "user",
    content: userText,
  });

  let sdkSessionId: string | null = null;
  let lastPersistedTurnId: string | null = null;
  let attemptTurnIds: string[] = [];
  let resultWasError = false;
  let completed = false;

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
      attemptTurnIds.push(turn.id);
      emit({ type: "tool_use", ...event });
    },
  });

  /**
   * Retire the unresumable session, open a records-seeded one, and move the
   * pending user turn over so history never shows the message twice. Returns
   * the prompt for the fresh session.
   */
  const compactAndRebrief = (cause: string): string => {
    deleteTurns(db, [userTurn.id, ...attemptTurnIds]);
    attemptTurnIds = [];
    session = compactSession(db, project.id, session.id);

    const preamble = rebriefPreamble(store, project.name);
    const reason = preamble
      ? `${cause} Darwin re-briefed himself from the committed records (goals, open questions, agreed answers are intact); recent conversational nuance may be lost.`
      : `${cause} No durable records exist yet to re-brief from — Darwin restarted with a blank slate.`;
    // The re-brief is part of history: persisted before the user turn so the
    // UI can re-render (and clear) it after any reload.
    const payload: RebriefTurnPayload = { kind: "rebrief", reason, preamble, clearedAt: null };
    const rebriefTurn = appendTurn(db, {
      sessionId: session.id,
      role: "system",
      content: JSON.stringify(payload),
    });
    userTurn = appendTurn(db, { sessionId: session.id, role: "user", content: userText });

    emit({ type: "rebrief", reason, preamble, turnId: rebriefTurn.id });
    return preamble
      ? `${preamble}\n\n---\n\nWith that context restored, the user's message:\n\n${userText}`
      : userText;
  };

  const runQuery = async (resume: string | null, promptText: string): Promise<void> => {
    const stream = query({
      prompt: promptText,
      options: {
        ...baseQueryOptions({ config, cwd: project.root_path, resume }),
        ...(input.abortController ? { abortController: input.abortController } : {}),
        model: config.managerModel,
        systemPrompt: buildManagerDoctrine({
          projectName: project.name,
          projectRoot: project.root_path,
          projectSlug: project.slug,
        }),
        mcpServers: { galapagos: toolServer },
        allowedTools: MANAGER_ALLOWED_TOOLS,
        maxTurns: 25,
      },
    });

    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        sdkSessionId = message.session_id;
        if (resume && message.session_id !== resume) {
          // The CLI silently started a blank session instead of resuming.
          // Abort before any blank-context output reaches the user; the
          // caller compacts and reruns seeded from records.
          await stream.interrupt().catch(() => {});
          throw new ResumeMismatchError(resume, message.session_id);
        }
        if (resume) {
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
            attemptTurnIds.push(turn.id);
            emit({ type: "assistant_text", text: block.text });
          }
        }
        continue;
      }

      if (message.type === "result") {
        sdkSessionId = message.session_id;
        if (message.subtype !== "success" || message.is_error) {
          // The CLI ran but the turn failed (auth, model, etc.). The thrown
          // error after the stream ends carries the message; don't record the
          // failure text as if Darwin said it.
          resultWasError = true;
          deleteTurns(db, attemptTurnIds);
          attemptTurnIds = [];
          continue;
        }
        if (lastPersistedTurnId) {
          updateTurnSdkSessionId(db, lastPersistedTurnId, message.session_id);
        }
        completed = true;
        emit({ type: "turn_complete", resultText: message.result, sdkSessionId: message.session_id });
      }
    }
  };

  // A session with history but no resume pointer cannot be resumed at all —
  // compact up front instead of pretending the fresh session remembers.
  let prompt = userText;
  if (!resumeId && hasHistory) {
    prompt = compactAndRebrief("The previous session's resume pointer was lost.");
    resumeId = null;
  }

  const outcome = (): ManagerTurnOutcome => ({
    sessionId: session.id,
    sdkSessionId,
    completed,
    interrupted: input.abortController?.signal.aborted ?? false,
  });

  try {
    await runQuery(resumeId, prompt);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);

    if (input.abortController?.signal.aborted) {
      // Deliberate stop, not a failure: keep whatever streamed (it happened),
      // never retry or re-brief, and leave the session resumable from the
      // init pointer so the next turn continues with full context.
      const note = "Turn interrupted — Darwin stopped mid-turn at your request.";
      appendTurn(db, {
        sessionId: session.id,
        role: "system",
        content: JSON.stringify({ kind: "note", text: note }),
      });
      emit({ type: "interrupted", message: note });
      return outcome();
    }

    if (resultWasError) {
      // The session itself ran — retrying with a fresh session cannot help.
      const guidance = /not logged in/i.test(messageText)
        ? " The daemon cannot reach Claude Code's credentials. Start Galapagos from your own terminal (npm run dev) so the spawned Claude binary can use your keychain login, and check `claude /login` status."
        : "";
      emit({ type: "turn_error", message: `${messageText}${guidance}` });
      return outcome();
    }

    if (resumeId) {
      sdkSessionId = null;
      const retryPrompt = compactAndRebrief(`Resuming the previous session failed (${messageText}).`);
      try {
        await runQuery(null, retryPrompt);
        return outcome();
      } catch (retryError) {
        const retryText = retryError instanceof Error ? retryError.message : String(retryError);
        emit({ type: "turn_error", message: retryText });
        return outcome();
      }
    }
    emit({ type: "turn_error", message: messageText });
  }
  return outcome();
}
