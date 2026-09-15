import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'node:path';
import { getDb, DB_PATH, type DB } from './client';

export const MIGRATIONS_FOLDER = resolve(process.cwd(), 'drizzle');

export function runMigrations(db: DB = getDb()): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

// `npm run db:migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations();
  console.log(`Migrations applied to ${DB_PATH}`);
}
