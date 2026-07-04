// Server-side folder browsing for project registration. Bounded to the
// user's home directory — this backs a local single-user UI, not a public API.
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type BrowseEntry = {
  name: string;
  path: string;
  isGitRepo: boolean;
  isRegistered: boolean;
};

export type BrowseResult = {
  path: string;
  parent: string | null;
  devRoot: string;
  entries: BrowseEntry[];
};

const SKIPPED_DIRS = new Set(["node_modules", "Library", ".git"]);

export function browseDirectory(input: {
  requestedPath: string | undefined;
  devRoot: string;
  registeredPaths: Set<string>;
}): BrowseResult {
  const home = os.homedir();
  const requested = path.resolve(input.requestedPath || input.devRoot);
  if (requested !== home && !requested.startsWith(`${home}${path.sep}`)) {
    throw new Error("Browsing is limited to your home directory.");
  }
  if (!existsSync(requested) || !statSync(requested).isDirectory()) {
    throw new Error(`Not a directory: ${requested}`);
  }

  const entries: BrowseEntry[] = readdirSync(requested, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name),
    )
    .map((entry) => {
      const fullPath = path.join(requested, entry.name);
      return {
        name: entry.name,
        path: fullPath,
        isGitRepo: existsSync(path.join(fullPath, ".git")),
        isRegistered: input.registeredPaths.has(fullPath),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));

  return {
    path: requested,
    parent: requested === home ? null : path.dirname(requested),
    devRoot: input.devRoot,
    entries,
  };
}
