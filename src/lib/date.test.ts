import { describe, it, expect } from 'vitest';
import {
  toLocalDate,
  toMonth,
  monthsOfYear,
  addDays,
  isYmd,
  addMonths,
  daysInMonth,
  dateInMonth,
  dayOfMonth,
  daysBetween,
  monthsBetween,
  recentMonths,
} from './date';

describe('toLocalDate', () => {
  // Pluggy's dominant case: midnight UTC standing in for a local calendar date.
  // These MUST pass through verbatim, or a transaction lands in the previous month.
  it('passes exact midnight UTC through verbatim', () => {
    expect(toLocalDate('2026-03-01T00:00:00.000Z')).toBe('2026-03-01');
    expect(toLocalDate('2026-01-01T00:00:00.000Z')).toBe('2026-01-01');
    expect(toLocalDate('2025-12-31T00:00:00.000Z')).toBe('2025-12-31');
  });

  it('accepts midnight written without milliseconds', () => {
    expect(toLocalDate('2026-03-01T00:00:00Z')).toBe('2026-03-01');
    expect(toLocalDate('2026-03-01T00:00:00+00:00')).toBe('2026-03-01');
  });

  it('accepts a bare date with no time component', () => {
    expect(toLocalDate('2026-03-01')).toBe('2026-03-01');
  });

  // Genuine instants convert to America/Sao_Paulo (UTC-3, no DST since 2019).
  it('shifts a real timestamp into Sao Paulo local time', () => {
    // 02:00Z is 23:00 the PREVIOUS day in Sao Paulo.
    expect(toLocalDate('2026-03-01T02:00:00.000Z')).toBe('2026-02-28');
    // 03:00Z is exactly midnight local, same day.
    expect(toLocalDate('2026-03-01T03:00:00.000Z')).toBe('2026-03-01');
    // Afternoon stays on the same day.
    expect(toLocalDate('2026-03-01T18:30:00.000Z')).toBe('2026-03-01');
  });

  it('handles the year boundary', () => {
    expect(toLocalDate('2026-01-01T02:00:00.000Z')).toBe('2025-12-31');
    expect(toLocalDate('2026-01-01T00:00:00.000Z')).toBe('2026-01-01');
    expect(toLocalDate('2025-12-31T23:00:00.000Z')).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(toLocalDate('2028-02-29T00:00:00.000Z')).toBe('2028-02-29');
    expect(toLocalDate('2028-03-01T01:00:00.000Z')).toBe('2028-02-29');
  });

  it('rejects unparseable input rather than silently returning a wrong date', () => {
    expect(() => toLocalDate('not-a-date')).toThrow();
    expect(() => toLocalDate('')).toThrow();
  });
});

describe('toMonth', () => {
  it('extracts YYYY-MM', () => {
    expect(toMonth('2026-03-01')).toBe('2026-03');
    expect(toMonth('2026-12-31')).toBe('2026-12');
  });
});

describe('monthsOfYear', () => {
  it('returns twelve zero-padded months in order', () => {
    const m = monthsOfYear(2026);
    expect(m).toHaveLength(12);
    expect(m[0]).toBe('2026-01');
    expect(m[8]).toBe('2026-09');
    expect(m[11]).toBe('2026-12');
  });
});

describe('addDays', () => {
  it('adds and subtracts without timezone drift', () => {
    expect(addDays('2026-03-01', 1)).toBe('2026-03-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-03-01', -45)).toBe('2026-01-15');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('is stable across a would-be DST boundary', () => {
    // Brazil abolished DST in 2019; this guards against a naive local-time impl regardless.
    expect(addDays('2026-10-17', 1)).toBe('2026-10-18');
    expect(addDays('2026-02-14', 1)).toBe('2026-02-15');
  });
});

describe('isYmd', () => {
  it('accepts well-formed dates and rejects the rest', () => {
    expect(isYmd('2026-03-01')).toBe(true);
    expect(isYmd('2026-3-1')).toBe(false);
    expect(isYmd('2026-03-01T00:00:00Z')).toBe(false);
    expect(isYmd('')).toBe(false);
  });
});

describe('addMonths', () => {
  it('steps forward and back across year boundaries', () => {
    expect(addMonths('2026-09', 1)).toBe('2026-10');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-09', 4)).toBe('2027-01');
    expect(addMonths('2026-09', -9)).toBe('2025-12');
  });

  it('returns the same month for a zero step', () => {
    expect(addMonths('2026-09', 0)).toBe('2026-09');
  });

  it('rejects anything that is not YYYY-MM', () => {
    expect(() => addMonths('2026-09-15', 1)).toThrow();
    expect(() => addMonths('2026-9', 1)).toThrow();
  });
});

describe('daysInMonth', () => {
  it('knows month lengths, including leap Februaries', () => {
    expect(daysInMonth('2026-01')).toBe(31);
    expect(daysInMonth('2026-04')).toBe(30);
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2028-02')).toBe(29);
  });
});

describe('dateInMonth', () => {
  it('builds a date from a month and a day', () => {
    expect(dateInMonth('2026-10', 3)).toBe('2026-10-03');
    expect(dateInMonth('2026-10', 15)).toBe('2026-10-15');
  });

  // A card that bills on the 31st still bills in November, on the 30th.
  it('clamps a day past the end of the month', () => {
    expect(dateInMonth('2026-11', 31)).toBe('2026-11-30');
    expect(dateInMonth('2026-02', 31)).toBe('2026-02-28');
    expect(dateInMonth('2028-02', 30)).toBe('2028-02-29');
  });
});

describe('dayOfMonth', () => {
  it('reads the day component', () => {
    expect(dayOfMonth('2026-10-03')).toBe(3);
    expect(dayOfMonth('2026-10-31')).toBe(31);
  });

  it('rejects anything that is not YYYY-MM-DD', () => {
    expect(() => dayOfMonth('2026-10')).toThrow();
  });
});

describe('daysBetween', () => {
  it('returns a signed day count', () => {
    expect(daysBetween('2026-10-03', '2026-09-15')).toBe(18);
    expect(daysBetween('2026-09-15', '2026-10-03')).toBe(-18);
    expect(daysBetween('2026-09-15', '2026-09-15')).toBe(0);
  });

  it('spans a year boundary', () => {
    expect(daysBetween('2027-01-03', '2026-12-03')).toBe(31);
  });
});

describe('monthsBetween', () => {
  it('counts whole months, signed', () => {
    expect(monthsBetween('2026-09', '2026-09')).toBe(0);
    expect(monthsBetween('2026-09', '2026-10')).toBe(1);
    expect(monthsBetween('2026-09', '2027-01')).toBe(4);
    expect(monthsBetween('2026-10', '2026-09')).toBe(-1);
  });

  it('spans years', () => {
    expect(monthsBetween('2025-12', '2026-12')).toBe(12);
  });
});

describe('recentMonths', () => {
  it('returns the n months ending at the given one, oldest first', () => {
    expect(recentMonths('2026-09', 3)).toEqual(['2026-07', '2026-08', '2026-09']);
  });

  it('crosses a year boundary', () => {
    expect(recentMonths('2026-02', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('returns nothing for a count of zero', () => {
    expect(recentMonths('2026-09', 0)).toEqual([]);
  });
});
