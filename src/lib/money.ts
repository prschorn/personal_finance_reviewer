/**
 * Money is stored as integer centavos, never as REAL.
 *
 * SQLite REAL is an IEEE-754 double: summing a few hundred of them drifts in the
 * fourth decimal, and `WHERE amount = 1234.56` becomes unreliable — which matters
 * because the credit-card bill matcher compares amounts for equality. BRL has
 * exactly two decimal places, so centavos are lossless.
 *
 * Conversion happens here and nowhere else.
 */

export function toCents(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Not a monetary value: ${value}`);
  }
  // Round the scaled value, then round again to shave off representation error
  // (e.g. 1.005 * 100 === 100.49999999999999).
  return Math.round(Number((value * 100).toFixed(4)));
}

export function fromCents(cents: number): number {
  return cents / 100;
}

export function sumCents(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatBRL(cents: number): string {
  return BRL.format(fromCents(cents));
}
