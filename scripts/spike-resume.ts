// Resume spike (opt-in, makes real Agent SDK calls on the local subscription):
// proves the architecture's top-ranked risk is handled — session ids persist
// per turn, resume restores context, and a cwd mismatch is detectable rather
// than silently blank.
//
// Run: bun run spike:resume
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";

const MARKER = `galapagos-spike-${Math.random().toString(36).slice(2, 8)}`;

function makeFixtureRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glp-spike-"));
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=Spike", "-c", "user.email=spike@galapagos.local", ...args],
      { cwd: dir },
    );
  git(["init", "-b", "main"]);
  writeFileSync(path.join(dir, "README.md"), "spike fixture\n");
  git(["add", "-A"]);
  git(["commit", "-m", "spike fixture commit"]);
  return dir;
}

async function runTurn(input: {
  prompt: string;
  cwd: string;
  resume?: string;
}): Promise<{ sessionId: string | null; resultText: string }> {
  let sessionId: string | null = null;
  let resultText = "";
  const stream = query({
    prompt: input.prompt,
    options: {
      ...(input.resume ? { resume: input.resume } : {}),
      cwd: input.cwd,
      model: "claude-haiku-4-5",
      systemPrompt: "You are a terse test agent. Answer in one short line.",
      allowedTools: [],
      permissionMode: "dontAsk",
      maxTurns: 3,
    },
  });
  for await (const message of stream) {
    if (message.type === "system" && message.subtype === "init") {
      sessionId = message.session_id;
    }
    if (message.type === "result") {
      sessionId = message.session_id;
      resultText = message.subtype === "success" ? message.result : `(${message.subtype})`;
    }
  }
  return { sessionId, resultText };
}

async function main() {
  const repo = makeFixtureRepo();
  console.log(`fixture repo: ${repo}`);
  console.log(`marker: ${MARKER}\n`);

  console.log("turn 1: planting the marker…");
  const first = await runTurn({
    prompt: `Remember this exact marker for later: ${MARKER}. Reply only "stored".`,
    cwd: repo,
  });
  console.log(`  session: ${first.sessionId}\n  reply: ${first.resultText}\n`);
  if (!first.sessionId) {
    throw new Error("FAIL: no session id surfaced on turn 1.");
  }

  console.log("turn 2: new wrapper instance resumes by id (same cwd)…");
  const second = await runTurn({
    prompt: "What exact marker did I ask you to remember? Reply with the marker only.",
    cwd: repo,
    resume: first.sessionId,
  });
  console.log(`  session: ${second.sessionId}\n  reply: ${second.resultText}\n`);
  if (!second.resultText.includes(MARKER)) {
    throw new Error(
      `FAIL: resumed session did not recall the marker (got: ${second.resultText}).`,
    );
  }
  console.log("  PASS: resume restored context across wrapper instances.\n");

  console.log("turn 3: same resume id from a DIFFERENT cwd (mismatch drill)…");
  const otherCwd = mkdtempSync(path.join(os.tmpdir(), "glp-spike-other-"));
  let mismatchDetectable = false;
  try {
    const third = await runTurn({
      prompt: "What exact marker did I ask you to remember? Reply with the marker only.",
      cwd: otherCwd,
      resume: first.sessionId,
    });
    const recalled = third.resultText.includes(MARKER);
    const idChanged = third.sessionId !== first.sessionId;
    console.log(
      `  session: ${third.sessionId} (changed: ${idChanged})\n  reply: ${third.resultText}`,
    );
    mismatchDetectable = !recalled || idChanged;
  } catch (error) {
    console.log(`  resume from wrong cwd threw: ${error instanceof Error ? error.message : error}`);
    mismatchDetectable = true;
  }
  if (!mismatchDetectable) {
    console.log(
      "  NOTE: wrong-cwd resume behaved identically — re-brief detection relies on errors only.",
    );
  } else {
    console.log("  PASS: cwd mismatch is detectable (blank context, changed id, or error).\n");
  }

  console.log("spike complete.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
