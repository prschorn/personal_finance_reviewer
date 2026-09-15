import { describe, it, expect } from 'vitest';
import { freshDb, addTx } from '../db/testing';
import { buildPacing, getPacing, type PacingInput } from './pacing';

const AS_OF = '2026-09';
const BASELINE = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];

function input(over: Partial<PacingInput> = {}): PacingInput {
  return { categoryId: 1, name: 'Mercado', baseline: [1000, 1000, 1000, 1000, 1000, 1000], currentCents: 620, ...over };
}

describe('buildPacing', () => {
  it('compares the month so far against the median of the same stretch', () => {
    const pacing = buildPacing([input()], AS_OF, 15, BASELINE);

    const row = pacing.rows[0]!;
    expect(row.medianCents).toBe(1000);
    expect(row.currentCents).toBe(620);
    expect(row.share).toBeCloseTo(0.62, 5);
    expect(row.deltaCents).toBe(-380);
    expect(row.confidence).toBe('boa');
  });

  it('reports the band the middle half of months fell in', () => {
    const row = buildPacing([input({ baseline: [400, 600, 800, 1000, 1200, 1400] })], AS_OF, 15, BASELINE).rows[0]!;
    expect(row.lowCents).toBe(650);
    expect(row.highCents).toBe(1150);
  });

  // Four of six months is enough to recognise a figure. Two or three is a hint.
  it('calls a short history short instead of hiding it', () => {
    const row = buildPacing([input({ baseline: [1000, 1200] })], AS_OF, 15, BASELINE).rows[0]!;
    expect(row.confidence).toBe('fraca');
    expect(row.medianCents).toBe(1100);
  });

  // A percentage derived from one month is a number pretending to be a reference.
  it('refuses to compare against a single month', () => {
    const row = buildPacing([input({ baseline: [1000] })], AS_OF, 15, BASELINE).rows[0]!;
    expect(row.confidence).toBe('nenhuma');
    expect(row.medianCents).toBeNull();
    expect(row.share).toBeNull();
    expect(row.deltaCents).toBeNull();
  });

  it('refuses to compare against no history at all', () => {
    const row = buildPacing([input({ baseline: [] })], AS_OF, 15, BASELINE).rows[0]!;
    expect(row.confidence).toBe('nenhuma');
    expect(row.medianCents).toBeNull();
  });

  // A 300% overshoot on R$ 12 is noise; R$ 400 over on Mercado is the story.
  it('ranks by how much more was spent, not by how many times over', () => {
    const pacing = buildPacing(
      [
        input({ categoryId: 1, name: 'Pequena', baseline: [1200, 1200, 1200, 1200], currentCents: 4800 }),
        input({ categoryId: 2, name: 'Mercado', baseline: [100000, 100000, 100000, 100000], currentCents: 140000 }),
      ],
      AS_OF,
      15,
      BASELINE,
    );
    expect(pacing.rows.map((r) => r.name)).toEqual(['Mercado', 'Pequena']);
  });

  it('puts categories with no reference last, whatever they spent', () => {
    const pacing = buildPacing(
      [
        input({ categoryId: 1, name: 'Sem base', baseline: [], currentCents: 900000 }),
        input({ categoryId: 2, name: 'Com base', baseline: [1000, 1000, 1000, 1000], currentCents: 1100 }),
      ],
      AS_OF,
      15,
      BASELINE,
    );
    expect(pacing.rows.map((r) => r.name)).toEqual(['Com base', 'Sem base']);
  });

  it('totals the month so far and the months it is being compared against', () => {
    const pacing = buildPacing(
      [
        input({ categoryId: 1, baseline: [1000, 1000, 1000, 1000], currentCents: 600 }),
        input({ categoryId: 2, baseline: [2000, 2000, 2000, 2000], currentCents: 2500 }),
      ],
      AS_OF,
      15,
      BASELINE,
    );
    expect(pacing.totalCurrentCents).toBe(3100);
    expect(pacing.totalMedianCents).toBe(3000);
  });

  it('leaves the totals out when nothing has a reference', () => {
    const pacing = buildPacing([input({ baseline: [] })], AS_OF, 15, BASELINE);
    expect(pacing.totalMedianCents).toBeNull();
  });

  it('carries the day and the month it is reporting on', () => {
    const pacing = buildPacing([], AS_OF, 15, BASELINE);
    expect(pacing.month).toBe(AS_OF);
    expect(pacing.day).toBe(15);
    expect(pacing.baselineMonths).toEqual(BASELINE);
    expect(pacing.rows).toEqual([]);
  });
});

// --- DB-backed ---------------------------------------------------------------

const NOW = new Date('2026-09-15T12:00:00.000Z');

describe('getPacing', () => {
  // Comparing a whole month against half a month is the obvious way to get this
  // wrong. Both sides are cut at the same day of the month.
  it('cuts every baseline month at the same day as today', () => {
    const db = freshDb();
    for (const m of ['2026-06', '2026-07', '2026-08']) {
      addTx(db, { accountId: 'acc-bank', postedOn: `${m}-10`, signedCents: -1000, category: 'Mercado' });
      addTx(db, { accountId: 'acc-bank', postedOn: `${m}-25`, signedCents: -9000, category: 'Mercado' }); // after day 15
    }
    addTx(db, { accountId: 'acc-bank', postedOn: '2026-09-10', signedCents: -1200, category: 'Mercado' });

    const row = getPacing(db, NOW).rows.find((r) => r.name === 'Mercado')!;

    expect(row.medianCents).toBe(1000); // not 10000
    expect(row.currentCents).toBe(1200);
  });

  it('ignores internal movements and deleted rows', () => {
    const db = freshDb();
    for (const m of ['2026-06', '2026-07', '2026-08', '2026-09']) {
      addTx(db, { accountId: 'acc-bank', postedOn: `${m}-10`, signedCents: -5000, category: 'Mercado', isInternal: true });
      addTx(db, { accountId: 'acc-bank', postedOn: `${m}-11`, signedCents: -7000, category: 'Mercado', deleted: true });
    }

    expect(getPacing(db, NOW).rows.find((r) => r.name === 'Mercado')).toBeUndefined();
  });

  it('leaves income categories out', () => {
    const db = freshDb();
    for (const m of ['2026-06', '2026-07', '2026-08', '2026-09']) {
      addTx(db, { accountId: 'acc-bank', postedOn: `${m}-10`, signedCents: 900000, category: 'Receitas' });
    }

    expect(getPacing(db, NOW).rows.find((r) => r.name === 'Receitas')).toBeUndefined();
  });

  it('reports the six months before this one as the baseline', () => {
    const pacing = getPacing(freshDb(), NOW);
    expect(pacing.month).toBe('2026-09');
    expect(pacing.day).toBe(15);
    expect(pacing.baselineMonths).toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
  });

  // A 30-day month has no day 31, so "as of day 31" is simply its whole total —
  // no clamping needed, and September must not read as empty next to August.
  it('treats a short month as complete when today is past its end', () => {
    const db = freshDb();
    const endOfMonth = new Date('2026-10-31T12:00:00.000Z');
    addTx(db, { accountId: 'acc-bank', postedOn: '2026-08-31', signedCents: -4000, category: 'Mercado' });
    addTx(db, { accountId: 'acc-bank', postedOn: '2026-09-30', signedCents: -4000, category: 'Mercado' });
    addTx(db, { accountId: 'acc-bank', postedOn: '2026-10-05', signedCents: -1000, category: 'Mercado' });

    const row = getPacing(db, endOfMonth).rows.find((r) => r.name === 'Mercado')!;

    expect(row.baselineMonths).toBe(2);
    expect(row.medianCents).toBe(4000);
    expect(row.currentCents).toBe(1000);
  });
});
