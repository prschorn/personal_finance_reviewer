import { and, asc, eq, gte, isNull, lte, sql, desc } from 'drizzle-orm';
import type { DB } from '../db/client';
import { getDb } from '../db/client';
import { accounts, categories, transactions } from '../db/schema';
import { monthsOfYear, type Ym } from '../lib/date';

/**
 * The month-by-category matrix — the view this app exists to produce.
 *
 * SIGN CONVENTION, applied here and nowhere else: `cents` is a POSITIVE magnitude
 * of spending, matching the spreadsheet. Internally `signed_cents` is negative for
 * money out, so this layer negates it exactly once. A category that took in more
 * than it spent (a refund month) legitimately shows negative.
 */

export interface MatrixCell {
  cents: number;
  count: number;
}

export interface MatrixRow {
  categoryId: number;
  name: string;
  cells: MatrixCell[]; // always 12, January..December
  total: number;
}

export interface Matrix {
  year: number;
  months: Ym[];
  rows: MatrixRow[];
  /** Expenses per month, as positive magnitudes. */
  monthTotals: number[];
  grandTotal: number;
  /**
   * Income per month, from categories of kind `income` only — NOT from the sign of
   * the amount. Money arriving on an expense category is a refund and nets against
   * that category's spending; treating it as income would overstate both sides.
   * Investment movement never appears here at all: it is excluded as internal.
   */
  incomeTotals: number[];
  incomeGrandTotal: number;
  /** Income minus expenses. Negative means the month ran at a loss. */
  balanceTotals: number[];
  balanceGrandTotal: number;
  /** Months with at least one transaction, so the UI can dim the rest. */
  monthsWithData: boolean[];
}

/**
 * Spending only: income and internal-movement categories are excluded, and
 * `is_internal` rows never count regardless of their category.
 */
export function getMatrix(db: DB = getDb(), year: number): Matrix {
  const months = monthsOfYear(year);

  const cats = db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(and(eq(categories.kind, 'expense'), eq(categories.archived, false)))
    .orderBy(asc(categories.sortOrder))
    .all();

  const incomeCategoryIds = new Set(
    db.select({ id: categories.id }).from(categories).where(eq(categories.kind, 'income')).all().map((c) => c.id),
  );

  const aggregates = db
    .select({
      categoryId: transactions.categoryId,
      month: transactions.month,
      cents: sql<number>`sum(${transactions.signedCents})`,
      count: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(
      and(
        isNull(transactions.deletedAt),
        eq(transactions.isInternal, false),
        gte(transactions.month, months[0]!),
        lte(transactions.month, months[11]!),
      ),
    )
    .groupBy(transactions.categoryId, transactions.month)
    .all();

  const lookup = new Map<string, { cents: number; count: number }>();
  for (const a of aggregates) {
    lookup.set(`${a.categoryId}|${a.month}`, { cents: a.cents, count: a.count });
  }

  const monthTotals = new Array<number>(12).fill(0);
  const monthCounts = new Array<number>(12).fill(0);
  const incomeTotals = new Array<number>(12).fill(0);

  // Income comes from the same aggregate as expenses — same rows, same exclusions —
  // so the two halves of the balance can never be computed from different data.
  const monthIndex = new Map(months.map((m, i) => [m, i]));
  for (const a of aggregates) {
    if (a.categoryId == null || !incomeCategoryIds.has(a.categoryId)) continue;
    const i = monthIndex.get(a.month);
    if (i === undefined) continue;
    incomeTotals[i] = (incomeTotals[i] ?? 0) + a.cents; // already positive for money in
    monthCounts[i] = (monthCounts[i] ?? 0) + a.count;
  }

  // Dense: every category gets all twelve cells, so rows never reshuffle between
  // months the way they would if empty cells were omitted.
  const rows: MatrixRow[] = cats.map((cat) => {
    const cells = months.map((month, i) => {
      const hit = lookup.get(`${cat.id}|${month}`);
      const cents = hit ? -hit.cents : 0; // negate once: spending shown positive
      const count = hit?.count ?? 0;
      monthTotals[i] = (monthTotals[i] ?? 0) + cents;
      monthCounts[i] = (monthCounts[i] ?? 0) + count;
      return { cents, count };
    });
    return {
      categoryId: cat.id,
      name: cat.name,
      cells,
      total: cells.reduce((sum, c) => sum + c.cents, 0),
    };
  });

  const balanceTotals = incomeTotals.map((income, i) => income - (monthTotals[i] ?? 0));

  return {
    year,
    months,
    rows,
    monthTotals,
    grandTotal: monthTotals.reduce((a, b) => a + b, 0),
    incomeTotals,
    incomeGrandTotal: incomeTotals.reduce((a, b) => a + b, 0),
    balanceTotals,
    balanceGrandTotal: balanceTotals.reduce((a, b) => a + b, 0),
    monthsWithData: monthCounts.map((n) => n > 0),
  };
}

/** Years that actually contain data, newest first. */
export function getAvailableYears(db: DB = getDb()): number[] {
  const rows = db
    .select({ year: sql<string>`substr(${transactions.month}, 1, 4)` })
    .from(transactions)
    .where(and(isNull(transactions.deletedAt), eq(transactions.isInternal, false)))
    .groupBy(sql`substr(${transactions.month}, 1, 4)`)
    .all();
  const years = rows.map((r) => Number(r.year)).filter(Number.isFinite).sort((a, b) => b - a);
  return years.length ? years : [new Date().getFullYear()];
}

/**
 * Which year to open on.
 *
 * NOT simply the newest year with data: credit card installments are scheduled
 * months ahead, so a purchase split over ten payments puts rows in next year and
 * would otherwise open the app on a near-empty grid of future commitments.
 * Prefer the current year whenever it has anything at all.
 */
export function getDefaultYear(db: DB = getDb(), now = new Date()): number {
  const years = getAvailableYears(db);
  const current = now.getFullYear();
  if (years.includes(current)) return current;
  // Otherwise the most recent year that is not in the future, else the oldest.
  return years.find((y) => y <= current) ?? years[years.length - 1] ?? current;
}

export interface DrillDownRow {
  id: string;
  fingerprint: string;
  postedOn: string;
  description: string | null;
  merchantName: string | null;
  cents: number;
  accountName: string | null;
  accountType: string;
  status: string;
  categorySource: string | null;
  installment: string | null;
}

/**
 * The transactions behind one cell.
 *
 * Ships alongside the matrix deliberately: without it there is no way to check a
 * figure, and an unverifiable number is not worth having.
 */
export function getCellTransactions(
  db: DB = getDb(),
  params: { month: Ym; categoryId: number },
): DrillDownRow[] {
  return db
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
      categorySource: transactions.categorySource,
      ccInstallmentNumber: transactions.ccInstallmentNumber,
      ccTotalInstallments: transactions.ccTotalInstallments,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(
        isNull(transactions.deletedAt),
        eq(transactions.isInternal, false),
        eq(transactions.month, params.month),
        eq(transactions.categoryId, params.categoryId),
      ),
    )
    .orderBy(asc(transactions.postedOn), desc(transactions.signedCents))
    .all()
    .map((r) => ({
      id: r.id,
      fingerprint: r.fingerprint,
      postedOn: r.postedOn,
      description: r.description,
      merchantName: r.merchantName,
      cents: -r.signedCents,
      accountName: r.accountName,
      accountType: r.accountType,
      status: r.status,
      categorySource: r.categorySource,
      installment:
        r.ccTotalInstallments && r.ccTotalInstallments > 1
          ? `${r.ccInstallmentNumber ?? '?'}/${r.ccTotalInstallments}`
          : null,
    }));
}

/**
 * Transactions no rule classified — the review queue.
 *
 * Covers BOTH directions. Unmatched spending distorts a category; unmatched money
 * in silently becomes income, which is how an insurance refund ends up flattering
 * the year. Neither should be invisible.
 */
export function getUncategorized(db: DB = getDb(), limit = 200): DrillDownRow[] {
  return db
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
      categorySource: transactions.categorySource,
      ccInstallmentNumber: transactions.ccInstallmentNumber,
      ccTotalInstallments: transactions.ccTotalInstallments,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(
        isNull(transactions.deletedAt),
        eq(transactions.isInternal, false),
        eq(transactions.categorySource, 'default'),
      ),
    )
    .orderBy(desc(transactions.postedOn))
    .limit(limit)
    .all()
    .map((r) => ({
      id: r.id,
      fingerprint: r.fingerprint,
      postedOn: r.postedOn,
      description: r.description,
      merchantName: r.merchantName,
      cents: -r.signedCents,
      accountName: r.accountName,
      accountType: r.accountType,
      status: r.status,
      categorySource: r.categorySource,
      installment:
        r.ccTotalInstallments && r.ccTotalInstallments > 1
          ? `${r.ccInstallmentNumber ?? '?'}/${r.ccTotalInstallments}`
          : null,
    }));
}
