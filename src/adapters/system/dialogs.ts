// Native system dialogs for the local single-user app. macOS-first: the
// folder chooser is the OS's own browser, which beats any in-app file tree.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ChooseFolderResult = { path: string } | { cancelled: true };

export async function chooseFolder(defaultLocation: string): Promise<ChooseFolderResult> {
  if (process.platform !== "darwin") {
    throw new Error("The native folder chooser is only wired up for macOS right now.");
  }

  const script = [
    "POSIX path of (choose folder",
    'with prompt "Choose a project folder for Galapagos"',
    `default location POSIX file ${JSON.stringify(defaultLocation)})`,
  ].join(" ");

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      encoding: "utf8",
      timeout: 5 * 60 * 1000,
    });
    const chosen = stdout.trim().replace(/\/$/, "");
    if (!chosen) {
      return { cancelled: true };
    }
    return { path: chosen };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/canceled|cancelled|-128/.test(message)) {
      return { cancelled: true };
    }
    throw new Error(`Folder chooser failed: ${message}`);
  }
}

export async function revealFolder(target: string): Promise<void> {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  await execFileAsync(opener, [target]);
}
