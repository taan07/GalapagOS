// The one way a judgment leg talks to a model: a fresh single-shot session —
// no tools, no MCP servers, no filesystem settings, bounded turns. A leg
// reads its assembled evidence and answers; it never explores, never edits,
// and can never be widened by a target repo's .claude settings.
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { GalapagosConfig } from "../../config";
import { baseQueryOptions } from "../agent/spawn";

export async function runSingleShotReview(input: {
  config: GalapagosConfig;
  cwd: string;
  model: string;
  systemPrompt: string;
  prompt: string;
}): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  try {
    const stream = query({
      prompt: input.prompt,
      options: {
        ...baseQueryOptions({ config: input.config, cwd: input.cwd }),
        model: input.model,
        systemPrompt: input.systemPrompt,
        allowedTools: [],
        settingSources: [],
        maxTurns: 4,
      },
    });
    let text: string | null = null;
    for await (const message of stream) {
      if (message.type === "result") {
        if (message.subtype === "success" && !message.is_error) {
          text = message.result;
        } else {
          return { ok: false, reason: `review session ended with ${message.subtype}` };
        }
      }
    }
    if (text === null) {
      return { ok: false, reason: "review session produced no result" };
    }
    return { ok: true, text };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
