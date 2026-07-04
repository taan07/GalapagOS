// Route handlers read SQLite directly (architecture §1). This module opens one
// shared connection per Next process; handlers only SELECT — all writes go
// through the daemon.
import { config } from "../config";
import { openDb, type GalapagosDb } from "../adapters/db/db";

let db: GalapagosDb | null = null;

export function readDb(): GalapagosDb {
  if (!db) {
    db = openDb(config.stateDir);
  }
  return db;
}

export function daemonUrl(pathname: string): string {
  return `http://127.0.0.1:${config.daemonPort}${pathname}`;
}
