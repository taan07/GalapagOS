// The durable records store (architecture §4): git-committed markdown at
// docs/galapagos/<type-dir>/YYYY-MM-DD-<slug>-<shortid>.md in the TARGET
// repo. Mechanics ported from the prior prototype's manager-docs module:
// wx creates (never overwrite), per-type subdirectories, open statuses on
// create, closed statuses only via update. Records are doctrine, not
// transcripts — the store enforces shape, the doctrine enforces restraint.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  composeDocument,
  parseDocument,
  type Frontmatter,
  type FrontmatterValue,
} from "../../core/records/frontmatter";
import {
  defaultStatus,
  isGlpType,
  TYPE_DIRS,
  validateCreate,
  validateStatusChange,
  WRITTEN_BY,
  type GlpType,
} from "../../core/records/schema";

export const RECORDS_DIR = "docs/galapagos";

export type RecordDoc = {
  id: string;
  type: GlpType;
  title: string;
  status: string;
  project: string;
  createdAt: string;
  updatedAt: string;
  writtenBy: string;
  /** Path relative to the project root, e.g. docs/galapagos/goals/…md */
  filePath: string;
  frontmatter: Frontmatter;
  body: string;
};

export type CreateRecordInput = {
  type: GlpType;
  title: string;
  body: string;
  status?: string;
  /** Type-specific frontmatter (question, answer, decision_options, …). */
  extra?: Frontmatter;
  now?: Date;
};

export type UpdateRecordInput = {
  id: string;
  status?: string;
  /** Appended to the body as a dated update section, never rewriting history. */
  note?: string;
  chosenPath?: string;
  now?: Date;
};

export type ListRecordsFilter = {
  type?: GlpType;
  status?: string;
};

/** Frontmatter keys the store owns — extra fields may never shadow them. */
const RESERVED_KEYS = new Set([
  "id",
  "glp_type",
  "title",
  "status",
  "project",
  "created_at",
  "updated_at",
  "written_by",
]);

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "record"
  );
}

function shortId(): string {
  return randomBytes(4).toString("hex");
}

function summarizeOneLine(value: string, max = 200): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export class RecordsStore {
  readonly projectRoot: string;
  readonly projectSlug: string;
  readonly recordsRoot: string;

  constructor(projectRoot: string, projectSlug: string) {
    this.projectRoot = path.resolve(projectRoot);
    this.projectSlug = projectSlug;
    this.recordsRoot = path.join(this.projectRoot, ...RECORDS_DIR.split("/"));
  }

  private resolveInsideRecords(relative: string): string {
    const resolved = path.resolve(this.recordsRoot, ...relative.split("/"));
    if (
      resolved !== this.recordsRoot &&
      !resolved.startsWith(`${this.recordsRoot}${path.sep}`)
    ) {
      throw new Error(`Refusing to touch a path outside ${RECORDS_DIR}: ${relative}`);
    }
    return resolved;
  }

  private parseFile(type: GlpType, fileName: string): RecordDoc | null {
    const absolute = this.resolveInsideRecords(`${TYPE_DIRS[type]}/${fileName}`);
    const { data, body } = parseDocument(readFileSync(absolute, "utf8"));
    if (!isGlpType(data.glp_type) || typeof data.id !== "string") {
      return null; // not a Galapagos record — never invent structure
    }
    return {
      id: data.id,
      type: data.glp_type,
      title: typeof data.title === "string" ? data.title : fileName,
      status: typeof data.status === "string" ? data.status : "unknown",
      project: typeof data.project === "string" ? data.project : this.projectSlug,
      createdAt: typeof data.created_at === "string" ? data.created_at : "",
      updatedAt: typeof data.updated_at === "string" ? data.updated_at : "",
      writtenBy: typeof data.written_by === "string" ? data.written_by : "",
      filePath: `${RECORDS_DIR}/${TYPE_DIRS[type]}/${fileName}`,
      frontmatter: data,
      body,
    };
  }

  create(input: CreateRecordInput): RecordDoc {
    const status = input.status ?? defaultStatus(input.type);
    const extra = input.extra ?? {};
    const problems = validateCreate({
      type: input.type,
      title: input.title,
      status,
      extra,
    });
    for (const key of Object.keys(extra)) {
      if (RESERVED_KEYS.has(key)) {
        problems.push(`Frontmatter key "${key}" is reserved and set by the store.`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`Invalid ${input.type} record: ${problems.join(" ")}`);
    }

    const now = input.now ?? new Date();
    const createdAt = now.toISOString();
    const id = shortId();
    const fileName = `${createdAt.slice(0, 10)}-${slugify(input.title)}-${id}.md`;
    const dir = this.resolveInsideRecords(TYPE_DIRS[input.type]);
    mkdirSync(dir, { recursive: true });

    const data: Frontmatter = {
      id,
      glp_type: input.type,
      title: summarizeOneLine(input.title),
      status,
      project: this.projectSlug,
      created_at: createdAt,
      updated_at: createdAt,
      written_by: WRITTEN_BY,
      ...extra,
    };
    const markdown = composeDocument(data, input.body);
    writeFileSync(path.join(dir, fileName), markdown, { encoding: "utf8", flag: "wx" });

    const doc = this.parseFile(input.type, fileName);
    if (!doc) {
      throw new Error(`Record ${fileName} did not round-trip after write.`);
    }
    return doc;
  }

  list(filter: ListRecordsFilter = {}): RecordDoc[] {
    const types = filter.type ? [filter.type] : (Object.keys(TYPE_DIRS) as GlpType[]);
    const docs: RecordDoc[] = [];
    for (const type of types) {
      const dir = path.join(this.recordsRoot, TYPE_DIRS[type]);
      if (!existsSync(dir)) {
        continue;
      }
      for (const fileName of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
        const doc = this.parseFile(type, fileName);
        if (doc && (!filter.status || doc.status === filter.status)) {
          docs.push(doc);
        }
      }
    }
    return docs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): RecordDoc | null {
    return this.list().find((doc) => doc.id === id) ?? null;
  }

  update(input: UpdateRecordInput): RecordDoc {
    const existing = this.get(input.id);
    if (!existing) {
      throw new Error(`No record with id ${input.id} in ${RECORDS_DIR}.`);
    }
    if (input.status === undefined && input.note === undefined && input.chosenPath === undefined) {
      throw new Error("An update needs a status change, a note, or a chosen_path.");
    }

    const nextStatus = input.status ?? existing.status;
    const effectiveChosenPath: FrontmatterValue | undefined =
      input.chosenPath ?? existing.frontmatter.chosen_path;
    if (input.status !== undefined) {
      const problems = validateStatusChange({
        type: existing.type,
        currentStatus: existing.status,
        nextStatus,
        chosenPath: effectiveChosenPath,
      });
      if (problems.length > 0) {
        throw new Error(`Invalid update for ${existing.type} ${existing.id}: ${problems.join(" ")}`);
      }
    }
    if (input.chosenPath !== undefined && existing.type !== "decision") {
      throw new Error("chosen_path applies only to decision records.");
    }

    const now = input.now ?? new Date();
    const updatedAt = now.toISOString();
    const data: Frontmatter = {
      ...existing.frontmatter,
      status: nextStatus,
      updated_at: updatedAt,
      ...(input.chosenPath !== undefined ? { chosen_path: input.chosenPath } : {}),
    };

    let body = existing.body.replace(/\s+$/, "");
    if (input.note !== undefined && input.note.trim()) {
      body += `\n\n## Update (${updatedAt.slice(0, 10)})\n\n${input.note.trim()}`;
    }

    const absolute = path.join(this.projectRoot, ...existing.filePath.split("/"));
    writeFileSync(absolute, composeDocument(data, body), "utf8");

    const fileName = path.basename(existing.filePath);
    const doc = this.parseFile(existing.type, fileName);
    if (!doc) {
      throw new Error(`Record ${fileName} did not round-trip after update.`);
    }
    return doc;
  }
}

export function createRecordsStore(projectRoot: string, projectSlug: string): RecordsStore {
  return new RecordsStore(projectRoot, projectSlug);
}
