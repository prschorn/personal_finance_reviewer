/**
 * The small amount of statistics this app needs.
 *
 * Median rather than mean, everywhere. One atypical month — a holiday, an annual
 * insurance payment — moves a mean enough to make every comparison against it
 * wrong, and the whole point of comparing a month against your own history is that
 * the reference has to be one you would recognise.
 */

/** Null for an empty set: zero is a real amount and would read as a fact. */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Linear-interpolated quantile, `q` in 0..1.
 *
 * Used for the spread of a recurring charge, where the extremes are exactly the
 * noise you want to discount: p10..p90 says how much a bill really moves without
 * one refund month deciding the answer.
 */
export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  return lower === upper ? sorted[lower]! : sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (pos - lower);
}
