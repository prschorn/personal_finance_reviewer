import { describe, it, expect } from 'vitest';
import { toCents, fromCents, formatBRL, sumCents } from './money';

describe('toCents', () => {
  it('converts the floats Pluggy actually sends', () => {
    expect(toCents(123.45)).toBe(12345);
    expect(toCents(0)).toBe(0);
    expect(toCents(-89.9)).toBe(-8990);
    expect(toCents(1000)).toBe(100000);
  });

  // The entire reason this module exists.
  it('survives binary floating point representation error', () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(1.005)).toBe(101); // 1.005 is stored as 1.00499999...
    expect(toCents(8.165)).toBe(817);
    expect(toCents(1e6 + 0.07)).toBe(100000007);
  });

  it('rejects values that cannot be money', () => {
    expect(() => toCents(Number.NaN)).toThrow();
    expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('fromCents', () => {
  it('round-trips', () => {
    for (const v of [12345, 0, -8990, 1, -1]) {
      expect(toCents(fromCents(v))).toBe(v);
    }
  });
});

describe('sumCents', () => {
  it('stays exact over many values, unlike float addition', () => {
    const cents = Array.from({ length: 1000 }, () => 10); // R$ 0.10 x 1000
    expect(sumCents(cents)).toBe(10000); // exactly R$ 100.00
  });
});

describe('formatBRL', () => {
  it('formats cents as Brazilian currency', () => {
    // Intl uses a non-breaking space after R$; normalize it for comparison.
    const norm = (s: string) => s.replace(/ /g, ' ');
    expect(norm(formatBRL(12345))).toBe('R$ 123,45');
    expect(norm(formatBRL(0))).toBe('R$ 0,00');
    expect(norm(formatBRL(-8990))).toBe('-R$ 89,90');
    expect(norm(formatBRL(100000000))).toBe('R$ 1.000.000,00');
  });
});
