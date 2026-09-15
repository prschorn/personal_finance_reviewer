import { addDays, type Ymd } from '../lib/date';

/**
 * Window planning for the incremental pull. Pure: dates in, dates out.
 *
 * Neither window alone is sufficient, which is the whole design:
 *
 *  - Window A (`createdAtFrom`) catches everything CREATED server-side since the
 *    last run, including old-dated rows and re-creations. It can never observe a
 *    deletion, because a deleted row simply isn't returned by anything.
 *
 *  - Window B (`dateFrom`/`dateTo`) returns the authoritative COMPLETE SET for a
 *    bounded date range, which is the only way to observe absence. Bounded to 45
 *    days normally — one card cycle plus slack — and widened to the full available
 *    history once a month so old-row deletions and any drift get repaired.
 */

/** One card cycle (~30d) plus slack for late merchant postings. */
export const DEFAULT_RESCAN_DAYS = 45;
/** How often Window B widens to the full history. */
export const DEFAULT_DEEP_SCAN_INTERVAL_DAYS = 30;
/** Open Finance exposes ~12 months. */
export const DEFAULT_FULL_HISTORY_DAYS = 365;
/** Absorbs clock skew between our host and Pluggy, and one failed run. */
export const WATERMARK_MARGIN_MS = 24 * 60 * 60 * 1000;
/** How far ahead to ASK for rows. Card installments are billed a year or more out. */
export const DEFAULT_FUTURE_HORIZON_DAYS = 400;

export interface AccountSyncStateLike {
  lastSuccessAt?: string | null;
  lastDeepScanAt?: string | null;
}

export interface WindowPlanOptions {
  today: Ymd;
  now: string;
  rescanDays?: number;
  deepScanIntervalDays?: number;
  fullHistoryDays?: number;
  futureHorizonDays?: number;
}

export interface WindowPlan {
  /** Absent on a first sync, where the full-history rescan already covers everything. */
  incremental: { createdAtFrom: string } | null;
  /**
   * What we ASK Pluggy for. Reaches into the future so scheduled card installments
   * are re-confirmed on every sync instead of frozen at the moment they were first
   * seen — a plan that gets cancelled or renegotiated should stop being reported.
   */
  rescan: { dateFrom: Ymd; dateTo: Ymd };
  /**
   * What the sweep may delete within. Narrower than `rescan` on purpose.
   *
   * A range is authoritative for deletion only once we have observed it come back
   * complete. Nothing has yet established that a date-ranged `/v2/transactions`
   * query returns future-dated rows at all, and if it does not, a forward-reaching
   * sweep would soft-delete every scheduled installment on the first run. Widen
   * this to match `rescan` only after confirming that future rows come back with
   * the current run id:
   *
   *   SELECT last_seen_run_id = (SELECT max(id) FROM sync_runs), count(*)
   *   FROM transactions
   *   WHERE deleted_at IS NULL AND posted_on > date('now') GROUP BY 1;
   */
  sweep: { dateFrom: Ymd; dateTo: Ymd };
  /** True when the rescan covers the full history, so its sweep is authoritative for all of it. */
  isDeepScan: boolean;
  isFirstSync: boolean;
}

export function planWindows(state: AccountSyncStateLike, opts: WindowPlanOptions): WindowPlan {
  const rescanDays = opts.rescanDays ?? DEFAULT_RESCAN_DAYS;
  const deepScanIntervalDays = opts.deepScanIntervalDays ?? DEFAULT_DEEP_SCAN_INTERVAL_DAYS;
  const fullHistoryDays = opts.fullHistoryDays ?? DEFAULT_FULL_HISTORY_DAYS;

  const isFirstSync = !state.lastSuccessAt;
  const deepScanDue = isDeepScanDue(state.lastDeepScanAt, opts.now, deepScanIntervalDays);
  const isDeepScan = isFirstSync || deepScanDue;

  const dateFrom = addDays(opts.today, -(isDeepScan ? fullHistoryDays : rescanDays));
  // Tomorrow: some institutions post a transaction dated slightly ahead.
  const sweepTo = addDays(opts.today, 1);
  const fetchTo = addDays(opts.today, opts.futureHorizonDays ?? DEFAULT_FUTURE_HORIZON_DAYS);

  return {
    incremental: isFirstSync
      ? null
      : { createdAtFrom: new Date(Date.parse(state.lastSuccessAt!) - WATERMARK_MARGIN_MS).toISOString() },
    rescan: { dateFrom, dateTo: fetchTo },
    sweep: { dateFrom, dateTo: sweepTo },
    isDeepScan,
    isFirstSync,
  };
}

export function isDeepScanDue(
  lastDeepScanAt: string | null | undefined,
  now: string,
  intervalDays: number,
): boolean {
  if (!lastDeepScanAt) return true;
  const elapsed = Date.parse(now) - Date.parse(lastDeepScanAt);
  return !Number.isFinite(elapsed) || elapsed >= intervalDays * 86_400_000;
}

/** Is the app's local data stale enough to auto-sync on page load? */
export function isStale(lastSuccessAt: string | null | undefined, now: string, maxAgeHours = 6): boolean {
  if (!lastSuccessAt) return true;
  const elapsed = Date.parse(now) - Date.parse(lastSuccessAt);
  return !Number.isFinite(elapsed) || elapsed >= maxAgeHours * 3_600_000;
}
