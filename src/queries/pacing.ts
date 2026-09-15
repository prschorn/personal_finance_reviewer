import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { getDb } from '../db/client';
import { categories, transactions } from '../db/schema';
import { addMonths, dayOfMonth, recentMonths, toMonth, today as todayIn, type Ym } from '../lib/date';
import { median, quantile } from '../lib/stats';

/**
 * How this month is going, against the only reference that means anything: the
 * same stretch of your own previous months.
 *
 * The comparison is month-to-day-D against month-to-day-D, never a whole month
 * prorated. Prorating assumes spending is spread evenly through a month, and it
 * is not — the condo lands on the 1st and the electricity bill mid-month, so on
 * day 2 a prorated reference would report the condo at 400% of "expected" every
 * single month. Cutting both sides at the same day assumes nothing.
 *
 * Nothing here is a judgement. Half of all months sit above a median by
 * construction, which is why the band matters as much as the figure.
 */

export type PacingConfidence = 'boa' | 'fraca' | 'nenhuma';

/** Of six baseline months, how many must have data before a median is a reference. */
export const GOOD_BASELINE_MONTHS = 4;
export const MIN_BASELINE_MONTHS = 2;
export const BASELINE_MONTHS = 6;

export interface PacingInput {
  categoryId: number;
  name: string;
  /** Cumulative cents through day D, one entry per baseline month that had spending. */
  baseline: number[];
  currentCents: number;
}

export interface PacingRow {
  categoryId: number;
  name: string;
  currentCents: number;
  /** Null when too little history to be a reference. Never a number from one month. */
  medianCents: number | null;
  share: number | null;
  deltaCents: number | null;
  baselineMonths: number;
  confidence: PacingConfidence;
  /** p25..p75 — where the middle half of your months fell by this day. */
  lowCents: number | null;
  highCents: number | null;
}

export interface Pacing {
  month: Ym;
  day: number;
  rows: PacingRow[];
  totalCurrentCents: number;
  totalMedianCents: number | null;
  baselineMonths: Ym[];
}

function confidenceOf(months: number): PacingConfidence {
  if (months >= GOOD_BASELINE_MONTHS) return 'boa';
  return months >= MIN_BASELINE_MONTHS ? 'fraca' : 'nenhuma';
}

/** PURE. */
export function buildPacing(
  inputs: readonly PacingInput[],
  month: Ym,
  day: number,
  baselineMonths: Ym[],
): Pacing {
  const rows: PacingRow[] = inputs.map((input) => {
    const confidence = confidenceOf(input.baseline.length);
    const medianCents = confidence === 'nenhuma' ? null : Math.round(median(input.baseline)!);

    return {
      categoryId: input.categoryId,
      name: input.name,
      currentCents: input.currentCents,
      medianCents,
      share: medianCents ? input.currentCents / medianCents : null,
      deltaCents: medianCents === null ? null : input.currentCents - medianCents,
      baselineMonths: input.baseline.length,
      confidence,
      lowCents: medianCents === null ? null : Math.round(quantile(input.baseline, 0.25)!),
      highCents: medianCents === null ? null : Math.round(quantile(input.baseline, 0.75)!),
    };
  });

  // By how much, not by how many times over: a 300% overshoot on R$ 12 is noise.
  // Rows with no reference sink to the bottom rather than sorting as zero.
  rows.sort((a, b) => {
    if ((a.deltaCents === null) !== (b.deltaCents === null)) return a.deltaCents === null ? 1 : -1;
    return (b.deltaCents ?? 0) - (a.deltaCents ?? 0) || b.currentCents - a.currentCents;
  });

  const withReference = rows.filter((r) => r.medianCents !== null);

  return {
    month,
    day,
    rows,
    totalCurrentCents: rows.reduce((sum, r) => sum + r.currentCents, 0),
    totalMedianCents: withReference.length
      ? withReference.reduce((sum, r) => sum + r.medianCents!, 0)
      : null,
    baselineMonths,
  };
}

export function getPacing(db: DB = getDb(), now: Date = new Date()): Pacing {
  const asOf = todayIn(now);
  const month = toMonth(asOf);
  const day = dayOfMonth(asOf);
  const baselineMonths = recentMonths(addMonths(month, -1), BASELINE_MONTHS);

  const rows = db
    .select({
      categoryId: transactions.categoryId,
      name: categories.name,
      month: transactions.month,
      cents: sql<number>`sum(-${transactions.signedCents})`,
    })
    .from(transactions)
    .innerJoin(categories, eq(categories.id, transactions.categoryId))
    .where(
      and(
        // The idx_tx_matrix predicates, repeated so this hits the same index.
        isNull(transactions.deletedAt),
        eq(transactions.isInternal, false),
        eq(categories.kind, 'expense'),
        gte(transactions.month, baselineMonths[0]!),
        lte(transactions.month, month),
        // Both sides cut at the same day. A 30-day month contributes its whole
        // total "as of day 31", which is exactly right — it has no day 31.
        sql`CAST(substr(${transactions.postedOn}, 9, 2) AS INTEGER) <= ${day}`,
      ),
    )
    .groupBy(transactions.categoryId, transactions.month)
    .all();

  const byCategory = new Map<number, { name: string; baseline: number[]; currentCents: number }>();
  for (const row of rows) {
    const entry = byCategory.get(row.categoryId!) ?? { name: row.name, baseline: [], currentCents: 0 };
    if (row.month === month) entry.currentCents = row.cents;
    else entry.baseline.push(row.cents);
    byCategory.set(row.categoryId!, entry);
  }

  const inputs: PacingInput[] = [...byCategory.entries()].map(([categoryId, entry]) => ({
    categoryId,
    name: entry.name,
    baseline: entry.baseline,
    currentCents: entry.currentCents,
  }));

  return buildPacing(inputs, month, day, baselineMonths);
}
