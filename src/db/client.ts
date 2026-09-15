import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema';

export const DB_PATH = process.env.FINANCE_DB_PATH ?? resolve(process.cwd(), 'db/finance.db');

function open(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  return sqlite;
}

export type DB = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Next.js dev hot-reload re-evaluates modules, which would otherwise open a second
 * writer against the same file. Pin the handle to globalThis so there is exactly one.
 */
const globalForDb = globalThis as unknown as { __financeDb?: DB; __financeSqlite?: Database.Database };

export function getSqlite(): Database.Database {
  globalForDb.__financeSqlite ??= open(DB_PATH);
  return globalForDb.__financeSqlite;
}

export function getDb(): DB {
  globalForDb.__financeDb ??= drizzle(getSqlite(), { schema });
  return globalForDb.__financeDb;
}

/** A throwaway in-memory database with the schema applied. For tests only. */
export function createTestDb(): { db: DB; sqlite: Database.Database } {
  const sqlite = open(':memory:');
  return { db: drizzle(sqlite, { schema }), sqlite };
}

export { schema };
