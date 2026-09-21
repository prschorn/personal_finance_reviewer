import { asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { getDb } from '../db/client';
import { accounts, categories, rules, transactions, transactionOverrides } from '../db/schema';
import { CATEGORY_INTERNAL, CATEGORY_OUTROS, CATEGORY_RECEITAS } from '../db/seed-categories';
import { resolve, type ResolvableTransaction, type ResolveContext, type StructuralFinding } from './resolve';
import { PLUGGY_CATEGORY_MAP } from './pluggy-categories';

/**
 * Materialize the resolver's decision onto every live transaction.
 *
 * Categories are written to the row rather than computed on read, so the monthly
 * matrix is a plain GROUP BY instead of an attempt to express rule precedence in
 * SQL. At ~20k rows this takes tens of milliseconds, so it simply runs in full
 * after every sync and after any rule or override edit — no incremental
 * invalidation machinery to get wrong.
 */

export interface RecategorizeStats {
  scanned: number;
  changed: number;
  bySource: Record<string, number>;
  internal: number;
  uncategorized: number;
}

export function recategorizeAll(
  db: DB = getDb(),
  structural: ReadonlyMap<string, StructuralFinding> = new Map(),
): RecategorizeStats {
  const ctx = buildContext(db, structural);
  const rows = db
    .select({
      id: transactions.id,
      fingerprint: transactions.fingerprint,
      accountId: transactions.accountId,
      accountType: accounts.type,
      signedCents: transactions.signedCents,
      searchText: transactions.searchText,
      description: transactions.description,
      descriptionRaw: transactions.descriptionRaw,
      merchantName: transactions.merchantName,
      pluggyCategory: transactions.pluggyCategory,
      categoryId: transactions.categoryId,
      categorySource: transactions.categorySource,
      isInternal: transactions.isInternal,
      internalReason: transactions.internalReason,
      internalPairId: transactions.internalPairId,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(isNull(transactions.deletedAt))
    .all();

  const stats: RecategorizeStats = {
    scanned: rows.length, changed: 0, bySource: {}, internal: 0, uncategorized: 0,
  };

  db.transaction((tx) => {
    for (const row of rows) {
      const next = resolve(row as ResolvableTransaction, ctx);

      stats.bySource[next.categorySource] = (stats.bySource[next.categorySource] ?? 0) + 1;
      if (next.isInternal) stats.internal++;
      if (next.categorySource === 'default' && next.categoryId === ctx.defaults.outrosId) stats.uncategorized++;

      const unchanged =
        row.categoryId === next.categoryId &&
        row.categorySource === next.categorySource &&
        row.isInternal === next.isInternal &&
        row.internalReason === next.internalReason &&
        row.internalPairId === next.internalPairId;
      if (unchanged) continue;

      tx.update(transactions)
        .set({
          categoryId: next.categoryId,
          categorySource: next.categorySource,
          isInternal: next.isInternal,
          internalReason: next.internalReason,
          internalPairId: next.internalPairId,
        })
        .where(eq(transactions.id, row.id))
        .run();
      stats.changed++;
    }
  });

  return stats;
}

function buildContext(db: DB, structural: ReadonlyMap<string, StructuralFinding>): ResolveContext {
  const byName = new Map(db.select().from(categories).all().map((c) => [c.name, c.id]));

  const need = (name: string): number => {
    const id = byName.get(name);
    if (id == null) throw new Error(`Missing seed category "${name}". Run seedCategories() first.`);
    return id;
  };

  // Resolve the Pluggy hint map to local ids once, not per row.
  const pluggyCategoryIds = new Map<string, number>();
  for (const [pluggyName, localName] of Object.entries(PLUGGY_CATEGORY_MAP)) {
    const id = byName.get(localName);
    if (id != null) pluggyCategoryIds.set(pluggyName, id);
  }

  return {
    overrides: new Map(db.select().from(transactionOverrides).all().map((o) => [o.fingerprint, o])),
    pluggyCategoryIds,
    // Priority first, then SPECIFICITY, then age.
    //
    // The specificity tiebreak matters because every rule you create sits at the
    // same priority. Without it, an early broad rule ("TRANSFERENCIA RECEBIDA")
    // permanently shadows a later precise one ("TRANSFERENCIA RECEBIDA|ACME
    // CONSULTORIA…"), and categorizing that transaction silently does nothing.
    // A longer match value is the more specific one, so it goes first.
    rules: db
      .select()
      .from(rules)
      .orderBy(asc(rules.priority), desc(sql`length(${rules.matchValue})`), asc(rules.id))
      .all(),
    structural,
    defaults: {
      outrosId: need(CATEGORY_OUTROS),
      receitasId: need(CATEGORY_RECEITAS),
      internalId: need(CATEGORY_INTERNAL),
    },
  };
}

/**
 * Record a user's manual decision, then re-resolve everything so the change is
 * reflected immediately.
 */
export function setOverride(
  db: DB,
  fingerprint: string,
  patch: { categoryId?: number | null; isInternal?: boolean | null; note?: string | null },
  now = new Date().toISOString(),
): void {
  const existing = db
    .select()
    .from(transactionOverrides)
    .where(eq(transactionOverrides.fingerprint, fingerprint))
    .get();

  db.insert(transactionOverrides)
    .values({
      fingerprint,
      categoryId: patch.categoryId ?? existing?.categoryId ?? null,
      isInternal: patch.isInternal !== undefined ? patch.isInternal : (existing?.isInternal ?? null),
      note: patch.note ?? existing?.note ?? null,
      migratedFrom: existing?.migratedFrom ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: transactionOverrides.fingerprint,
      set: {
        ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
        ...(patch.isInternal !== undefined ? { isInternal: patch.isInternal } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        updatedAt: now,
      },
    })
    .run();
}

export function clearOverride(db: DB, fingerprint: string): void {
  db.delete(transactionOverrides).where(eq(transactionOverrides.fingerprint, fingerprint)).run();
}
