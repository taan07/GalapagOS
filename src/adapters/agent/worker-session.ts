// The worker harness abstraction (architecture §6): this is the ONLY module
// that knows which harness runs a worker. Interface: spawn → session with a
// normalized event stream, inject a message mid-run, stop. The one backend in
// Chunks 1–6 is the Claude Agent SDK via streaming-input query(); a future
// Omnigent adapter would replace only this file.
import path from "node:path";
import { query, type CanUseTool, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { GalapagosConfig } from "../../config";
import { checkLane, type LaneContract } from "../../core/lanes/lane-check";
import { baseQueryOptions } from "./spawn";

/** Harness-agnostic stream events — what the daemon persists and broadcasts. */
export type WorkerStreamEvent =
  | { kind: "session_started"; sdkSessionId: string }
  | { kind: "assistant"; payload: { text: string } }
  | { kind: "tool_use"; payload: { tool: string; input: unknown } }
  | { kind: "tool_result"; payload: { content: string; isError: boolean } }
  | {
      kind: "result";
      payload: { subtype: string; isError: boolean; resultText: string | null };
    }
  | { kind: "error"; payload: { message: string } };

export type WorkerSession = {
  events: AsyncIterable<WorkerStreamEvent>;
  /** Inject a steering message mid-run (streaming input). */
  send(text: string): void;
  /** End the input stream and abort any in-flight turn. */
  stop(): Promise<void>;
};

export type SpawnWorkerSessionInput = {
  config: GalapagosConfig;
  worktreePath: string;
  systemPrompt: string;
  /** The worker brief — the first user message of the session. */
  briefText: string;
  model: string;
  lane: LaneContract;
};

export type WorkerSessionFactory = (input: SpawnWorkerSessionInput) => WorkerSession;

// Auto-approved tools. Edit/Write/NotebookEdit are deliberately NOT listed:
// an allow rule would skip canUseTool entirely, and the preventive lane
// guard lives there. Bash IS listed — the known bypass (architecture §11.3);
// the detective lane-check at stop is the authority.
const WORKER_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Bash", "TodoWrite"];

// Generous but bounded: workers do real multi-step implementation work, and
// a runaway session must still terminate on its own.
const WORKER_MAX_TURNS = 100;

/** Tool-name → which input field carries the target file path. */
const FILE_WRITE_TOOLS: Record<string, string> = {
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/**
 * The preventive lane layer (architecture §7, layer 1): deny file-writing
 * tools outside the lane with an explanation the worker can act on. Pure
 * decision logic — exported for direct testing without an SDK session.
 */
export function workerCanUseTool(lane: LaneContract, worktreePath: string): CanUseTool {
  const worktreeRoot = path.resolve(worktreePath);
  return async (toolName, input) => {
    const pathField = FILE_WRITE_TOOLS[toolName];
    if (!pathField) {
      // Not a file-writing tool. It reached the callback only because it is
      // not pre-approved; the lane contract has nothing to say about it.
      return { behavior: "allow", updatedInput: input };
    }

    const rawPath = input[pathField];
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      return {
        behavior: "deny",
        message: `${toolName} was called without a usable ${pathField} — retry with an explicit path.`,
      };
    }

    const absolute = path.resolve(worktreeRoot, rawPath);
    if (absolute !== worktreeRoot && !absolute.startsWith(`${worktreeRoot}${path.sep}`)) {
      return {
        behavior: "deny",
        message: `Denied: ${rawPath} is outside your worktree (${worktreeRoot}). You work only inside your own worktree.`,
      };
    }

    const relative = path.relative(worktreeRoot, absolute).split(path.sep).join("/");
    const violations = checkLane([relative], lane);
    const violation = violations[0];
    if (violation) {
      const why =
        violation.reason === "forbidden"
          ? `matches the forbidden glob ${violation.glob}`
          : `matches none of your lane's allowed globs (${lane.allowedGlobs.join(", ")})`;
      return {
        behavior: "deny",
        message: `Denied: ${relative} is outside your lane — it ${why}. If the task truly requires this file, say so and stop; the manager will re-scope your lane.`,
      };
    }

    return { behavior: "allow", updatedInput: input };
  };
}

export type MessageQueue = {
  stream: AsyncIterable<SDKUserMessage>;
  push(text: string): void;
  end(): void;
};

/**
 * A push-based AsyncIterable of user messages: the streaming-input channel a
 * worker session reads from. push() feeds steering messages mid-run; end()
 * closes the channel, which lets the SDK session finish and exit.
 */
export function createMessageQueue(firstText: string): MessageQueue {
  const pending: string[] = [firstText];
  let ended = false;
  let wake: (() => void) | null = null;

  const notify = () => {
    wake?.();
    wake = null;
  };

  return {
    push(text: string) {
      if (ended) {
        throw new Error("Cannot send to a stopped worker session.");
      }
      pending.push(text);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    stream: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = pending.shift();
          if (next !== undefined) {
            yield {
              type: "user" as const,
              message: { role: "user" as const, content: next },
              parent_tool_use_id: null,
            };
            continue;
          }
          if (ended) {
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
  };
}

/** Flatten a tool_result content payload (string or block list) to text. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const item = block as { type?: string; text?: string };
        return item.type === "text" && typeof item.text === "string"
          ? item.text
          : JSON.stringify(block);
      })
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

/**
 * Spawn one worker session: streaming-input query() with cwd pinned to the
 * worktree, spawned via the shared helper (keychain-bound auth), lane guard
 * on canUseTool, settings isolation so a target repo's .claude/settings.json
 * allow rules cannot silently pre-approve Edit/Write past the lane guard.
 */
export function spawnWorkerSession(input: SpawnWorkerSessionInput): WorkerSession {
  const queue = createMessageQueue(input.briefText);

  const stream = query({
    prompt: queue.stream,
    options: {
      ...baseQueryOptions({
        config: input.config,
        cwd: input.worktreePath,
        permissionMode: "default",
      }),
      model: input.model,
      systemPrompt: input.systemPrompt,
      allowedTools: WORKER_ALLOWED_TOOLS,
      canUseTool: workerCanUseTool(input.lane, input.worktreePath),
      settingSources: [],
      maxTurns: WORKER_MAX_TURNS,
    },
  });

  const events: AsyncIterable<WorkerStreamEvent> = {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const message of stream) {
          if (message.type === "system" && message.subtype === "init") {
            yield { kind: "session_started", sdkSessionId: message.session_id };
            continue;
          }
          if (message.type === "assistant") {
            for (const block of message.message.content) {
              if (block.type === "text" && block.text.trim().length > 0) {
                yield { kind: "assistant", payload: { text: block.text } };
              } else if (block.type === "tool_use") {
                yield {
                  kind: "tool_use",
                  payload: { tool: block.name, input: block.input },
                };
              }
            }
            continue;
          }
          if (message.type === "user") {
            const content = message.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "tool_result") {
                  yield {
                    kind: "tool_result",
                    payload: {
                      content: toolResultText(block.content),
                      isError: block.is_error === true,
                    },
                  };
                }
              }
            }
            continue;
          }
          if (message.type === "result") {
            yield {
              kind: "result",
              payload: {
                subtype: message.subtype,
                isError: message.is_error,
                resultText: message.subtype === "success" ? message.result : null,
              },
            };
          }
        }
      } catch (error) {
        yield {
          kind: "error",
          payload: { message: error instanceof Error ? error.message : String(error) },
        };
      }
    },
  };

  return {
    events,
    send(text: string) {
      queue.push(text);
    },
    async stop() {
      queue.end();
      // Abort any in-flight turn; a session idle between turns has nothing
      // to interrupt and the call may reject — that is fine.
      await stream.interrupt().catch(() => {});
    },
  };
}
