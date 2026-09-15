import { describe, it, expect } from 'vitest';
import { median, quantile } from './stats';

describe('median', () => {
  it('takes the middle value of an odd-length set', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([7])).toBe(7);
  });

  it('averages the two middle values of an even-length set', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([10, 20])).toBe(15);
  });

  it('does not depend on input order', () => {
    expect(median([9, 1, 5, 3, 7])).toBe(median([1, 3, 5, 7, 9]));
  });

  it('does not mutate its input', () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });

  // A median of nothing is not zero — zero is a real amount and would read as a fact.
  it('returns null for an empty set', () => {
    expect(median([])).toBeNull();
  });
});

describe('quantile', () => {
  it('returns the bounds at 0 and 1', () => {
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
  });

  it('interpolates between neighbours', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10, 20, 30], 0.25)).toBe(15);
  });

  it('agrees with median at 0.5', () => {
    const values = [4, 9, 1, 7, 3];
    expect(quantile(values, 0.5)).toBe(median(values));
  });

  it('handles a single value', () => {
    expect(quantile([42], 0.9)).toBe(42);
  });

  it('returns null for an empty set', () => {
    expect(quantile([], 0.5)).toBeNull();
  });
});
