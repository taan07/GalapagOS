// Fresh-install smoke check: this runs through tsx's retained Node runtime,
// rather than Bun's runtime, and proves the native binding can open a database.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/adapters/db/db";

if (!process.versions.node || process.versions.bun) {
  throw new Error("SQLite smoke check must run under Node via tsx.");
}

const stateDir = mkdtempSync(path.join(os.tmpdir(), "galapagos-sqlite-smoke-"));
try {
  const db = openDb(stateDir);
  try {
    assert.equal((db.prepare("SELECT 1 AS value").get() as { value: number }).value, 1);
  } finally {
    db.close();
  }
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

console.log("SQLite native binding opened successfully under Node via tsx.");
