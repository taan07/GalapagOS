// Frontmatter mechanics for durable records (architecture §4). Ported from the
// prior prototype's obsidian frontmatter module: double-quoted strings with
// escapes, bare scalars for numbers/booleans/null, dash lists for string
// arrays. Pure — no fs, no dates, no randomness.

export type FrontmatterValue = string | number | boolean | null | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export type ParsedDocument = {
  data: Frontmatter;
  body: string;
};

function escapeString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

function unescapeString(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charAt(i);
    if (ch !== "\\" || i === value.length - 1) {
      out += ch;
      continue;
    }
    const next = value.charAt(i + 1);
    if (next === "n") {
      out += "\n";
    } else if (next === "t") {
      out += "\t";
    } else if (next === '"' || next === "\\") {
      out += next;
    } else {
      out += ch + next;
    }
    i += 1;
  }
  return out;
}

function serializeScalar(value: string | number | boolean | null): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return `"${escapeString(value)}"`;
  }
  return String(value);
}

export function serializeFrontmatter(data: Frontmatter): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${serializeScalar(item)}`);
        }
      }
      continue;
    }
    lines.push(`${key}: ${serializeScalar(value)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

export function composeDocument(data: Frontmatter, body: string): string {
  const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
  return `${serializeFrontmatter(data)}\n\n${trimmedBody}\n`;
}

function parseScalar(raw: string): FrontmatterValue {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return unescapeString(trimmed.slice(1, -1));
  }
  if (trimmed === "null" || trimmed === "~" || trimmed === "") {
    return null;
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

/**
 * Parse a markdown document with an optional leading frontmatter block.
 * A document without frontmatter yields empty data and the whole text as body.
 */
export function parseDocument(markdown: string): ParsedDocument {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { data: {}, body: markdown };
  }

  const data: Frontmatter = {};
  const lines = (match[1] ?? "").split("\n");
  let pendingListKey: string | null = null;

  for (const line of lines) {
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && pendingListKey) {
      const parsed = parseScalar(listItem[1] ?? "");
      (data[pendingListKey] as string[]).push(
        typeof parsed === "string" ? parsed : String(parsed),
      );
      continue;
    }

    const keyed = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!keyed || keyed[1] === undefined) {
      pendingListKey = null;
      continue;
    }
    const key = keyed[1];
    const rest = (keyed[2] ?? "").trim();
    if (rest === "") {
      data[key] = [];
      pendingListKey = key;
      continue;
    }
    if (rest === "[]") {
      data[key] = [];
      pendingListKey = null;
      continue;
    }
    data[key] = parseScalar(rest);
    pendingListKey = null;
  }

  return { data, body: markdown.slice(match[0].length) };
}
