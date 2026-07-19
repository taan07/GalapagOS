import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { GalapagosConfig } from "../../config";
import { userTurnPlainText, type ImageAttachment } from "../../core/attachments";
import { deniedToolsForMode, type AutonomyMode } from "../../core/autonomy";
import { contextFillFromModelUsage } from "../../core/context-fill";
import { oneLine } from "../../core/text";
import { buildRebrief, type RebriefRecord } from "../../core/records/rebrief";
import { isClosedStatus } from "../../core/records/schema";
import type { GalapagosDb } from "../db/db";
import {
  appendTurn,
  compactSession,
  deleteTurns,
  getOrCreateActiveSession,
  latestCompactedSessionId,
  latestSdkSessionId,
  listTurns,
  listUndistilledTurns,
  markSessionResumed,
  updateTurnContent,
  updateTurnSdkSessionId,
  type ManagerTurnRow,
} from "../db/repos/manager";
import type { ProjectRow } from "../db/repos/projects";
import { LIVE_WORKER_STATUSES } from "../db/repos/workers";
import { buildManagerDoctrine } from "../../daemon/doctrine";
import { createRecordsStore, type RecordDoc, type RecordsStore } from "../records/store";
import { createManagerToolServer } from "./manager-tools";
import type {
  DecisionBroker,
  DecisionField,
  DecisionKind,
  DecisionOption,
  DecisionOutcome,
} from "./decisions";
import {
  liveEventsFrom,
  statusKey,
  type AssistantDeltaEvent,
  type TurnStatusEvent,
} from "./live-status";
import { baseQueryOptions } from "./spawn";
import type { WorkerRuntime } from "./worker-runtime";

export type ManagerTurnEvent =
  | { type: "turn_started"; sessionId: string }
  | { type: "assistant_text"; text: string }
  /** Live status line while Darwin works — the tool_use chips' live shadow. */
  | TurnStatusEvent
  /** Token delta of Darwin's prose; the assistant_text that follows is the
   * settled truth (deltas are never persisted). */
  | AssistantDeltaEvent
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
  | {
      type: "decision_request";
      turnId: string;
      decisionId: string;
      /** Card presentation: single decision, batch of questions, or confirm. */
      cardKind: DecisionKind;
      question: string;
      options: DecisionOption[];
      multiSelect: boolean;
      /** The 2-4 questions of a batch card (empty for single / confirm). */
      fields: DecisionField[];
    }
  | {
      type: "decision_settled";
      decisionId: string;
      status: "answered" | "timeout" | "interrupted";
      selections: string[];
      responses: Record<string, string[]>;
      custom: string;
    }
  | {
      type: "turn_error";
      message: string;
      /** True when the turn died on a usage/rate limit — the turn is retryable
       * on a different model (the UI offers "change to Opus"). */
      limitReached: boolean;
      /** The manager model that failed, so the UI knows what it's switching from. */
      model: string;
    };

/** Persisted payload of a system decision turn (manager_turns.content). */
export type DecisionTurnPayload = {
  kind: "decision";
  /** Card presentation. Absent on turns persisted before 2026-07-08 → "decision". */
  cardKind?: DecisionKind;
  decisionId: string;
  question: string;
  options: DecisionOption[];
  multiSelect: boolean;
  /** Batch questions (absent/empty on single decisions and confirms). */
  fields?: DecisionField[];
  status: "pending" | "answered" | "timeout" | "interrupted" | "expired";
  selections: string[];
  /** Per-field selected labels for a batch. */
  responses?: Record<string, string[]>;
  custom: string;
};

/** Persisted payload of a system re-brief turn (manager_turns.content). */
export type RebriefTurnPayload = {
  kind: "rebrief";
  reason: string;
  preamble: string | null;
  clearedAt: string | null;
};

/** Truthful wrapper shared by every compaction/re-brief path. */
export function rebriefPrompt(
  preamble: string,
  prompt: string,
  origin: "user" | "daemon" = "user",
): string {
  const label = origin === "daemon" ? "the autonomous system input" : "the user's message";
  return `${preamble}\n\n---\n\nWith that context restored, ${label}:\n\n${prompt}`;
}

export type EmitManagerTurnEvent = (event: ManagerTurnEvent) => void;

export type ManagerTurnOutcome = {
  /** The (possibly compacted-and-replaced) manager session the turn ran in. */
  sessionId: string;
  /** Resume pointer after the turn; null when the turn never completed. */
  sdkSessionId: string | null;
  completed: boolean;
  /** True when the user force-stopped the turn (triple-Esc). */
  interrupted: boolean;
  /**
   * How full the context window ran this turn (0..1+, worst model), straight
   * from the SDK result's usage block. Null when the turn never completed or
   * usage wasn't reported — unknown pressure is NO pressure, never a trigger.
   */
  contextFill: number | null;
};

const MANAGER_ALLOWED_TOOLS = [
  "mcp__galapagos__git_truth",
  "mcp__galapagos__record_specific",
  "mcp__galapagos__list_specifics",
  "mcp__galapagos__read_records",
  "mcp__galapagos__write_record",
  "mcp__galapagos__update_record",
  "mcp__galapagos__spawn_worker",
  "mcp__galapagos__resume_worker",
  "mcp__galapagos__steer_worker",
  "mcp__galapagos__hold_worker",
  "mcp__galapagos__stop_worker",
  "mcp__galapagos__amend_lane",
  "mcp__galapagos__merge_worker",
  "mcp__galapagos__list_workers",
  "mcp__galapagos__worker_status",
  "mcp__galapagos__run_checks",
  "mcp__galapagos__list_attention",
  "mcp__galapagos__resolve_attention",
  "mcp__galapagos__review_completion",
  "mcp__galapagos__ask_user",
  "mcp__galapagos__ask_batch",
  "mcp__galapagos__confirm_understanding",
  "Read",
  "Glob",
  "Grep",
];

/**
 * A usage or rate limit — Fable's subscription cap, an API 429, or an
 * overload. The turn itself is fine; retrying on a different model can get
 * through, so the UI surfaces a "change to Opus" action instead of a dead
 * error note. Kept permissive: the upstream wording varies by limit type.
 *
 * The observed subscription-cap string is the anchor case:
 *   "You've reached your Fable 5 limit. Run /usage-credits to continue or
 *    switch models with /model."
 * — note it's "reached your … limit", not "usage/limit reached", and the
 * actionable tells (/usage-credits, "switch models") are the reliable signals.
 */
export function isUsageLimitError(text: string): boolean {
  return /usage limit|rate limit|limit reached|reached your .*\blimit\b|usage-credits|switch models|resource[_ ]exhausted|too many requests|\b429\b|quota|overloaded/i.test(
    text,
  );
}

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

/**
 * The built-in "how to work with me" baseline, used until a real
 * style_contract record exists. Distilled from the user's signed product
 * principles — a compaction must never reset how Darwin behaves, even on a
 * project whose record store hasn't captured preferences yet.
 */
const BASELINE_STYLE_CONTRACT: RebriefRecord = {
  type: "style_contract",
  title: "Working baseline (built-in until a style_contract record exists)",
  status: "active",
  createdAt: "2026-07-13",
  body: [
    "- Answer first, details fold: lead every reply with a one-line,",
    "  self-contained outcome; put the walkthrough below it.",
    "- Ambiguity ALWAYS interrupts — ask instead of guessing, however",
    "  autonomous the current run feels.",
    "- Anything touching main, and every direction-level call (architecture,",
    "  scope, dependencies), needs the user's explicit yes.",
    "- Narrate worker events conversationally; you are the translation layer —",
    "  every steer to a worker passes through your judgment, never a raw pipe.",
  ].join("\n"),
};

/**
 * The newest UNCLEARED re-brief marker on a session — evidence its brief was
 * already composed. A failed first attempt on a seeded session leaves this
 * marker (plus its unanswered user turn) behind; the next turn must reuse the
 * marker's preamble instead of compacting again. Exported for the db-level
 * tests that pin exactly that sequence.
 */
export function findUnclearedRebriefMarker(
  db: GalapagosDb,
  sessionId: string,
): RebriefTurnPayload | null {
  const markers = listTurns(db, sessionId)
    .filter((turn) => turn.role === "system")
    .map((turn) => {
      try {
        return JSON.parse(turn.content) as RebriefTurnPayload;
      } catch {
        return null;
      }
    })
    .filter(
      (payload): payload is RebriefTurnPayload =>
        payload !== null && payload.kind === "rebrief" && payload.clearedAt === null,
    );
  return markers.at(-1) ?? null;
}

/**
 * What the preamble composer may know beyond the record store. Optional and
 * degradable: a caller without a live runtime still gets a records-only brief.
 */
type RebriefContext = {
  db?: GalapagosDb;
  projectId?: string;
  /** The just-compacted session whose undistilled tail is the thread state. */
  previousSessionId?: string | null;
  workers?: WorkerRuntime;
};

/** Seed for a fresh session, per architecture §5. Null = store is empty. */
function rebriefPreamble(
  store: RecordsStore,
  projectName: string,
  context: RebriefContext = {},
): string | null {
  const syntheses = store.list({ type: "manager_synthesis" });
  const synthesis =
    syntheses.filter((doc) => !isClosedStatus(doc.status)).at(-1) ?? syntheses.at(-1) ?? null;
  const goals = store.list({ type: "active_goal", status: "active" });
  const openQuestions = store
    .list({ type: "open_question" })
    .filter((doc) => !isClosedStatus(doc.status));
  const recentAnswers = store.list({ type: "user_answer", status: "agreed" }).slice(-10);
  const storedContracts = store
    .list({ type: "style_contract" })
    .filter((doc) => !isClosedStatus(doc.status));
  const styleContracts =
    storedContracts.length > 0 ? storedContracts.map(toRebriefRecord) : [BASELINE_STYLE_CONTRACT];

  // 7b — where the thread stood: the compacted session's undistilled tail,
  // one line per turn, newest last, bounded so the preamble stays a brief.
  const threadState: string[] = [];
  if (context.db && context.previousSessionId) {
    for (const turn of listUndistilledTurns(context.db, context.previousSessionId).slice(-10)) {
      threadState.push(
        `${turn.role === "user" ? "User" : "Darwin"}: ${oneLine(
          // User turns may be attachment payloads — the tail wants the words
          // plus attachment names, never the raw JSON envelope.
          turn.role === "user" ? userTurnPlainText(turn.content) : turn.content,
          200,
        )}`,
      );
    }
  }

  // 7c — the live fleet at compose time. Sessions survive compaction (and
  // daemon restarts); the new context must know who is out there working.
  // Liveness is the canonical constant, not a re-derived exclusion — a future
  // terminal status must never read as "running THIS INSTANT" here.
  const fleet: string[] = [];
  if (context.workers && context.projectId) {
    for (const { worker, lane } of context.workers.list(context.projectId)) {
      if (!LIVE_WORKER_STATUSES.includes(worker.status)) {
        continue;
      }
      fleet.push(
        `${worker.id.slice(0, 8)} [${worker.status}] lane "${lane?.name ?? "(none)"}"${worker.last_summary ? ` — ${oneLine(worker.last_summary, 120)}` : ""}`,
      );
    }
  }

  return buildRebrief({
    projectName,
    synthesis: synthesis ? toRebriefRecord(synthesis) : null,
    goals: goals.map(toRebriefRecord),
    openQuestions: openQuestions.map(toRebriefRecord),
    recentAnswers: recentAnswers.map(toRebriefRecord),
    styleContracts,
    threadState,
    fleet,
  });
}

/**
 * The prompt as one streamed user message carrying image blocks ahead of the
 * text — the SDK's only channel for image input. Exported for tests.
 */
export function imageBearingPrompt(
  promptText: string,
  images: ImageAttachment[],
): AsyncIterable<SDKUserMessage> {
  const content = [
    ...images.map((image) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
    })),
    ...(promptText.trim().length > 0 ? [{ type: "text" as const, text: promptText }] : []),
  ];
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "user" as const,
        message: { role: "user" as const, content },
        parent_tool_use_id: null,
      };
    },
  };
}

export async function runManagerTurn(input: {
  db: GalapagosDb;
  config: GalapagosConfig;
  project: ProjectRow;
  userText: string;
  emit: EmitManagerTurnEvent;
  /** Aborting this kills the in-flight SDK turn (triple-Esc interrupt). */
  abortController?: AbortController;
  /** The daemon's live worker runtime; absent in contexts without workers. */
  workers?: WorkerRuntime;
  /** The daemon's decision broker — chat accept/deny and questionnaires. */
  decisions?: DecisionBroker;
  /**
   * A user turn or daemon audit input the caller already persisted (before any distill-preempt
   * wait, so a page reload or handler death cannot lose the message).
   * Adopted instead of appending a duplicate.
   */
  persistedUserTurn?: ManagerTurnRow;
  /** The project's autonomy stop for THIS turn; omitted = the middle stop. */
  mode?: AutonomyMode;
  /** Fired when update_record signs an implementation_plan (Interview exit).
   * Returns whether the mode actually flipped — the tool words its reply on it. */
  onPlanApproved?: () => boolean;
  /**
   * This turn's attachments (track I). Images ride the SDK message as base64
   * content blocks; pasted-text files are already on disk — `promptNote`
   * points Darwin at their paths. The persisted turn (persistedUserTurn)
   * already carries the durable payload; these are the prompt-side halves.
   */
  attachments?: {
    images: ImageAttachment[];
    promptNote: string | null;
  };
}): Promise<ManagerTurnOutcome> {
  const { db, config, project, userText, emit } = input;
  // What the model sees vs. what history stores: the prompt text carries the
  // pasted-file pointer note; the DB keeps the user's raw text + payload.
  const promptNote = input.attachments?.promptNote ?? null;
  const promptUserText = promptNote
    ? userText
      ? `${userText}\n\n${promptNote}`
      : promptNote
    : userText;
  const turnImages = input.attachments?.images ?? [];
  const store = createRecordsStore(project.root_path, project.slug);
  const mode: AutonomyMode = input.mode ?? "default";
  // Structural mode gating: Interview/Plan removes the start-new-work tools
  // outright — doctrine is the soft gate, the allowlist is the hard one.
  const deniedForMode = deniedToolsForMode(mode);
  const allowedTools =
    deniedForMode.length === 0
      ? MANAGER_ALLOWED_TOOLS
      : MANAGER_ALLOWED_TOOLS.filter((toolName) => !deniedForMode.includes(toolName));

  let session = getOrCreateActiveSession(db, project.id);
  let resumeId = latestSdkSessionId(db, session.id);
  // Only conversation counts as lost context. System turns (re-brief markers,
  // the "re-brief cleared" note) carry no SDK state — a deliberately blanked
  // session must start blank, not trigger another records-seeded re-brief.
  // The pre-persisted user turn is THIS turn's message, not history — counting
  // it would make a virgin project's first message look like a lost session.
  const hasHistory = listTurns(db, session.id).some(
    (turn) => turn.role !== "system" && turn.id !== input.persistedUserTurn?.id,
  );
  emit({ type: "turn_started", sessionId: session.id });

  let userTurn: ManagerTurnRow =
    input.persistedUserTurn ??
    appendTurn(db, {
      sessionId: session.id,
      role: "user",
      content: userText,
    });
  const persistedOrigin = input.persistedUserTurn?.input_origin ?? "user";

  let sdkSessionId: string | null = null;
  let lastPersistedTurnId: string | null = null;
  let attemptTurnIds: string[] = [];
  let resultWasError = false;
  let completed = false;
  let contextFill: number | null = null;

  /**
   * The chat decision channel: persist the question as a system turn (so it
   * survives reloads), stream it as clickable options, wait for the user via
   * the broker, stamp the settled state back into the turn. Darwin's turn
   * holds while the user decides; timeout and interrupt resolve honestly.
   */
  // Shared machinery for every chat card — single decision, batch of
  // questions, or understanding playback: persist a system turn (survives
  // reloads), stream the request as clickable options, wait on the broker,
  // stamp the settled state back. The free-text answer arrives via the chat
  // composer (2026-07-08 ruling), never an embedded field.
  const putDecision = input.decisions
    ? async (spec: {
        cardKind: DecisionKind;
        question: string;
        options: DecisionOption[];
        multiSelect: boolean;
        fields: DecisionField[];
      }): Promise<DecisionOutcome> => {
        const broker = input.decisions as DecisionBroker;
        const { request, outcome } = broker.ask({
          kind: spec.cardKind,
          question: spec.question,
          options: spec.options,
          multiSelect: spec.multiSelect,
          fields: spec.fields,
          ...(input.abortController ? { signal: input.abortController.signal } : {}),
        });
        const payload: DecisionTurnPayload = {
          kind: "decision",
          cardKind: spec.cardKind,
          decisionId: request.id,
          question: spec.question,
          options: spec.options,
          multiSelect: spec.multiSelect,
          fields: spec.fields,
          status: "pending",
          selections: [],
          responses: {},
          custom: "",
        };
        const turn = appendTurn(db, {
          sessionId: session.id,
          role: "system",
          content: JSON.stringify(payload),
        });
        emit({
          type: "decision_request",
          turnId: turn.id,
          decisionId: request.id,
          cardKind: spec.cardKind,
          question: spec.question,
          options: spec.options,
          multiSelect: spec.multiSelect,
          fields: spec.fields,
        });
        const settled: DecisionOutcome = await outcome;
        const answered = settled.status === "answered" ? settled.answer : null;
        const settledPayload: DecisionTurnPayload = {
          ...payload,
          status: settled.status,
          selections: answered?.selections ?? [],
          responses: answered?.responses ?? {},
          custom: answered?.custom ?? "",
        };
        updateTurnContent(db, turn.id, JSON.stringify(settledPayload));
        emit({
          type: "decision_settled",
          decisionId: request.id,
          status: settled.status,
          selections: settledPayload.selections,
          responses: settledPayload.responses ?? {},
          custom: settledPayload.custom,
        });
        return settled;
      }
    : undefined;

  const askUser = putDecision
    ? (question: string, options: DecisionOption[], multiSelect: boolean) =>
        putDecision({ cardKind: "decision", question, options, multiSelect, fields: [] })
    : undefined;

  const askBatch = putDecision
    ? (fields: DecisionField[]) =>
        putDecision({ cardKind: "batch", question: "", options: [], multiSelect: false, fields })
    : undefined;

  const askConfirm = putDecision
    ? (playback: string) =>
        putDecision({
          cardKind: "confirm",
          question: playback,
          options: [
            {
              label: "Confirmed",
              implication: "Your understanding is right — Darwin proceeds on it.",
            },
            {
              label: "Needs correction",
              implication: "Something's off — type the fix in chat and Darwin adjusts.",
            },
          ],
          multiSelect: false,
          fields: [],
        })
    : undefined;

  const toolServer = createManagerToolServer({
    projectRoot: project.root_path,
    projectSlug: project.slug,
    vaultPath: config.vaultPath,
    // Evidence + attention surface (chunk 4): Darwin runs checks, reads and
    // resolves the queue, and records completion verdicts.
    db,
    config,
    project,
    ...(input.workers ? { workers: input.workers } : {}),
    // The chat decision channel (chunk 3 drills): clickable options, waits.
    // 2026-07-08: also a batch card and an understanding-playback confirm.
    ...(askUser ? { askUser } : {}),
    ...(askBatch ? { askBatch } : {}),
    ...(askConfirm ? { askConfirm } : {}),
    ...(input.onPlanApproved ? { onPlanApproved: input.onPlanApproved } : {}),
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
    const previousSessionId = session.id;
    session = compactSession(db, project.id, session.id);

    const preamble = rebriefPreamble(store, project.name, {
      db,
      projectId: project.id,
      previousSessionId,
      ...(input.workers ? { workers: input.workers } : {}),
    });
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
    // Re-append what was persisted, not the bare text — an attachment-bearing
    // turn's payload (paths and all) must survive the compaction move.
    userTurn = appendTurn(db, {
      sessionId: session.id,
      role: input.persistedUserTurn?.role ?? "user",
      content: input.persistedUserTurn?.content ?? userText,
      inputOrigin: input.persistedUserTurn?.input_origin,
      inputKind: input.persistedUserTurn?.input_kind,
    });

    emit({ type: "rebrief", reason, preamble, turnId: rebriefTurn.id });
    return preamble
      ? rebriefPrompt(preamble, promptUserText, persistedOrigin)
      : promptUserText;
  };

  const runQuery = async (resume: string | null, promptText: string): Promise<void> => {
    const stream = query({
      // A plain string until images ride along — then the same prompt becomes
      // one streamed user message whose content is [image blocks..., text],
      // the only shape the SDK accepts image input through.
      prompt: turnImages.length === 0 ? promptText : imageBearingPrompt(promptText, turnImages),
      options: {
        ...baseQueryOptions({ config, cwd: project.root_path, resume }),
        ...(input.abortController ? { abortController: input.abortController } : {}),
        model: config.managerModel,
        systemPrompt: buildManagerDoctrine({
          projectName: project.name,
          projectRoot: project.root_path,
          projectSlug: project.slug,
          mode,
        }),
        mcpServers: { galapagos: toolServer },
        allowedTools,
        maxTurns: 25,
        // Live turn: raw stream events ride along so the UI can show what
        // Darwin is doing and stream his prose token by token.
        includePartialMessages: true,
      },
    });

    // Dedupe the status line (a thinking block after message_start would
    // otherwise emit "Thinking" twice in a row).
    let lastStatus: string | null = null;

    for await (const message of stream) {
      if (message.type === "stream_event") {
        // Subagent streams (parent_tool_use_id set) are not Darwin's prose.
        if (message.parent_tool_use_id !== null) {
          continue;
        }
        for (const live of liveEventsFrom(message.event)) {
          if (live.type === "turn_status") {
            const key = statusKey(live);
            if (key === lastStatus) {
              continue;
            }
            lastStatus = key;
          }
          emit(live);
        }
        continue;
      }

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
        // Free context-pressure reading off the result's usage block — the
        // daemon compacts at the next completed distill boundary when this
        // crosses the configured threshold.
        contextFill = contextFillFromModelUsage(message.modelUsage);
        emit({ type: "turn_complete", resultText: message.result, sdkSessionId: message.session_id });
      }
    }
  };

  // Pre-flight, in precedence order:
  // 1. A records-seeded session with an UNCLEARED re-brief marker: the brief
  //    was already composed — a failed first attempt leaves its (unanswered)
  //    user turn behind, so this check must come BEFORE the hasHistory
  //    compaction or a transient failure would double-compact, stamp a second
  //    chip, and misreport "resume pointer lost" for a deliberate compaction.
  // 2. History but no resume pointer: genuinely unresumable — compact.
  // 3. A virgin records-seeded session: compose the brief NOW — records,
  //    style contract, thread tail, live fleet, all at use-time freshness.
  //    (A deliberately blanked session — re-brief cleared — has
  //    seeded_from_records_at null and starts blank.)
  let prompt = promptUserText;
  if (!resumeId) {
    const marker = session.seeded_from_records_at
      ? findUnclearedRebriefMarker(db, session.id)
      : null;
    if (marker) {
      if (marker.preamble) {
        prompt = rebriefPrompt(marker.preamble, promptUserText, persistedOrigin);
      }
    } else if (hasHistory) {
      prompt = compactAndRebrief("The previous session's resume pointer was lost.");
      resumeId = null;
    } else if (session.seeded_from_records_at) {
      const preamble = rebriefPreamble(store, project.name, {
        db,
        projectId: project.id,
        previousSessionId: latestCompactedSessionId(db, project.id),
        ...(input.workers ? { workers: input.workers } : {}),
      });
      const reason = preamble
        ? "Context was compacted at a clean distillation boundary — Darwin re-briefed himself from the committed records; the distilled memory is intact."
        : "Context was compacted, and no durable records exist yet to re-brief from — Darwin starts fresh.";
      const payload: RebriefTurnPayload = { kind: "rebrief", reason, preamble, clearedAt: null };
      const rebriefTurn = appendTurn(db, {
        sessionId: session.id,
        role: "system",
        content: JSON.stringify(payload),
      });
      emit({ type: "rebrief", reason, preamble, turnId: rebriefTurn.id });
      if (preamble) {
        prompt = rebriefPrompt(preamble, promptUserText, persistedOrigin);
      }
    }
  }

  const outcome = (): ManagerTurnOutcome => ({
    sessionId: session.id,
    sdkSessionId,
    completed,
    interrupted: input.abortController?.signal.aborted ?? false,
    contextFill,
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
      emit({
        type: "turn_error",
        message: `${messageText}${guidance}`,
        limitReached: isUsageLimitError(messageText),
        model: config.managerModel,
      });
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
        emit({
          type: "turn_error",
          message: retryText,
          limitReached: isUsageLimitError(retryText),
          model: config.managerModel,
        });
        return outcome();
      }
    }
    emit({
      type: "turn_error",
      message: messageText,
      limitReached: isUsageLimitError(messageText),
      model: config.managerModel,
    });
  }
  return outcome();
}
