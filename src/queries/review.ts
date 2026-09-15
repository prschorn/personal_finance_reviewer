import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { getDb } from '../db/client';
import { accounts, categories, transactions } from '../db/schema';
import { matchKeyFor } from '../categorize/learn';
import { getLastReviewedAt } from '../config/settings';
import { addDays, monthsBetween, toMonth, today as todayIn, type Ymd } from '../lib/date';
import { formatBRL } from '../lib/money';
import { getRecurring, STOPPED_AFTER_MONTHS } from './recurring';

/**
 * One list of everything worth a second look since you last looked.
 *
 * Derived on read. The only thing stored is the moment the queue was last cleared,
 * because that is the only fact the transaction table does not already contain —
 * `first_seen_at` is written once at insert and never updated, even by Pluggy's
 * delete-and-recreate, which makes it a true "new to this app" watermark.
 */

export type ReviewKind = 'duplicata' | 'valor-atipico' | 'sem-categoria' | 'preco-mudou' | 'serie-parou';

/** Integrity first, then money, then classification, then trends. */
const KIND_ORDER: ReviewKind[] = ['duplicata', 'valor-atipico', 'sem-categoria', 'preco-mudou', 'serie-parou'];

export const MAX_ITEMS = 60;
/** How far back to look on a first open, before anything has been reviewed. */
export const FIRST_RUN_DAYS = 14;

/** Beating your own record at a merchant by this much is hard to argue with. */
export const OUTLIER_MIN_RATIO = 2.5;
/** Below this, a large multiple is still a small amount. */
export const OUTLIER_MIN_CENTS = 5000;
/** One previous visit is not a history. */
export const OUTLIER_MIN_HISTORY = 3;

/**
 * How long a series-level fact stays news.
 *
 * A price change and a series going quiet are facts about a whole series, not
 * about a row that arrived — so the `first_seen_at` watermark cannot retire them,
 * and without a window they would come back every time the queue is cleared. A
 * queue that never empties stops being read. The permanent list lives on
 * Recorrentes; this page only carries what is recent.
 */
export const SERIES_NEWS_MONTHS = 2;

export interface ReviewItem {
  kind: ReviewKind;
  id: string;
  title: string;
  /** One sentence of evidence, so the claim can be judged rather than trusted. */
  detail: string;
  cents: number | null;
  postedOn: Ymd | null;
  /** Ordering within a kind; lower first. Ties fall back to the larger amount. */
  rank: number;
  /** Present when the row can be recategorized in place. */
  fingerprint: string | null;
  categoryId: number | null;
  /**
   * The category's name, needed by the confirm control — it reads "Confirmar
   * Mercado". Null on items that are not about a category.
   */
  categoryName: string | null;
  href: string | null;
}

export interface ReviewQueue {
  /** Always shown, so the window being reported on is never a mystery. */
  since: Ymd;
  sinceAt: string;
  items: ReviewItem[];
  counts: Record<ReviewKind, number>;
  total: number;
  truncated: boolean;
}

export interface OutlierRow {
  fingerprint: string;
  postedOn: Ymd;
  label: string;
  cents: number;
  previousMaxCents: number;
  previousCount: number;
  ratio: number;
}

/**
 * Charges far above anything previously spent at the same merchant.
 *
 * Compared against the previous MAXIMUM, not the median: beating the largest you
 * have ever spent somewhere by 2.5× is a claim that survives argument, whereas
 * beating the median happens roughly half the time and would bury the queue.
 */
export function getOutliers(
  db: DB = getDb(),
  opts: { since: string; minRatio?: number; minCents?: number },
): OutlierRow[] {
  const minRatio = opts.minRatio ?? OUTLIER_MIN_RATIO;
  const minCents = opts.minCents ?? OUTLIER_MIN_CENTS;

  const rows = db
    .select({
      fingerprint: transactions.fingerprint,
      postedOn: transactions.postedOn,
      description: transactions.description,
      merchantName: transactions.merchantName,
      ccTotalInstallments: transactions.ccTotalInstallments,
      signedCents: transactions.signedCents,
      firstSeenAt: transactions.firstSeenAt,
    })
    .from(transactions)
    .where(
      and(
        isNull(transactions.deletedAt),
        eq(transactions.isInternal, false),
        lt(transactions.signedCents, 0),
        // An installment row is a fraction of a purchase, never a spike.
        sql`(${transactions.ccTotalInstallments} IS NULL OR ${transactions.ccTotalInstallments} <= 1)`,
      ),
    )
    .all();

  const history = new Map<string, number[]>();
  for (const row of rows) {
    const key = matchKeyFor(row);
    if (!key) continue;
    const seen = history.get(key);
    if (seen) seen.push(Math.abs(row.signedCents));
    else history.set(key, [Math.abs(row.signedCents)]);
  }

  const out: OutlierRow[] = [];
  for (const row of rows) {
    if (row.firstSeenAt <= opts.since) continue;
    const key = matchKeyFor(row);
    if (!key) continue;

    const cents = Math.abs(row.signedCents);
    if (cents < minCents) continue;

    const previous = history.get(key)!.slice();
    previous.splice(previous.indexOf(cents), 1);
    if (previous.length < OUTLIER_MIN_HISTORY) continue;

    const previousMaxCents = Math.max(...previous);
    const ratio = cents / previousMaxCents;
    if (ratio < minRatio) continue;

    out.push({
      fingerprint: row.fingerprint,
      postedOn: row.postedOn,
      label: row.merchantName ?? row.description ?? key,
      cents,
      previousMaxCents,
      previousCount: previous.length,
      ratio,
    });
  }

  return out.sort((a, b) => b.cents - a.cents);
}

function guessedRows(db: DB, since: string) {
  return db
    .select({
      fingerprint: transactions.fingerprint,
      postedOn: transactions.postedOn,
      description: transactions.description,
      merchantName: transactions.merchantName,
      signedCents: transactions.signedCents,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      categorySource: transactions.categorySource,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(
      and(
        isNull(transactions.deletedAt),
        eq(transactions.isInternal, false),
        gt(transactions.firstSeenAt, since),
        inArray(transactions.categorySource, ['default', 'pluggy']),
      ),
    )
    .orderBy(transactions.categorySource, transactions.postedOn)
    .all();
}

function duplicateRows(db: DB, since: string) {
  const repeated = db
    .select({ fingerprint: transactions.fingerprint })
    .from(transactions)
    .where(and(isNull(transactions.deletedAt), eq(transactions.isInternal, false)))
    .groupBy(transactions.fingerprint)
    .having(sql`count(*) > 1`)
    .all()
    .map((r) => r.fingerprint);

  if (!repeated.length) return [];

  return db
    .select({
      fingerprint: transactions.fingerprint,
      postedOn: transactions.postedOn,
      description: transactions.description,
      merchantName: transactions.merchantName,
      signedCents: transactions.signedCents,
      categoryId: transactions.categoryId,
      accountName: accounts.name,
      count: sql<number>`count(*)`,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(
        isNull(transactions.deletedAt),
        eq(transactions.isInternal, false),
        gt(transactions.firstSeenAt, since),
        inArray(transactions.fingerprint, repeated),
      ),
    )
    .groupBy(transactions.fingerprint)
    .orderBy(transactions.postedOn)
    .all();
}

export function getReviewQueue(db: DB = getDb(), now: Date = new Date()): ReviewQueue {
  const sinceAt = getLastReviewedAt(db) ?? `${addDays(todayIn(now), -FIRST_RUN_DAYS)}T00:00:00.000Z`;
  const items: ReviewItem[] = [];

  for (const row of duplicateRows(db, sinceAt)) {
    const label = row.merchantName ?? row.description ?? 'lançamento';
    items.push({
      kind: 'duplicata',
      rank: 0,
      id: `dup-${row.fingerprint}`,
      title: label,
      detail: `${row.count} lançamentos idênticos em ${row.accountName ?? 'conta'} — se for cobrança dupla, um total está errado.`,
      cents: Math.abs(row.signedCents),
      postedOn: row.postedOn,
      fingerprint: row.fingerprint,
      categoryId: row.categoryId,
      categoryName: null,
      href: '/transactions?filtro=duplicadas',
    });
  }

  for (const row of getOutliers(db, { since: sinceAt })) {
    items.push({
      kind: 'valor-atipico',
      rank: 0,
      id: `out-${row.fingerprint}`,
      title: row.label,
      detail: `${formatBRL(row.cents)} contra um máximo anterior de ${formatBRL(row.previousMaxCents)} em ${row.previousCount} cobranças.`,
      cents: row.cents,
      postedOn: row.postedOn,
      fingerprint: row.fingerprint,
      categoryId: null,
      categoryName: null,
      href: null,
    });
  }

  for (const row of guessedRows(db, sinceAt)) {
    items.push({
      kind: 'sem-categoria',
      // Nothing decided this at all, which is more urgent than the bank deciding it.
      rank: row.categorySource === 'default' ? 0 : 1,
      id: `cat-${row.fingerprint}`,
      title: row.merchantName ?? row.description ?? 'lançamento',
      detail:
        row.categorySource === 'default'
          ? `Caiu em ${row.categoryName ?? 'Outros'} sem nenhuma regra decidir.`
          : `A categoria ${row.categoryName ?? '—'} veio da Pluggy, não de uma regra sua.`,
      cents: Math.abs(row.signedCents),
      postedOn: row.postedOn,
      fingerprint: row.fingerprint,
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      href: null,
    });
  }

  const recurring = getRecurring(db, now);
  const asOfMonth = toMonth(todayIn(now));
  for (const series of recurring.outgoing) {
    if (series.priceChange && monthsBetween(series.priceChange.sinceMonth, asOfMonth) <= SERIES_NEWS_MONTHS) {
      const { fromCents, toCents, deltaShare } = series.priceChange;
      items.push({
        kind: 'preco-mudou',
        rank: 0,
        id: `price-${series.key}`,
        title: series.label,
        detail: `De ${formatBRL(fromCents)} para ${formatBRL(toCents)} (${deltaShare > 0 ? '+' : '−'}${Math.abs(Math.round(deltaShare * 100))}%), e ficou assim.`,
        cents: toCents,
        postedOn: null,
        fingerprint: series.latestFingerprint,
        categoryId: series.categoryId,
        categoryName: series.categoryName,
        href: '/recorrentes',
      });
    } else if (
      series.status === 'parada' &&
      monthsBetween(series.lastMonth, asOfMonth) <= STOPPED_AFTER_MONTHS + SERIES_NEWS_MONTHS
    ) {
      items.push({
        kind: 'serie-parou',
        rank: 0,
        id: `stop-${series.key}`,
        title: series.label,
        detail: `Vinha todo mês e não aparece desde ${series.lastMonth}. Cancelamento seu, ou não.`,
        cents: series.typicalCents,
        postedOn: null,
        fingerprint: series.latestFingerprint,
        categoryId: series.categoryId,
        categoryName: series.categoryName,
        href: '/recorrentes',
      });
    }
  }

  items.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.rank - b.rank ||
      (b.cents ?? 0) - (a.cents ?? 0),
  );

  const counts = Object.fromEntries(
    KIND_ORDER.map((kind) => [kind, items.filter((i) => i.kind === kind).length]),
  ) as Record<ReviewKind, number>;

  return {
    since: sinceAt.slice(0, 10),
    sinceAt,
    items: items.slice(0, MAX_ITEMS),
    counts,
    total: items.length,
    truncated: items.length > MAX_ITEMS,
  };
}
