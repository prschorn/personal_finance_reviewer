import { eq } from 'drizzle-orm';
import type { DB } from '../db/client';
import { getDb } from '../db/client';
import { settings } from '../db/schema';

/**
 * Single-value settings.
 *
 * config/own.ts has its own JSON-array accessors and keeps them: they work, and
 * nothing else needs a list. This is for the scalars.
 */

/**
 * When the review queue was last cleared.
 *
 * The one piece of state the queue needs. Everything else it shows is derived from
 * the transactions table at read time, which is why there is no review table.
 */
export const LAST_REVIEWED_AT_KEY = 'last_reviewed_at';

export function readSetting(db: DB, key: string): string | null {
  return db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

export function writeSetting(db: DB, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

export function getLastReviewedAt(db: DB = getDb()): string | null {
  return readSetting(db, LAST_REVIEWED_AT_KEY);
}

export function setLastReviewedAt(db: DB = getDb(), at: string = new Date().toISOString()): void {
  writeSetting(db, LAST_REVIEWED_AT_KEY, at);
}
