import { getDb, type DB } from './client';
import { runMigrations } from './migrate';
import { seedCategories } from './seed-categories';
import { seedRules } from '../categorize/seed-rules';
import { seedOwnIdentifiersFromEnv } from '../config/own';
import { reapStaleRuns } from '../sync/run';

/**
 * Bring the database up to date on first use.
 *
 * Idempotent and cheap, so every server entry point can just call it rather than
 * relying on the user having run a setup command.
 */
let done = false;

export function bootstrap(db: DB = getDb()): DB {
  if (done) return db;
  runMigrations(db);
  seedCategories(db);
  seedRules(db);
  seedOwnIdentifiersFromEnv(db);
  reapStaleRuns(db); // clean up anything a crash left mid-flight
  done = true;
  return db;
}

export function configuredItemIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PLUGGY_ITEM_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
