import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { getDb } from '../db/client';
import { accounts, categories, transactions } from '../db/schema';
import { matchKeyFor } from '../categorize/learn';
import { normalize, stripInstallmentSuffix } from '../lib/text';
import { addMonths, dayOfMonth, monthsBetween, toMonth, today as todayIn, type Ym, type Ymd } from '../lib/date';
import { median } from '../lib/stats';
import type { DrillDownRow } from './matrix';

/**
 * Charges that come back every month, found by their cadence rather than by name.
 *
 * The app already ships a rule listing ten subscription brands; that decides a
 * CATEGORY. This decides whether something RECURS, which is a different question
 * and finds services no list would contain. It reads category_id and never writes
 * it — nothing here changes a single figure elsewhere in the app.
 */

export type SeriesStatus = 'ativa' | 'nova' | 'parada';
export type AmountKind = 'fixo' | 'variavel';
export type Direction = 'saida' | 'entrada';

/** At least three months, and present in most of the months it spans. */
export const MIN_ACTIVE_MONTHS = 3;
export const MIN_COVERAGE = 0.6;
/** Below this, a change is rounding or FX jitter rather than a new price. */
export const PRICE_CHANGE_MIN_SHARE = 0.02;
/** A whole missed month, not merely a late one. */
export const STOPPED_AFTER_MONTHS = 2;
export const NEW_WITHIN_MONTHS = 2;
export const WINDOW_MONTHS = 18;

export interface CandidateRow {
  key: string;
  month: Ym;
  postedOn: Ymd;
  cents: number;
  fingerprint: string;
  description: string | null;
  merchantName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  accountName: string | null;
  direction: Direction;
}

export interface SeriesOccurrence {
  month: Ym;
  postedOn: Ymd;
  cents: number;
  count: number;
}

export interface PriceChange {
  fromCents: number;
  toCents: number;
  sinceMonth: Ym;
  /** (to − from) / from. Negative for a fall. */
  deltaShare: number;
}

export interface RecurringSeries {
  /** The grouping identity. Stable, but truncated — use `label` to show it. */
  key: string;
  label: string;
  categoryId: number | null;
  categoryName: string | null;
  accountNames: string[];
  direction: Direction;
  status: SeriesStatus;
  kind: AmountKind;
  /**
   * What it costs now. Median, never mean, so one double-billed month cannot move
   * it — and taken over the current price level only, so a rise that stuck is not
   * averaged away against the months before it.
   */
  typicalCents: number;
  expectedDay: number;
  firstMonth: Ym;
  lastMonth: Ym;
  activeMonths: number;
  spanMonths: number;
  coverage: number;
  priceChange: PriceChange | null;
  occurrences: SeriesOccurrence[];
  annualCents: number;
  latestFingerprint: string;
}

export interface RecurringReport {
  asOfMonth: Ym;
  outgoing: RecurringSeries[];
  incoming: RecurringSeries[];
  /**
   * Active outgoing series that have a PRICE — what is committed. A mortgage and a
   * restaurant you happen to visit monthly both recur, but only one of them will
   * bill the same amount again, and adding them together makes the figure useless.
   */
  monthlyTotalCents: number;
  annualTotalCents: number;
  /** Active outgoing series whose amount moves. A typical month, not a commitment. */
  variableMonthlyCents: number;
  /** Rows whose description was too short to group. Counted, never guessed at. */
  ungroupableCount: number;
}

/**
 * A name for a series.
 *
 * The grouping key is `matchKeyFor`'s output, which strips installment markers and
 * long digit runs and therefore truncates mid-word — stable as an identity, unusable
 * as a heading.
 */
export function seriesLabel(rows: readonly CandidateRow[]): string {
  const merchants = rows.map((r) => r.merchantName).filter((n): n is string => !!n?.trim());
  if (merchants.length) {
    const counts = new Map<string, number>();
    for (const name of merchants) counts.set(name, (counts.get(name) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  }

  // The statement truncates descriptions, so the longest one is the least truncated.
  const descriptions = rows
    .map((r) => stripInstallmentSuffix(normalize(r.description)).trim())
    .filter((d) => d.length > 0)
    .sort((a, b) => b.length - a.length);

  return descriptions[0] ?? rows[0]?.key ?? '';
}

/** Are two amounts the same price, allowing for rounding and FX jitter? */
function samePrice(a: number, b: number): boolean {
  if (!a) return !b;
  return Math.abs(b - a) / a <= PRICE_CHANGE_MIN_SHARE;
}

/** The run of consecutive amounts around `i` that are all the same price as `a[i]`. */
function runAround(amounts: readonly number[], i: number): { start: number; end: number } {
  let start = i;
  let end = i;
  while (start > 0 && samePrice(amounts[i]!, amounts[start - 1]!)) start--;
  while (end < amounts.length - 1 && samePrice(amounts[i]!, amounts[end + 1]!)) end++;
  return { start, end };
}

/**
 * The most recent price change that stuck.
 *
 * A jump only counts as a new price when the months on BOTH sides of it settled:
 * the new amount has to hold to the present, and the old one has to have been a
 * level rather than a single spike. Without the second half, a double charge
 * followed by a return to normal reads as a price cut — and feature D consumes
 * this signal, so one that cries wolf is worse than none at all.
 */
function findPriceChange(occurrences: readonly SeriesOccurrence[]): PriceChange | null {
  const amounts = occurrences.map((o) => o.cents);

  for (let i = amounts.length - 1; i >= 1; i--) {
    if (samePrice(amounts[i - 1]!, amounts[i]!)) continue;

    // The new price must still be the price today.
    const after = runAround(amounts, i);
    if (after.end !== amounts.length - 1) continue;

    // The old price must have been a price, not one odd month.
    const before = runAround(amounts, i - 1);
    if (before.start !== 0 && before.end - before.start + 1 < 2) continue;

    const from = amounts[i - 1]!;
    const to = amounts[i]!;
    return { fromCents: from, toCents: to, sinceMonth: occurrences[i]!.month, deltaShare: (to - from) / from };
  }

  return null;
}

/**
 * Does this charge have a price at all?
 *
 * Not the spread of the whole history — a genuine price rise widens that, which
 * would classify exactly the series worth flagging as "variable" and suppress its
 * own detection. What separates a subscription from an electricity bill is that
 * the subscription repeats last month's amount most months, whatever level it
 * happens to sit at.
 */
function amountKind(amounts: readonly number[]): AmountKind {
  if (amounts.length < 2) return 'fixo';
  const steady = amounts.slice(1).filter((cents, i) => samePrice(amounts[i]!, cents)).length;
  return steady / (amounts.length - 1) >= 0.5 ? 'fixo' : 'variavel';
}

function buildSeries(key: string, rows: CandidateRow[], asOfMonth: Ym): RecurringSeries | null {
  const byMonth = new Map<Ym, CandidateRow[]>();
  for (const row of rows) {
    const bucket = byMonth.get(row.month);
    if (bucket) bucket.push(row);
    else byMonth.set(row.month, [row]);
  }

  const months = [...byMonth.keys()].sort();
  const firstMonth = months[0]!;
  const lastMonth = months.at(-1)!;
  const activeMonths = months.length;
  const spanMonths = monthsBetween(firstMonth, lastMonth) + 1;
  const coverage = activeMonths / spanMonths;

  // The load-bearing gate. matchKeyFor groups on merchant name, which is coarse
  // enough that a restaurant you visit weekly has perfect monthly "cadence".
  // A subscription bills ONCE. Median, so one double-billed month is tolerated.
  const perMonth = median(months.map((m) => byMonth.get(m)!.length))!;
  if (perMonth !== 1) return null;

  const isNew =
    activeMonths >= 2 && monthsBetween(firstMonth, asOfMonth) <= NEW_WITHIN_MONTHS;
  const established = activeMonths >= MIN_ACTIVE_MONTHS && spanMonths >= MIN_ACTIVE_MONTHS && coverage >= MIN_COVERAGE;
  if (!established && !isNew) return null;

  const occurrences: SeriesOccurrence[] = months.map((month) => {
    const inMonth = byMonth.get(month)!;
    return {
      month,
      postedOn: inMonth.map((r) => r.postedOn).sort()[0]!,
      cents: inMonth.reduce((sum, r) => sum + r.cents, 0),
      count: inMonth.length,
    };
  });

  const amounts = occurrences.map((o) => o.cents);
  const kind = amountKind(amounts);
  const priceChange = kind === 'fixo' ? findPriceChange(occurrences) : null;

  // Price at the level it sits at NOW. Once a rise has stuck, the cheaper months
  // are history, and annualizing a median that still contains them projects a bill
  // that will never arrive again.
  const current = priceChange
    ? amounts.slice(occurrences.findIndex((o) => o.month === priceChange.sinceMonth))
    : amounts;
  const typicalCents = Math.round(median(current)!);

  const status: SeriesStatus = monthsBetween(lastMonth, asOfMonth) >= STOPPED_AFTER_MONTHS
    ? 'parada'
    : established
      ? 'ativa'
      : 'nova';

  const latest = byMonth.get(lastMonth)!;

  return {
    key,
    label: seriesLabel(rows),
    categoryId: latest[0]!.categoryId,
    categoryName: latest[0]!.categoryName,
    accountNames: [...new Set(rows.map((r) => r.accountName).filter((n): n is string => !!n))],
    direction: rows[0]!.direction,
    status,
    kind,
    typicalCents,
    expectedDay: Math.round(median(occurrences.map((o) => dayOfMonth(o.postedOn)))!),
    firstMonth,
    lastMonth,
    activeMonths,
    spanMonths,
    coverage,
    priceChange,
    occurrences,
    annualCents: typicalCents * 12,
    latestFingerprint: latest.at(-1)!.fingerprint,
  };
}

/**
 * Everything the detector is allowed to look at.
 *
 * `cc_total_installments > 1` is excluded deliberately: an installment plan has
 * perfect monthly cadence and near-identical amounts, so it is the single most
 * convincing false positive available. It is a finite purchase, and queries/today.ts
 * already accounts for it.
 */
function candidateScope(fromMonth: Ym, today: Ymd) {
  return and(
    isNull(transactions.deletedAt),
    eq(transactions.isInternal, false),
    gte(transactions.month, fromMonth),
    lt(transactions.postedOn, today),
    sql`(${transactions.ccTotalInstallments} IS NULL OR ${transactions.ccTotalInstallments} <= 1)`,
  );
}

/** PURE. The whole algorithm; the query below only feeds it rows. */
export function buildRecurring(
  rows: readonly CandidateRow[],
  asOfMonth: Ym,
  ungroupableCount = 0,
): RecurringReport {
  const groups = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    const groupKey = `${row.direction}|${row.key}`;
    const bucket = groups.get(groupKey);
    if (bucket) bucket.push(row);
    else groups.set(groupKey, [row]);
  }

  const series = [...groups.entries()]
    .map(([groupKey, group]) => buildSeries(groupKey.split('|').slice(1).join('|'), group, asOfMonth))
    .filter((s): s is RecurringSeries => s !== null)
    .sort((a, b) => b.annualCents - a.annualCents || a.label.localeCompare(b.label));

  const outgoing = series.filter((s) => s.direction === 'saida');
  const live = outgoing.filter((s) => s.status !== 'parada');
  const sum = (xs: RecurringSeries[]) => xs.reduce((total, s) => total + s.typicalCents, 0);
  const monthlyTotalCents = sum(live.filter((s) => s.kind === 'fixo'));

  return {
    asOfMonth,
    outgoing,
    incoming: series.filter((s) => s.direction === 'entrada'),
    monthlyTotalCents,
    annualTotalCents: monthlyTotalCents * 12,
    variableMonthlyCents: sum(live.filter((s) => s.kind === 'variavel')),
    ungroupableCount,
  };
}

// --- Database ----------------------------------------------------------------

/**
 * Grouping happens in JS because matchKeyFor is JS — there is no SQL expression
 * that strips an installment suffix the way the rest of the app does, and having
 * two definitions of "same merchant" is how the two would drift apart. One select
 * over a couple of thousand rows, then a group in memory.
 */
function candidates(db: DB, now: Date): { rows: CandidateRow[]; ungroupableCount: number } {
  const raw = db
    .select({
      month: transactions.month,
      postedOn: transactions.postedOn,
      signedCents: transactions.signedCents,
      fingerprint: transactions.fingerprint,
      description: transactions.description,
      merchantName: transactions.merchantName,
      ccTotalInstallments: transactions.ccTotalInstallments,
      categoryId: transactions.categoryId,
      categoryName: categories.name,
      accountName: accounts.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(candidateScope(addMonths(toMonth(todayIn(now)), -(WINDOW_MONTHS - 1)), todayIn(now)))
    .all();

  const rows: CandidateRow[] = [];
  let ungroupableCount = 0;

  for (const r of raw) {
    const key = matchKeyFor(r);
    if (!key) {
      ungroupableCount++;
      continue;
    }
    rows.push({
      key,
      month: r.month,
      postedOn: r.postedOn,
      cents: Math.abs(r.signedCents),
      fingerprint: r.fingerprint,
      description: r.description,
      merchantName: r.merchantName,
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      accountName: r.accountName,
      direction: r.signedCents < 0 ? 'saida' : 'entrada',
    });
  }

  return { rows, ungroupableCount };
}

export function getRecurring(db: DB = getDb(), now: Date = new Date()): RecurringReport {
  const { rows, ungroupableCount } = candidates(db, now);
  return buildRecurring(rows, toMonth(todayIn(now)), ungroupableCount);
}

/**
 * The transactions behind one series.
 *
 * Re-runs the same grouping rather than trying to express the key in SQL, so there
 * is exactly one definition of what belongs to a series and the rows can never
 * disagree with the figure that was clicked.
 */
export function getSeriesTransactions(
  db: DB = getDb(),
  params: { key: string },
  now: Date = new Date(),
): DrillDownRow[] {
  const fingerprints = new Set(
    candidates(db, now).rows.filter((r) => r.key === params.key).map((r) => r.fingerprint),
  );
  if (!fingerprints.size) return [];

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
    .where(isNull(transactions.deletedAt))
    .orderBy(transactions.postedOn, transactions.id)
    .all()
    .filter((r) => fingerprints.has(r.fingerprint))
    .map((r) => ({
      id: r.id,
      fingerprint: r.fingerprint,
      postedOn: r.postedOn,
      description: r.description,
      merchantName: r.merchantName,
      cents: Math.abs(r.signedCents),
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
