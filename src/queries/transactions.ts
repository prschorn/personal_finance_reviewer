import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { getDb } from '../db/client';
import { accounts, categories, transactions } from '../db/schema';
import { normalize } from '../lib/text';

export type TransactionFilter = 'todas' | 'sem-categoria' | 'nao-faturadas' | 'duplicadas';

export interface TransactionListRow {
  id: string;
  fingerprint: string;
  postedOn: string;
  description: string | null;
  merchantName: string | null;
  signedCents: number;
  accountName: string | null;
  accountType: string;
  status: string;
  categoryId: number | null;
  categoryName: string | null;
  categorySource: string | null;
  isInternal: boolean;
  installment: string | null;
}

export function listTransactions(
  db: DB = getDb(),
  opts: { filter?: TransactionFilter; search?: string; limit?: number } = {},
): TransactionListRow[] {
  const filter = opts.filter ?? 'todas';
  const search = normalize(opts.search ?? '');

  const conditions = [isNull(transactions.deletedAt)];
  if (filter === 'sem-categoria') conditions.push(eq(transactions.categorySource, 'default'));
  if (filter === 'nao-faturadas') conditions.push(eq(transactions.status, 'PENDING'));
  if (search) {
    const term = `%${search}%`;
    conditions.push(or(like(transactions.searchText, term), like(transactions.description, term))!);
  }

  const rows = db
    .select({
      id: transactions.id,
      fingerprint: transactions.fingerprint,
      postedOn: transactions.postedOn,
      description: transactions.description,
      merchantName: transactions.merchantName,
      signedCents: transactions.signedCents,
      accountName: accounts.name,
      accountType: accounts.type,
      status: transactions.status,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      categorySource: transactions.categorySource,
      isInternal: transactions.isInternal,
      ccInstallmentNumber: transactions.ccInstallmentNumber,
      ccTotalInstallments: transactions.ccTotalInstallments,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(and(...conditions))
    .orderBy(desc(transactions.postedOn), desc(transactions.id))
    .limit(opts.limit ?? 300)
    .all();

  const mapped = rows.map((r) => ({
    id: r.id,
    fingerprint: r.fingerprint,
    postedOn: r.postedOn,
    description: r.description,
    merchantName: r.merchantName,
    signedCents: r.signedCents,
    accountName: r.accountName,
    accountType: r.accountType,
    status: r.status,
    categoryId: r.categoryId,
    categoryName: r.categoryName,
    categorySource: r.categorySource,
    isInternal: r.isInternal,
    installment:
      r.ccTotalInstallments && r.ccTotalInstallments > 1
        ? `${r.ccInstallmentNumber ?? '?'}/${r.ccTotalInstallments}`
        : null,
  }));

  if (filter !== 'duplicadas') return mapped;

  // Same fingerprint on two live rows means a delete-and-recreate was not
  // reconciled, which would inflate a month invisibly. Surface it rather than
  // trusting the totals.
  const duplicated = new Set(
    db
      .select({ fingerprint: transactions.fingerprint })
      .from(transactions)
      .where(isNull(transactions.deletedAt))
      .groupBy(transactions.fingerprint)
      .having(sql`count(*) > 1`)
      .all()
      .map((r) => r.fingerprint),
  );
  return mapped.filter((r) => duplicated.has(r.fingerprint));
}

export function countByFilter(db: DB = getDb()) {
  const live = and(isNull(transactions.deletedAt));
  const count = (extra?: ReturnType<typeof eq>) =>
    db.select({ n: sql<number>`count(*)` }).from(transactions).where(extra ? and(live, extra) : live).get()?.n ?? 0;

  const duplicadas = db
    .select({ fingerprint: transactions.fingerprint })
    .from(transactions)
    .where(live)
    .groupBy(transactions.fingerprint)
    .having(sql`count(*) > 1`)
    .all().length;

  return {
    todas: count(),
    'sem-categoria': count(eq(transactions.categorySource, 'default')),
    'nao-faturadas': count(eq(transactions.status, 'PENDING')),
    duplicadas,
  };
}
