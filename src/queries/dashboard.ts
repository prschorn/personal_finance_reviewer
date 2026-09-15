import type { DB } from '../db/client';
import { getDb } from '../db/client';
import { getMatrix, type Matrix } from './matrix';
import type { Ym } from '../lib/date';

/**
 * Series for the dashboard charts, derived from the same matrix the monthly grid
 * renders. Nothing is queried twice, so a figure on a chart can never disagree
 * with the same figure in the table.
 */

export interface Series {
  name: string;
  /** One value per month in `months`, in centavos, as a positive magnitude. */
  values: number[];
  /** Index into the categorical palette. Fixed per entity, never by rank of the day. */
  slot: number;
}

export interface Dashboard {
  year: number;
  months: Ym[];
  monthLabels: string[];
  /** Income and spending, the two-line chart. */
  incomeVsSpending: [Series, Series];
  /** Top categories plus "Outras", the per-category chart. */
  byCategory: Series[];
  incomeTotal: number;
  spendingTotal: number;
  balanceTotal: number;
  /** True when the year was cut short because later months hold only scheduled charges. */
  truncated: boolean;
}

const MONTH_LABELS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** Seven series total: six named categories plus everything else. */
export const TOP_CATEGORIES = 6;

/**
 * How many months to plot.
 *
 * For the current year, stop at the current month. Card installments are billed
 * months ahead, so later columns hold scheduled charges and no income at all —
 * plotting them would drop the income line to zero and read as a collapse rather
 * than as "it hasn't happened yet". Future commitments live on the Cartões page.
 */
export function monthsToPlot(year: number, now = new Date()): number {
  if (year < now.getFullYear()) return 12;
  if (year > now.getFullYear()) return 1;
  return now.getMonth() + 1;
}

export function buildDashboard(matrix: Matrix, now = new Date()): Dashboard {
  const count = monthsToPlot(matrix.year, now);
  const months = matrix.months.slice(0, count);
  const cut = <T,>(xs: T[]) => xs.slice(0, count);

  // Ranked by the year's total, so the same category keeps the same colour as
  // months go by. Colour follows the entity; it is assigned once, here.
  const ranked = [...matrix.rows]
    .map((row) => ({ name: row.name, values: cut(row.cells.map((c) => c.cents)), total: cut(row.cells).reduce((s, c) => s + c.cents, 0) }))
    .filter((r) => r.total !== 0)
    .sort((a, b) => b.total - a.total);

  const top = ranked.slice(0, TOP_CATEGORIES);
  const rest = ranked.slice(TOP_CATEGORIES);

  const byCategory: Series[] = top.map((r, i) => ({ name: r.name, values: r.values, slot: i }));

  if (rest.length) {
    byCategory.push({
      // Not "Outras": the seeded catch-all category is called "Outros", and two
      // near-identical names in one legend is unreadable.
      name: 'Demais categorias',
      values: months.map((_, i) => rest.reduce((sum, r) => sum + (r.values[i] ?? 0), 0)),
      slot: TOP_CATEGORIES,
    });
  }

  return {
    year: matrix.year,
    months,
    monthLabels: MONTH_LABELS.slice(0, count),
    incomeVsSpending: [
      { name: 'Receitas', values: cut(matrix.incomeTotals), slot: 0 },
      { name: 'Gastos', values: cut(matrix.monthTotals), slot: 1 },
    ],
    byCategory,
    incomeTotal: cut(matrix.incomeTotals).reduce((a, b) => a + b, 0),
    spendingTotal: cut(matrix.monthTotals).reduce((a, b) => a + b, 0),
    balanceTotal: cut(matrix.balanceTotals).reduce((a, b) => a + b, 0),
    truncated: count < 12,
  };
}

export function getDashboard(db: DB = getDb(), year: number, now = new Date()): Dashboard {
  return buildDashboard(getMatrix(db, year), now);
}
