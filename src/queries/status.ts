import { desc, eq } from 'drizzle-orm';
import type { DB } from '../db/client';
import { getDb } from '../db/client';
import { accountSyncState, accounts, items, syncRuns } from '../db/schema';
import { isStale } from '../sync/windows';

/** Connection and freshness state, for the banners and the settings page. */

export interface ConnectionStatus {
  itemId: string;
  connectorName: string | null;
  status: string | null;
  executionStatus: string | null;
  lastUpdatedAt: string | null;
  consentExpiresAt: string | null;
  accountCount: number;
  needsAttention: boolean;
  consentExpiringSoon: boolean;
}

const NEEDS_ATTENTION = new Set([
  'LOGIN_ERROR', 'WAITING_USER_INPUT', 'USER_AUTHORIZATION_PENDING',
  'ACCOUNT_NEEDS_ACTION', 'INVALID_CREDENTIALS', 'INVALID_CREDENTIALS_MFA',
  'ACCOUNT_CREDENTIALS_RESET', 'OUTDATED',
]);

/** Warn while there is still time to act, not after the data has gone stale. */
export const CONSENT_WARNING_DAYS = 14;

export function getConnections(db: DB = getDb(), now = new Date()): ConnectionStatus[] {
  return db
    .select()
    .from(items)
    .all()
    .map((item) => {
      const accountCount = db.select().from(accounts).where(eq(accounts.itemId, item.id)).all().length;
      const expires = item.consentExpiresAt ? Date.parse(item.consentExpiresAt) : NaN;
      return {
        itemId: item.id,
        connectorName: item.connectorName,
        status: item.status,
        executionStatus: item.executionStatus,
        lastUpdatedAt: item.lastUpdatedAt,
        consentExpiresAt: item.consentExpiresAt,
        accountCount,
        needsAttention:
          NEEDS_ATTENTION.has(String(item.status)) || NEEDS_ATTENTION.has(String(item.executionStatus)),
        consentExpiringSoon:
          Number.isFinite(expires) && expires - now.getTime() < CONSENT_WARNING_DAYS * 86_400_000,
      };
    });
}

export interface SyncStatus {
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastSuccessAt: string | null;
  stale: boolean;
  everSynced: boolean;
}

export function getSyncStatus(db: DB = getDb(), now = new Date()): SyncStatus {
  const lastRun = db.select().from(syncRuns).orderBy(desc(syncRuns.id)).limit(1).all()[0] ?? null;

  const successes = db
    .select({ at: accountSyncState.lastSuccessAt })
    .from(accountSyncState)
    .all()
    .map((r) => r.at)
    .filter((a): a is string => !!a)
    .sort();
  const lastSuccessAt = successes.at(-1) ?? null;

  return {
    lastRunAt: lastRun?.startedAt ?? null,
    lastRunStatus: lastRun?.status ?? null,
    lastSuccessAt,
    stale: isStale(lastSuccessAt, now.toISOString()),
    everSynced: !!lastSuccessAt,
  };
}

export function getRecentRuns(db: DB = getDb(), limit = 10) {
  return db.select().from(syncRuns).orderBy(desc(syncRuns.id)).limit(limit).all();
}
