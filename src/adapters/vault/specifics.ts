// Interim memory (Chunk 1 → 2 bridge): agreed specifics as markdown files in
// the user's Obsidian vault. See architecture §1 "Interim memory" — Chunk 2's
// records store ingests these files; they are Darwin's durable memory until
// then, so writes are wx (never overwrite) and stay inside the vault.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export type AgreedSpecific = {
  fileName: string;
  question: string;
  answer: string;
  project: string;
  status: "agreed" | "superseded" | "deferred";
  createdAt: string;
  body: string;
};

export type WriteSpecificInput = {
  vaultPath: string;
  projectSlug: string;
  question: string;
  answer: string;
  now?: Date;
};

const SPECIFICS_ROOT = "Galapagos";

function resolveInsideVault(vaultPath: string, relativePath: string): string {
  const vaultRoot = path.resolve(vaultPath);
  const resolved = path.resolve(vaultRoot, ...relativePath.split("/"));
  if (resolved !== vaultRoot && !resolved.startsWith(`${vaultRoot}${path.sep}`)) {
    throw new Error(`Refusing to write outside the Obsidian vault: ${relativePath}`);
  }
  return resolved;
}

function specificsDir(vaultPath: string, projectSlug: string): string {
  return resolveInsideVault(vaultPath, `${SPECIFICS_ROOT}/${projectSlug}/specifics`);
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "specific"
  );
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

function summarize(value: string, max = 160): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function writeAgreedSpecific(input: WriteSpecificInput): AgreedSpecific {
  const question = input.question.trim();
  const answer = input.answer.trim();
  if (!question || !answer) {
    throw new Error("An agreed specific needs both a question and an answer.");
  }

  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const datePrefix = createdAt.slice(0, 10);
  const dir = specificsDir(input.vaultPath, input.projectSlug);
  mkdirSync(dir, { recursive: true });

  const baseName = `${datePrefix}-${slugify(question)}`;
  let fileName = `${baseName}.md`;
  let suffix = 2;
  while (existsSync(path.join(dir, fileName))) {
    fileName = `${baseName}-${suffix}.md`;
    suffix += 1;
  }

  const markdown = [
    "---",
    'glp_type: "agreed_specific"',
    `question: "${escapeYaml(summarize(question))}"`,
    `answer: "${escapeYaml(summarize(answer))}"`,
    `project: "${escapeYaml(input.projectSlug)}"`,
    'status: "agreed"',
    `created_at: "${createdAt}"`,
    "---",
    "",
    `# ${summarize(question, 100)}`,
    "",
    "## Question",
    "",
    question,
    "",
    "## Agreed answer",
    "",
    answer,
    "",
  ].join("\n");

  writeFileSync(path.join(dir, fileName), markdown, { encoding: "utf8", flag: "wx" });

  return {
    fileName,
    question: summarize(question),
    answer: summarize(answer),
    project: input.projectSlug,
    status: "agreed",
    createdAt,
    body: markdown,
  };
}

function parseFrontmatterValue(lines: string[], key: string): string | undefined {
  const line = lines.find((candidate) => candidate.startsWith(`${key}: `));
  if (!line) {
    return undefined;
  }
  const raw = line.slice(key.length + 2).trim();
  return raw.startsWith('"') && raw.endsWith('"')
    ? raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
    : raw;
}

export function listAgreedSpecifics(vaultPath: string, projectSlug: string): AgreedSpecific[] {
  const dir = specificsDir(vaultPath, projectSlug);
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((fileName) => {
      const body = readFileSync(path.join(dir, fileName), "utf8");
      const frontmatterMatch = body.match(/^---\n([\s\S]*?)\n---/);
      const lines = frontmatterMatch?.[1]?.split("\n") ?? [];
      const status = parseFrontmatterValue(lines, "status");
      return {
        fileName,
        question: parseFrontmatterValue(lines, "question") ?? fileName,
        answer: parseFrontmatterValue(lines, "answer") ?? "",
        project: parseFrontmatterValue(lines, "project") ?? projectSlug,
        status: status === "superseded" || status === "deferred" ? status : "agreed",
        createdAt: parseFrontmatterValue(lines, "created_at") ?? "",
        body,
      };
    });
}
