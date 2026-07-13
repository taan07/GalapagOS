import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GalapagosDb } from "../db";
import { nowIso } from "../db";
import { initGitRepo, isGitRepo } from "../../git/init";
import { isAutonomyMode, type AutonomyMode } from "../../../core/autonomy";

export type ProjectRow = {
  id: string;
  name: string;
  slug: string;
  root_path: string;
  created_at: string;
  /** The Shift+Tab autonomy stop — persisted; a restart never moves it. */
  autonomy_mode: AutonomyMode;
};

/** A row's mode, defensively: an unknown value reads as the middle stop. */
export function projectAutonomyMode(row: { autonomy_mode?: unknown }): AutonomyMode {
  return isAutonomyMode(row.autonomy_mode) ? row.autonomy_mode : "default";
}

export function setProjectAutonomyMode(
  db: GalapagosDb,
  id: string,
  mode: AutonomyMode,
): void {
  db.prepare("UPDATE projects SET autonomy_mode = ? WHERE id = ?").run(mode, id);
}

export type RegisterProjectInput = {
  rootPath: string;
  name?: string;
  initGit?: boolean;
  gitIdentity?: { name: string; email: string };
};

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "project"
  );
}

export function listProjects(db: GalapagosDb): ProjectRow[] {
  return db.prepare("SELECT * FROM projects ORDER BY created_at").all() as ProjectRow[];
}

export function getProject(db: GalapagosDb, id: string): ProjectRow | undefined {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
}

export async function registerProject(
  db: GalapagosDb,
  input: RegisterProjectInput,
): Promise<ProjectRow> {
  const rootPath = path.resolve(input.rootPath);
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    throw new Error(`Project path does not exist or is not a directory: ${rootPath}`);
  }

  const existing = db
    .prepare("SELECT * FROM projects WHERE root_path = ?")
    .get(rootPath) as ProjectRow | undefined;
  if (existing) {
    throw new Error(`Project already registered for path: ${rootPath}`);
  }

  if (!isGitRepo(rootPath)) {
    if (!input.initGit) {
      throw new Error(
        `Not a git repository: ${rootPath}. Galapagos never manages a project without history — pass initGit to create one.`,
      );
    }
    await initGitRepo(rootPath, { identity: input.gitIdentity });
  }

  const name = input.name?.trim() || path.basename(rootPath);
  let slug = slugify(name);
  const slugTaken = db.prepare("SELECT 1 FROM projects WHERE slug = ?");
  if (slugTaken.get(slug)) {
    slug = `${slug}-${randomUUID().slice(0, 8)}`;
  }

  const row: ProjectRow = {
    id: randomUUID(),
    name,
    slug,
    root_path: rootPath,
    created_at: nowIso(),
    // Every project starts at the middle stop; the column default covers
    // pre-migration rows the same way.
    autonomy_mode: "default",
  };
  db.prepare(
    "INSERT INTO projects (id, name, slug, root_path, created_at, autonomy_mode) VALUES (@id, @name, @slug, @root_path, @created_at, @autonomy_mode)",
  ).run(row);
  return row;
}

/**
 * Create a brand-new project from a name: folder under devRoot, seeded
 * README, git history, and registration in one step.
 */
export async function createNewProject(
  db: GalapagosDb,
  input: {
    name: string;
    devRoot: string;
    gitIdentity?: { name: string; email: string };
  },
): Promise<ProjectRow> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("A project name is required.");
  }
  if (name.startsWith(".") || /[/\\:\0]/.test(name)) {
    throw new Error("Project names cannot start with a dot or contain / \\ : characters.");
  }

  const rootPath = path.join(path.resolve(input.devRoot), name);
  if (existsSync(rootPath)) {
    throw new Error(
      `A folder named "${name}" already exists in ${input.devRoot} — register it with "Choose folder…" instead.`,
    );
  }

  mkdirSync(rootPath, { recursive: true });
  writeFileSync(path.join(rootPath, "README.md"), `# ${name}\n`, { flag: "wx" });
  await initGitRepo(rootPath, { identity: input.gitIdentity });
  return registerProject(db, { rootPath, name });
}
