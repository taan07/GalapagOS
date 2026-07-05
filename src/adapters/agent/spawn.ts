// Shared spawn options for every Agent SDK session — manager, distill fork,
// and later triage/workers (architecture §5). Auth is keychain-bound: the
// SDK's bundled runtime cannot read Claude Code's subscription credentials,
// so every query() must point pathToClaudeCodeExecutable at the user's
// installed binary, and resume is cwd-keyed, so cwd is always the project
// root — never optional, never defaulted.
import type { GalapagosConfig } from "../../config";

export type BaseQueryOptions = {
  cwd: string;
  permissionMode: "dontAsk";
  pathToClaudeCodeExecutable?: string;
  resume?: string;
  forkSession?: boolean;
};

export function baseQueryOptions(input: {
  config: GalapagosConfig;
  cwd: string;
  resume?: string | null;
  forkSession?: boolean;
}): BaseQueryOptions {
  return {
    cwd: input.cwd,
    permissionMode: "dontAsk",
    ...(input.config.claudeBinPath
      ? { pathToClaudeCodeExecutable: input.config.claudeBinPath }
      : {}),
    ...(input.resume ? { resume: input.resume } : {}),
    ...(input.forkSession ? { forkSession: true } : {}),
  };
}
