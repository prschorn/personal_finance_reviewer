import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { getDb } from '../db/client';
import { accounts, bills, categories, transactions } from '../db/schema';
import { monthsOfYear, type Ym } from '../lib/date';
import type { DrillDownRow } from './matrix';

/**
 * Credit card spending, broken down by category, by card and by bill.
 *
 * Same data and same exclusions as the monthly matrix, filtered to CREDIT
 * accounts — so the two views can never disagree. Bill payments are already
 * excluded as internal movements, meaning these figures are purchases, not
 * purchases plus the bill that settles them.
 *
 * Amounts are POSITIVE magnitudes of spending, as in queries/matrix.ts.
 */

export interface CardPeriod {
  year: number;
  /** Optional single month, e.g. '2026-03'. Omit for the whole year. */
  month?: Ym;
}

export interface CategoryBreakdownRow {
  categoryId: number | null;
  name: string;
  cents: number;
  count: number;
  /** Share of the period total, 0..1. */
  share: number;
}

export interface CardSummaryRow {
  accountId: string;
  name: string | null;
  brand: string | null;
  cents: number;
  count: number;
  balanceCents: number | null;
  creditLimitCents: number | null;
  availableCreditLimitCents: number | null;
  balanceDueDate: string | null;
  balanceCloseDate: string | null;
}

export interface BillSummaryRow {
  billId: string | null;
  accountId: string;
  accountName: string | null;
  dueDate: string | null;
  /** What Pluggy reports as the bill total, when bills are available. */
  reportedTotalCents: number | null;
  /** What our own transactions add up to for that bill. */
  chargedCents: number;
  count: number;
}

export interface MerchantRow {
  name: string;
  cents: number;
  count: number;
}

export interface CardBreakdown {
  period: CardPeriod;
  totalCents: number;
  byCategory: CategoryBreakdownRow[];
  byCard: CardSummaryRow[];
  byBill: BillSummaryRow[];
  topMerchants: MerchantRow[];
  /** Months in the year that have card activity, for the period selector. */
  monthsWithData: Ym[];
}

function periodBounds(period: CardPeriod): { from: Ym; to: Ym } {
  if (period.month) return { from: period.month, to: period.month };
  const months = monthsOfYear(period.year);
  return { from: months[0]!, to: months[11]! };
}

/** Shared predicate so every figure on the page has identical exclusions. */
function cardScope(period: CardPeriod) {
  const { from, to } = periodBounds(period);
  return and(
    isNull(transactions.deletedAt),
    eq(transactions.isInternal, false),
    eq(accounts.type, 'CREDIT'),
    gte(transactions.month, from),
    lte(transactions.month, to),
  );
}

export function getCardBreakdown(db: DB = getDb(), period: CardPeriod): CardBreakdown {
  const scope = cardScope(period);

  const byCategoryRaw = db
    .select({
      categoryId: transactions.categoryId,
      name: categories.name,
      cents: sql<number>`sum(${transactions.signedCents})`,
      count: sql<number>`count(*)`,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(scope)
    .groupBy(transactions.categoryId)
    .all();

  const byCategory = byCategoryRaw
    .map((r) => ({ categoryId: r.categoryId, name: r.name ?? 'Sem categoria', cents: -r.cents, count: r.count }))
    .sort((a, b) => b.cents - a.cents);

  const totalCents = byCategory.reduce((sum, r) => sum + r.cents, 0);

  const byCard = db
    .select({
      accountId: transactions.accountId,
      name: accounts.name,
      brand: accounts.cardBrand,
      cents: sql<number>`sum(${transactions.signedCents})`,
      count: sql<number>`count(*)`,
      balanceCents: accounts.balanceCents,
      creditLimitCents: accounts.creditLimitCents,
      availableCreditLimitCents: accounts.availableCreditLimitCents,
      balanceDueDate: accounts.balanceDueDate,
      balanceCloseDate: accounts.balanceCloseDate,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(scope)
    .groupBy(transactions.accountId)
    .all()
    .map((r) => ({ ...r, cents: -r.cents }))
    .sort((a, b) => b.cents - a.cents);

  // Per-bill totals: the figure that reconciles against the paper statement.
  const byBill = db
    .select({
      billId: transactions.ccBillId,
      accountId: transactions.accountId,
      accountName: accounts.name,
      chargedCents: sql<number>`sum(${transactions.signedCents})`,
      count: sql<number>`count(*)`,
      dueDate: bills.dueDate,
      reportedTotalCents: bills.totalAmountCents,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(bills, eq(bills.id, transactions.ccBillId))
    .where(scope)
    .groupBy(transactions.ccBillId, transactions.accountId)
    .all()
    .map((r) => ({ ...r, chargedCents: -r.chargedCents }))
    .sort((a, b) => (b.dueDate ?? '').localeCompare(a.dueDate ?? ''));

  const topMerchants = db
    .select({
      name: sql<string>`coalesce(${transactions.merchantName}, ${transactions.description}, '—')`,
      cents: sql<number>`sum(${transactions.signedCents})`,
      count: sql<number>`count(*)`,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(scope)
    .groupBy(sql`coalesce(${transactions.merchantName}, ${transactions.description}, '—')`)
    .all()
    .map((r) => ({ ...r, cents: -r.cents }))
    .sort((a, b) => b.cents - a.cents)
    .slice(0, 20);

  const monthsWithData = db
    .select({ month: transactions.month })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(cardScope({ year: period.year }))
    .groupBy(transactions.month)
    .orderBy(asc(transactions.month))
    .all()
    .map((r) => r.month);

  return {
    period,
    totalCents,
    byCategory: byCategory.map((r) => ({ ...r, share: totalCents === 0 ? 0 : r.cents / totalCents })),
    byCard,
    byBill,
    topMerchants,
    monthsWithData,
  };
}

/** The user's credit cards, for the cards page header. */
export function listCards(db: DB = getDb()) {
  return db
    .select()
    .from(accounts)
    .where(eq(accounts.type, 'CREDIT'))
    .orderBy(asc(accounts.name))
    .all();
}

/**
 * The card transactions behind one category row.
 *
 * Built from the SAME scope predicate as the breakdown itself, so the rows always
 * add up to the figure that was clicked. If these two ever diverge, the page is
 * lying about something.
 */
export function getCardCategoryTransactions(
  db: DB = getDb(),
  params: CardPeriod & { categoryId: number | null },
): DrillDownRow[] {
  const scope = cardScope(params);
  const categoryPredicate =
    params.categoryId == null
      ? isNull(transactions.categoryId)
      : eq(transactions.categoryId, params.categoryId);

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
    .where(and(scope, categoryPredicate))
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
