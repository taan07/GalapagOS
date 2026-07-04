import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { GalapagosDb } from "../db";
import { nowIso } from "../db";
import { initGitRepo, isGitRepo } from "../../git/init";

export type ProjectRow = {
  id: string;
  name: string;
  slug: string;
  root_path: string;
  created_at: string;
};

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
  };
  db.prepare(
    "INSERT INTO projects (id, name, slug, root_path, created_at) VALUES (@id, @name, @slug, @root_path, @created_at)",
  ).run(row);
  return row;
}
