import { eq, and } from 'drizzle-orm';
import type { DB } from '../db/client';
import { getDb } from '../db/client';
import { accounts, accountSyncState, items, syncRuns } from '../db/schema';
import { PluggyError } from '../pluggy/client';
import type { PluggyApi, PluggyAccount, PluggyItem } from '../pluggy/types';
import { today as todayInSaoPaulo } from '../lib/date';
import { planWindows, type WindowPlan } from './windows';
import {
  emptyUpsertStats, markSyncSuccess, sweepDeleted, upsertAccount, upsertBills,
  upsertItem, upsertTransactions, type UpsertStats,
} from './upsert';
import { emptyRescueStats, rescueOverrides, type RescueStats } from './reconcile';

export interface SyncOptions {
  trigger?: 'manual' | 'auto';
  now?: () => Date;
  rescanDays?: number;
  deepScanIntervalDays?: number;
  fullHistoryDays?: number;
  pageSize?: number;
  /** Item ids to use when GET /items is forbidden (free tier). */
  fallbackItemIds?: string[];
  onProgress?: (message: string) => void;
}

export interface SyncResult {
  runId: number;
  status: 'ok' | 'partial' | 'error';
  startedAt: string;
  finishedAt: string;
  itemsSynced: number;
  accountsSynced: number;
  transactions: UpsertStats;
  deleted: number;
  overrides: RescueStats;
  billsFetched: number;
  /** Item/account level problems that did not abort the run. */
  warnings: string[];
  error?: string;
}

/** Item states where the data we'd pull may be incomplete or unavailable. */
const NEEDS_USER_ACTION = new Set([
  'LOGIN_ERROR', 'WAITING_USER_INPUT', 'USER_AUTHORIZATION_PENDING',
  'ACCOUNT_NEEDS_ACTION', 'INVALID_CREDENTIALS', 'INVALID_CREDENTIALS_MFA',
  'ACCOUNT_CREDENTIALS_RESET',
]);

let syncInFlight = false;

/**
 * Pull everything Pluggy has into the local database.
 *
 * Pluggy auto-syncs items on its own schedule and its docs say not to build an
 * update loop, so this only ever READS — it never PATCHes an item. Manual refresh
 * is a separate, explicitly user-pressed action.
 */
export async function syncAll(api: PluggyApi, db: DB = getDb(), opts: SyncOptions = {}): Promise<SyncResult> {
  if (syncInFlight) throw new Error('A sync is already running');
  syncInFlight = true;
  try {
    return await runSync(api, db, opts);
  } finally {
    syncInFlight = false;
  }
}

async function runSync(api: PluggyApi, db: DB, opts: SyncOptions): Promise<SyncResult> {
  const clock = opts.now ?? (() => new Date());
  const startedAt = clock().toISOString();
  const progress = opts.onProgress ?? (() => {});

  const run = db
    .insert(syncRuns)
    .values({ startedAt, trigger: opts.trigger ?? 'manual', status: 'running' })
    .returning({ id: syncRuns.id })
    .get();
  const runId = run.id;

  const result: SyncResult = {
    runId, status: 'ok', startedAt, finishedAt: startedAt,
    itemsSynced: 0, accountsSynced: 0,
    transactions: emptyUpsertStats(), deleted: 0, overrides: emptyRescueStats(),
    billsFetched: 0, warnings: [],
  };

  try {
    const itemIds = await resolveItemIds(api, db, opts, result);
    if (!itemIds.length) {
      result.warnings.push(
        'No connections configured. Connect a bank at https://meu.pluggy.ai and set PLUGGY_ITEM_IDS.',
      );
    }

    for (const itemId of itemIds) {
      let item: PluggyItem;
      try {
        item = await api.getItem(itemId);
      } catch (err) {
        result.warnings.push(`Item ${itemId}: ${describe(err)}`);
        result.status = 'partial';
        continue;
      }
      upsertItem(db, item);
      result.itemsSynced++;
      progress(`${item.connector?.name ?? itemId}: ${item.status}`);

      if (NEEDS_USER_ACTION.has(String(item.executionStatus)) || NEEDS_USER_ACTION.has(String(item.status))) {
        result.warnings.push(
          `${item.connector?.name ?? itemId} needs attention (${item.status}/${item.executionStatus}). Reconnect at https://meu.pluggy.ai.`,
        );
        result.status = 'partial';
      }

      // Mid-update data may be incomplete: pull it, but don't let it look authoritative.
      const isUpdating = item.status === 'UPDATING' || item.executionStatus === 'MERGING';
      if (isUpdating) {
        result.warnings.push(`${item.connector?.name ?? itemId} is still updating; not advancing the watermark.`);
        result.status = 'partial';
      }

      let accountList: PluggyAccount[];
      try {
        accountList = await api.listAccounts(itemId);
      } catch (err) {
        result.warnings.push(`Accounts for ${itemId}: ${describe(err)}`);
        result.status = 'partial';
        continue;
      }

      for (const account of accountList) {
        upsertAccount(db, account);
        try {
          await syncAccount(api, db, account, { runId, clock, isUpdating, opts, result, progress });
          result.accountsSynced++;
        } catch (err) {
          result.warnings.push(`Account ${account.id}: ${describe(err)}`);
          result.status = 'partial';
        }
      }
    }

    result.finishedAt = clock().toISOString();
    db.update(syncRuns)
      .set({ finishedAt: result.finishedAt, status: result.status, statsJson: JSON.stringify(result) })
      .where(eq(syncRuns.id, runId))
      .run();
    return result;
  } catch (err) {
    result.status = 'error';
    result.error = describe(err);
    result.finishedAt = clock().toISOString();
    db.update(syncRuns)
      .set({ finishedAt: result.finishedAt, status: 'error', error: result.error, statsJson: JSON.stringify(result) })
      .where(eq(syncRuns.id, runId))
      .run();
    throw err;
  }
}

interface AccountSyncContext {
  runId: number;
  clock: () => Date;
  isUpdating: boolean;
  opts: SyncOptions;
  result: SyncResult;
  progress: (message: string) => void;
}

async function syncAccount(api: PluggyApi, db: DB, account: PluggyAccount, ctx: AccountSyncContext): Promise<void> {
  const { runId, clock, opts, result } = ctx;
  const now = clock().toISOString();

  const state = db
    .select()
    .from(accountSyncState)
    .where(eq(accountSyncState.accountId, account.id))
    .get();

  const plan = planWindows(state ?? {}, {
    today: todayInSaoPaulo(clock()),
    now,
    rescanDays: opts.rescanDays,
    deepScanIntervalDays: opts.deepScanIntervalDays,
    fullHistoryDays: opts.fullHistoryDays,
  });

  ctx.progress(
    `${account.type}/${account.subtype} ${account.id.slice(0, 8)}: ${plan.isDeepScan ? 'deep scan' : 'rescan'} from ${plan.rescan.dateFrom}`,
  );

  // Window A — creations since the last run. Never feeds the deletion sweep:
  // it is not a complete set for any date range.
  if (plan.incremental) {
    for await (const page of api.listTransactions({
      accountId: account.id,
      createdAtFrom: plan.incremental.createdAtFrom,
      pageSize: opts.pageSize,
    })) {
      upsertTransactions(db, page, account, { runId, now }, result.transactions);
    }
  }

  // Window B — the authoritative complete set for a bounded range.
  for await (const page of api.listTransactions({
    accountId: account.id,
    dateFrom: plan.rescan.dateFrom,
    dateTo: plan.rescan.dateTo,
    pageSize: opts.pageSize,
  })) {
    upsertTransactions(db, page, account, { runId, now }, result.transactions);
  }

  if (account.type === 'CREDIT') {
    try {
      result.billsFetched += upsertBills(db, account.id, await api.listBills(account.id));
    } catch (err) {
      // Bills are an enhancement, never load-bearing: the free tier may forbid them.
      if (!(err instanceof PluggyError && err.isForbidden)) throw err;
      result.warnings.push('Credit card bills are unavailable on this plan; using description-based bill detection.');
    }
  }

  // Mid-update data isn't a reliable complete set, so neither sweep nor advance.
  if (ctx.isUpdating) return;

  const deletedFingerprints = sweepDeleted(db, account.id, plan.rescan, runId, now);
  result.deleted += deletedFingerprints.length;

  rescueOverrides(db, { deletedFingerprints, accountId: account.id, runId, now }, result.overrides);

  markSyncSuccess(db, account.id, { now, runId, isDeepScan: plan.isDeepScan });
}

/**
 * Prefer discovery; fall back to configured ids. On the free "Meu Pluggy" tier
 * GET /items is forbidden, so the items table (seeded from PLUGGY_ITEM_IDS or the
 * Settings page) is the source of truth for what to sync.
 */
async function resolveItemIds(api: PluggyApi, db: DB, opts: SyncOptions, result: SyncResult): Promise<string[]> {
  try {
    const discovered = await api.listItems();
    if (discovered.length) return discovered.map((i) => i.id);
  } catch (err) {
    if (!(err instanceof PluggyError && err.isForbidden)) throw err;
    result.warnings.push('Connection discovery is unavailable on this plan; using configured connection ids.');
  }

  const configured = opts.fallbackItemIds ?? [];
  for (const id of configured) {
    db.insert(items).values({ id }).onConflictDoNothing().run();
  }

  return db
    .select({ id: items.id })
    .from(items)
    .where(eq(items.enabled, true))
    .all()
    .map((r) => r.id);
}

/** Reap runs left `running` by a crash. Called at startup. */
export function reapStaleRuns(db: DB = getDb(), now = new Date(), maxAgeMinutes = 15): number {
  const cutoff = new Date(now.getTime() - maxAgeMinutes * 60_000).toISOString();
  const stale = db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(and(eq(syncRuns.status, 'running')))
    .all()
    .filter((r) => {
      const row = db.select().from(syncRuns).where(eq(syncRuns.id, r.id)).get();
      return !!row && row.startedAt < cutoff;
    });

  for (const r of stale) {
    db.update(syncRuns)
      .set({ status: 'error', error: 'Abandoned (process exited mid-sync)', finishedAt: now.toISOString() })
      .where(eq(syncRuns.id, r.id))
      .run();
  }
  return stale.length;
}

/** Test seam: clear the in-process mutex. */
export function __resetSyncLock(): void {
  syncInFlight = false;
}

function describe(err: unknown): string {
  if (err instanceof PluggyError) return `${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export { accounts };
