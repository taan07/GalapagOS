import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema";

export type GalapagosDb = Database.Database;

export function openDb(stateDir: string, options: { readonly?: boolean } = {}): GalapagosDb {
  mkdirSync(stateDir, { recursive: true });
  const db = new Database(path.join(stateDir, "state.db"), {
    readonly: options.readonly ?? false,
  });
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  if (!options.readonly) {
    db.exec(SCHEMA_SQL);
    // Additive migrations: CREATE IF NOT EXISTS cannot grow an existing
    // table, so columns added after a table shipped are patched in here.
    ensureColumn(db, "workers", "resumed_from", "TEXT");
    // The Shift+Tab autonomy axis — per-project and PERSISTENT (a restart
    // must not silently move Darwin's leash).
    ensureColumn(db, "projects", "autonomy_mode", "TEXT NOT NULL DEFAULT 'default'");
    // Existing rows retain their historical user-origin default. New daemon
    // prompts are structured role=system audit inputs; assistant/tool outputs
    // remain visible and are never recast as user intent.
    ensureColumn(db, "manager_turns", "input_origin", "TEXT NOT NULL DEFAULT 'user'");
    ensureColumn(db, "manager_turns", "input_kind", "TEXT NOT NULL DEFAULT 'user_message'");
  }
  return db;
}

function ensureColumn(db: GalapagosDb, table: string, column: string, type: string): void {
  const columns = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!columns.some((existing) => existing.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
