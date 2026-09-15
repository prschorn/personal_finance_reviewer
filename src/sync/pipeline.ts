import type { DB } from '../db/client';
import { getDb } from '../db/client';
import type { PluggyApi } from '../pluggy/types';
import { detectInternal, type InternalDetectionStats } from './internal';
import { recategorizeAll, type RecategorizeStats } from '../categorize/recategorize';
import { syncAll, type SyncOptions, type SyncResult } from './run';
import { findDuplicateFingerprints } from './upsert';

export interface PipelineResult {
  sync: SyncResult;
  internal: InternalDetectionStats;
  categorize: RecategorizeStats;
  /** Same fingerprint on 2+ live rows — a failed reconciliation that would inflate a month. */
  duplicateFingerprints: number;
}

/**
 * The complete refresh: pull from Pluggy, detect internal movements, then
 * re-resolve every category.
 *
 * Detection and categorization run over the whole table rather than only the rows
 * this sync touched. At this scale that costs tens of milliseconds and removes an
 * entire class of staleness bug — a new rule, a new bill, or a newly paired
 * transfer can change the classification of rows that were not themselves updated.
 */
export async function syncAndCategorize(
  api: PluggyApi,
  db: DB = getDb(),
  opts: SyncOptions = {},
): Promise<PipelineResult> {
  const sync = await syncAll(api, db, opts);
  return { ...recategorize(db), sync };
}

/** Re-run detection and categorization without pulling. Used after a rule or override edit. */
export function recategorize(db: DB = getDb()): Omit<PipelineResult, 'sync'> {
  const { findings, stats: internal } = detectInternal(db);
  const categorize = recategorizeAll(db, findings);
  return {
    internal,
    categorize,
    duplicateFingerprints: findDuplicateFingerprints(db).length,
  };
}
