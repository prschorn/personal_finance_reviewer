import { sql, eq, and, isNull, ne, gte, lte, inArray } from 'drizzle-orm';
import type { DB } from '../db/client';
import { accounts, bills, items, transactions, accountSyncState, transactionOverrides } from '../db/schema';
import type { NewTransaction } from '../db/schema';
import { mapAccount, mapBill, mapTransaction, signAgreesWithType } from './map';
import type { PluggyAccount, PluggyBill, PluggyItem, PluggyTransaction } from '../pluggy/types';
import type { Ymd } from '../lib/date';

export interface UpsertStats {
  inserted: number;
  updated: number;
  /** Rows previously soft-deleted that Pluggy returned again. */
  revived: number;
  /** Normalized sign disagreed with Pluggy's own DEBIT/CREDIT flag. */
  signMismatches: number;
}

export function emptyUpsertStats(): UpsertStats {
  return { inserted: 0, updated: 0, revived: 0, signMismatches: 0 };
}

export function upsertItem(db: DB, item: PluggyItem): void {
  const row = {
    id: item.id,
    connectorId: item.connector?.id ?? null,
    connectorName: item.connector?.name ?? null,
    status: item.status ?? null,
    executionStatus: item.executionStatus ?? null,
    lastUpdatedAt: item.lastUpdatedAt ?? null,
    consentExpiresAt: item.consentExpiresAt ?? null,
    rawJson: JSON.stringify(item),
  };
  db.insert(items)
    .values(row)
    .onConflictDoUpdate({
      target: items.id,
      // `enabled` and `lastPatchAt` are local state; never overwrite them from the API.
      set: {
        connectorId: row.connectorId, connectorName: row.connectorName,
        status: row.status, executionStatus: row.executionStatus,
        lastUpdatedAt: row.lastUpdatedAt, consentExpiresAt: row.consentExpiresAt,
        rawJson: row.rawJson,
      },
    })
    .run();
}

export function upsertAccount(db: DB, account: PluggyAccount): void {
  const row = mapAccount(account);
  db.insert(accounts)
    .values(row)
    .onConflictDoUpdate({
      target: accounts.id,
      set: {
        type: row.type, subtype: row.subtype, name: row.name, number: row.number,
        balanceCents: row.balanceCents, currencyCode: row.currencyCode,
        creditLimitCents: row.creditLimitCents,
        availableCreditLimitCents: row.availableCreditLimitCents,
        balanceCloseDate: row.balanceCloseDate, balanceDueDate: row.balanceDueDate,
        cardBrand: row.cardBrand, cardLevel: row.cardLevel, rawJson: row.rawJson,
      },
    })
    .run();
  db.insert(accountSyncState).values({ accountId: account.id }).onConflictDoNothing().run();
}

export function upsertBills(db: DB, accountId: string, list: PluggyBill[]): number {
  if (!list.length) return 0;
  db.transaction((tx) => {
    for (const bill of list) {
      const row = mapBill(bill, accountId);
      tx.insert(bills)
        .values(row)
        .onConflictDoUpdate({
          target: bills.id,
          set: {
            dueDate: row.dueDate, totalAmountCents: row.totalAmountCents,
            minimumPaymentCents: row.minimumPaymentCents,
            allowsInstallments: row.allowsInstallments, rawJson: row.rawJson,
          },
        })
        .run();
    }
  });
  return list.length;
}

/**
 * Mirror a page of transactions into the database.
 *
 * Writes mirror + derived columns ONLY — never categoryId, never isInternal. Those
 * belong to the categorization pass, so a re-sync can never clobber a user's
 * manual decision. That separation is what makes the whole pipeline idempotent.
 */
export function upsertTransactions(
  db: DB,
  page: PluggyTransaction[],
  account: Pick<PluggyAccount, 'id' | 'type'>,
  ctx: { runId: number; now: string },
  stats: UpsertStats = emptyUpsertStats(),
): UpsertStats {
  if (!page.length) return stats;

  db.transaction((tx) => {
    for (const raw of page) {
      const row: NewTransaction = mapTransaction(raw, account, ctx);

      if (!signAgreesWithType(row.signedCents, row.type)) stats.signMismatches++;

      const existing = tx
        .select({ id: transactions.id, deletedAt: transactions.deletedAt })
        .from(transactions)
        .where(eq(transactions.id, row.id))
        .get();

      if (existing) {
        if (existing.deletedAt) stats.revived++;
        else stats.updated++;
      } else {
        stats.inserted++;
      }

      tx.insert(transactions)
        .values(row)
        .onConflictDoUpdate({
          target: transactions.id,
          set: {
            // Everything Pluggy owns.
            fingerprint: row.fingerprint,
            dateUtc: row.dateUtc, postedOn: row.postedOn,
            description: row.description, descriptionRaw: row.descriptionRaw,
            searchText: row.searchText,
            amountCents: row.amountCents, signedCents: row.signedCents,
            currencyCode: row.currencyCode, type: row.type, status: row.status,
            balanceCents: row.balanceCents, providerCode: row.providerCode,
            merchantName: row.merchantName, merchantCnpj: row.merchantCnpj,
            pluggyCategory: row.pluggyCategory,
            paymentMethod: row.paymentMethod,
            payerName: row.payerName, payerDocument: row.payerDocument,
            receiverName: row.receiverName, receiverDocument: row.receiverDocument,
            ccInstallmentNumber: row.ccInstallmentNumber,
            ccTotalInstallments: row.ccTotalInstallments,
            ccTotalAmountCents: row.ccTotalAmountCents,
            ccPurchaseDate: row.ccPurchaseDate, ccBillId: row.ccBillId,
            rawJson: row.rawJson,
            // Bookkeeping: seeing the row again un-deletes it.
            lastSeenRunId: ctx.runId,
            deletedAt: null,
          },
        })
        .run();
    }
  });

  return stats;
}

/**
 * Mark as deleted anything inside the authoritative window that this run did not see.
 *
 * ONLY valid after Window B, which returns a complete set for its date range.
 * Window A's results are not a complete set for any range, so running this after
 * Window A would wrongly delete most of the database.
 *
 * Soft delete only: a re-encountered id is simply revived, history stays auditable,
 * and a false positive is repaired by the next deep scan.
 */
export function sweepDeleted(
  db: DB,
  accountId: string,
  range: { dateFrom: Ymd; dateTo: Ymd },
  runId: number,
  now: string,
): string[] {
  const doomed = db
    .select({ id: transactions.id, fingerprint: transactions.fingerprint })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        isNull(transactions.deletedAt),
        gte(transactions.postedOn, range.dateFrom),
        lte(transactions.postedOn, range.dateTo),
        ne(transactions.lastSeenRunId, runId),
      ),
    )
    .all();

  if (!doomed.length) return [];

  db.update(transactions)
    .set({ deletedAt: now })
    .where(inArray(transactions.id, doomed.map((d) => d.id)))
    .run();

  return doomed.map((d) => d.fingerprint);
}

export function markSyncSuccess(
  db: DB,
  accountId: string,
  ctx: { now: string; runId: number; isDeepScan: boolean },
): void {
  db.insert(accountSyncState)
    .values({
      accountId,
      lastSuccessAt: ctx.now,
      lastDeepScanAt: ctx.isDeepScan ? ctx.now : null,
      lastSyncRunId: ctx.runId,
    })
    .onConflictDoUpdate({
      target: accountSyncState.accountId,
      set: {
        lastSuccessAt: ctx.now,
        lastSyncRunId: ctx.runId,
        // Leave the previous deep-scan timestamp alone on a shallow run.
        ...(ctx.isDeepScan ? { lastDeepScanAt: ctx.now } : {}),
      },
    })
    .run();
}

/** Same fingerprint, two or more live rows — the detector for a failed reconciliation. */
export function findDuplicateFingerprints(db: DB): { fingerprint: string; n: number }[] {
  return db
    .select({ fingerprint: transactions.fingerprint, n: sql<number>`count(*)` })
    .from(transactions)
    .where(isNull(transactions.deletedAt))
    .groupBy(transactions.fingerprint)
    .having(sql`count(*) > 1`)
    .all();
}

export function countOverrides(db: DB): number {
  return db.select({ n: sql<number>`count(*)` }).from(transactionOverrides).get()?.n ?? 0;
}
