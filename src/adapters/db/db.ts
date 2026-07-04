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
  }
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
