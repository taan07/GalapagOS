// The Obsidian vault view of agreed specifics. Since Chunk 2 the records
// store (docs/galapagos/ in the target repo) is the memory and these files
// are its human-readable mirror: new specifics are written through with a
// migrated_to pointer, and pre-records-store files are ingested exactly once
// (ingest.ts) and stamped migrated_to so restarts never duplicate them.
// Writes are wx (never overwrite) and stay inside the vault.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export type AgreedSpecific = {
  fileName: string;
  question: string;
  answer: string;
  project: string;
  status: "agreed" | "superseded" | "deferred";
  createdAt: string;
  /** Record id this file was migrated to / mirrors; undefined = not ingested. */
  migratedTo?: string;
  body: string;
};

export type WriteSpecificInput = {
  vaultPath: string;
  projectSlug: string;
  question: string;
  answer: string;
  /** Record id this file mirrors (write-through from the records store). */
  migratedTo?: string;
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
    ...(input.migratedTo ? [`migrated_to: "${escapeYaml(input.migratedTo)}"`] : []),
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
        migratedTo: parseFrontmatterValue(lines, "migrated_to"),
        body,
      };
    });
}

/**
 * Stamp a vault specific as migrated to a record so ingestion re-runs skip
 * it. Inserts migrated_to into the existing frontmatter block; no-op when the
 * stamp is already present.
 */
export function markSpecificMigrated(
  vaultPath: string,
  projectSlug: string,
  fileName: string,
  recordId: string,
): void {
  const filePath = path.join(specificsDir(vaultPath, projectSlug), fileName);
  const content = readFileSync(filePath, "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error(`Vault specific ${fileName} has no frontmatter to stamp.`);
  }
  if (/^migrated_to: /m.test(match[1] ?? "")) {
    return;
  }
  const stamped = content.replace(
    /^---\n([\s\S]*?)\n---/,
    `---\n$1\nmigrated_to: "${escapeYaml(recordId)}"\n---`,
  );
  writeFileSync(filePath, stamped, "utf8");
}
