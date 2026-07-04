import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The only git mutations Chunk 1 is allowed to perform: initializing history
// for a project the user registers. Worktree/tag mutations arrive with the
// mutating runner in Chunks 3 and 6.
export function isGitRepo(rootPath: string): boolean {
  return existsSync(path.join(rootPath, ".git"));
}

export async function initGitRepo(
  rootPath: string,
  options: { identity?: { name: string; email: string } } = {},
): Promise<void> {
  if (isGitRepo(rootPath)) {
    return;
  }

  const identityArgs = options.identity
    ? ["-c", `user.name=${options.identity.name}`, "-c", `user.email=${options.identity.email}`]
    : [];

  const run = async (args: string[]) => {
    try {
      await execFileAsync("git", args, { cwd: rootPath, encoding: "utf8" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`git ${args.join(" ")} failed in ${rootPath}: ${message}`);
    }
  };

  await run(["init", "-b", "main"]);
  await run([...identityArgs, "add", "-A"]);
  await run([
    ...identityArgs,
    "commit",
    "--allow-empty",
    "-m",
    "galapagos: initial commit on project registration",
  ]);
}
