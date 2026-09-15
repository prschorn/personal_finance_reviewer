import { describe, it, expect } from 'vitest';
import { planWindows, isDeepScanDue, isStale, DEFAULT_RESCAN_DAYS } from './windows';

const base = { today: '2026-03-15', now: '2026-03-15T12:00:00.000Z' };

describe('first sync', () => {
  it('skips the incremental window and pulls the full history', () => {
    const plan = planWindows({}, base);
    expect(plan.isFirstSync).toBe(true);
    expect(plan.incremental).toBeNull();
    expect(plan.isDeepScan).toBe(true);
    expect(plan.rescan.dateFrom).toBe('2025-03-15'); // 365 days back
    expect(plan.rescan.dateTo).toBe('2026-03-16');
  });
});

describe('routine sync', () => {
  const state = { lastSuccessAt: '2026-03-15T06:00:00.000Z', lastDeepScanAt: '2026-03-10T00:00:00.000Z' };

  it('uses a bounded rescan window', () => {
    const plan = planWindows(state, base);
    expect(plan.isDeepScan).toBe(false);
    expect(plan.rescan.dateFrom).toBe('2026-01-29'); // 45 days back
    expect(plan.rescan.dateTo).toBe('2026-03-16');
  });

  it('backdates the incremental watermark by 24h to absorb clock skew', () => {
    const plan = planWindows(state, base);
    expect(plan.incremental?.createdAtFrom).toBe('2026-03-14T06:00:00.000Z');
  });

  it('covers a full card cycle plus slack', () => {
    const plan = planWindows(state, base);
    const days = (Date.parse(plan.rescan.dateTo) - Date.parse(plan.rescan.dateFrom)) / 86_400_000;
    expect(days).toBe(DEFAULT_RESCAN_DAYS + 1);
  });
});

describe('monthly deep scan', () => {
  it('widens the rescan to the full history when due', () => {
    const plan = planWindows(
      { lastSuccessAt: '2026-03-15T06:00:00.000Z', lastDeepScanAt: '2026-02-01T00:00:00.000Z' },
      base,
    );
    expect(plan.isDeepScan).toBe(true);
    expect(plan.rescan.dateFrom).toBe('2025-03-15');
    // Still incremental — a deep scan doesn't replace Window A.
    expect(plan.incremental).not.toBeNull();
  });

  it('is due when never run, and not due inside the interval', () => {
    expect(isDeepScanDue(null, '2026-03-15T00:00:00.000Z', 30)).toBe(true);
    expect(isDeepScanDue('2026-03-14T00:00:00.000Z', '2026-03-15T00:00:00.000Z', 30)).toBe(false);
    expect(isDeepScanDue('2026-02-13T00:00:00.000Z', '2026-03-15T00:00:00.000Z', 30)).toBe(true);
  });

  it('treats an unparseable timestamp as due rather than skipping forever', () => {
    expect(isDeepScanDue('garbage', '2026-03-15T00:00:00.000Z', 30)).toBe(true);
  });
});

describe('isStale', () => {
  it('drives the auto-sync-on-load decision', () => {
    const now = '2026-03-15T12:00:00.000Z';
    expect(isStale(null, now)).toBe(true);
    expect(isStale('2026-03-15T11:00:00.000Z', now)).toBe(false); // 1h old
    expect(isStale('2026-03-15T05:00:00.000Z', now)).toBe(true); // 7h old
    expect(isStale('2026-03-15T06:00:00.000Z', now)).toBe(true); // exactly 6h
  });
});
