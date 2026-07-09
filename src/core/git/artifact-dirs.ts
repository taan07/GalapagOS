// Build output and dependency directories: generated content, never a review
// surface and never "work". The lane audit must not count them as out-of-lane
// changes — a target repo that forgets to .gitignore node_modules/dist would
// otherwise flood the violation list with thousands of generated files and
// bury the one real stray (observed live 2026-07-08). Both the lane audit's
// git reads (via pathspec excludes) and the critic's reference-test walk (via
// the name set) share this one list.

/** Directory names that hold generated / installed output, at any depth. */
export const ARTIFACT_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "dist-node",
  "build",
  ".next",
  "vendor",
] as const;

export const ARTIFACT_DIR_SET: ReadonlySet<string> = new Set(ARTIFACT_DIRS);

/**
 * git pathspecs that drop the artifact directories from a command's output.
 * `.git` is omitted — git never reports its own internals. Excludes the
 * top-level occurrence of each; a segment-level filter (see isArtifactPath)
 * backs this up for nested copies (monorepo workspaces).
 */
export function artifactExcludePathspecs(): string[] {
  return ARTIFACT_DIRS.filter((dir) => dir !== ".git").map((dir) => `:(exclude)${dir}`);
}

/** True when any path segment is an artifact directory (catches nested copies). */
export function isArtifactPath(filePath: string): boolean {
  return filePath
    .split("/")
    .some((segment) => segment !== "" && ARTIFACT_DIR_SET.has(segment));
}
