import { describe, it, expect } from 'vitest';
import type { DB } from '../db/client';
import { freshDb as makeDb, addTx as insertTx } from '../db/testing';
import { getMatrix } from './matrix';
import { buildDashboard, getDashboard, monthsToPlot, TOP_CATEGORIES } from './dashboard';

function freshDb(): DB {
  return makeDb({ accounts: [{ id: 'a', type: 'BANK' }] });
}

function addTx(db: DB, o: { postedOn: string; signedCents: number; category: string }) {
  return insertTx(db, { accountId: 'a', ...o });
}

/** A clock past the end of the year, so nothing is truncated as "not yet". */
const DEC = new Date('2026-12-31T12:00:00.000Z');

describe('monthsToPlot', () => {
  // Card installments are billed months ahead, so the tail of the current year
  // holds scheduled charges and no income. Plotting it reads as a collapse.
  it('stops at the current month for the current year', () => {
    expect(monthsToPlot(2026, new Date('2026-09-15T12:00:00.000Z'))).toBe(9);
    expect(monthsToPlot(2026, new Date('2026-01-05T12:00:00.000Z'))).toBe(1);
  });

  it('plots a whole past year', () => {
    expect(monthsToPlot(2025, new Date('2026-09-15T12:00:00.000Z'))).toBe(12);
  });
});

describe('income versus spending', () => {
  it('produces exactly two series, in fixed slots', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-05', signedCents: 1000000, category: 'PJ' });
    addTx(db, { postedOn: '2026-03-10', signedCents: -50000, category: 'Mercado' });

    const d = buildDashboard(getMatrix(db, 2026), DEC);

    expect(d.incomeVsSpending.map((s) => s.name)).toEqual(['Receitas', 'Gastos']);
    expect(d.incomeVsSpending[0]!.slot).toBe(0);
    expect(d.incomeVsSpending[1]!.slot).toBe(1);
    expect(d.incomeVsSpending[0]!.values[2]).toBe(1000000);
    expect(d.incomeVsSpending[1]!.values[2]).toBe(50000);
  });

  it('agrees with the matrix it came from', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-02-05', signedCents: 1000000, category: 'PJ' });
    addTx(db, { postedOn: '2026-05-10', signedCents: -300000, category: 'Mercado' });

    const m = getMatrix(db, 2026);
    const d = buildDashboard(m, DEC);

    expect(d.incomeTotal).toBe(m.incomeGrandTotal);
    expect(d.spendingTotal).toBe(m.grandTotal);
    expect(d.balanceTotal).toBe(m.balanceGrandTotal);
  });
});

describe('spending by category', () => {
  function manyCategories(db: DB) {
    const names = ['Mercado', 'Restaurante', 'Carro', 'Compras', 'Saúde', 'Viagem', 'Farmácia', 'Celular', 'Luz'];
    names.forEach((name, i) => {
      // Descending amounts so the ranking is unambiguous.
      addTx(db, { postedOn: '2026-03-10', signedCents: -(names.length - i) * 10000, category: name });
    });
    return names;
  }

  // Never more than the palette can carry: past the cap, the rest folds into one.
  it('caps the named series and folds the rest into Outras', () => {
    const db = freshDb();
    manyCategories(db);

    const d = buildDashboard(getMatrix(db, 2026), DEC);

    expect(d.byCategory).toHaveLength(TOP_CATEGORIES + 1);
    expect(d.byCategory.at(-1)!.name).toBe('Demais categorias');
  });

  it('puts the biggest categories first', () => {
    const db = freshDb();
    manyCategories(db);
    const d = buildDashboard(getMatrix(db, 2026), DEC);
    expect(d.byCategory[0]!.name).toBe('Mercado');
    expect(d.byCategory[1]!.name).toBe('Restaurante');
  });

  it('gives each series a distinct, fixed palette slot', () => {
    const db = freshDb();
    manyCategories(db);
    const slots = buildDashboard(getMatrix(db, 2026), DEC).byCategory.map((s) => s.slot);
    expect(slots).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(new Set(slots).size).toBe(slots.length);
  });

  // The fold-in is a real total, not a leftover: it must account for everything dropped.
  it('the fold-in carries the full remainder', () => {
    const db = freshDb();
    manyCategories(db);

    const d = buildDashboard(getMatrix(db, 2026), DEC);
    const plotted = d.byCategory.reduce((sum, s) => sum + s.values.reduce((a, b) => a + b, 0), 0);

    expect(plotted).toBe(d.spendingTotal);
  });

  it('omits the fold-in series when everything fits', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-10', signedCents: -10000, category: 'Mercado' });
    const d = buildDashboard(getMatrix(db, 2026), DEC);
    expect(d.byCategory.map((s) => s.name)).toEqual(['Mercado']);
  });

  it('leaves out categories with no spending at all', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-10', signedCents: -10000, category: 'Mercado' });
    expect(buildDashboard(getMatrix(db, 2026), DEC).byCategory.map((s) => s.name)).not.toContain('IPVA');
  });
});

describe('truncation', () => {
  it('cuts every series to the same length', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-05', signedCents: 500000, category: 'PJ' });
    addTx(db, { postedOn: '2026-03-10', signedCents: -50000, category: 'Mercado' });

    const d = buildDashboard(getMatrix(db, 2026), new Date('2026-09-15T12:00:00.000Z'));

    expect(d.months).toHaveLength(9);
    expect(d.monthLabels.at(-1)).toBe('set');
    for (const s of [...d.incomeVsSpending, ...d.byCategory]) expect(s.values).toHaveLength(9);
    expect(d.truncated).toBe(true);
  });

  // Spending scheduled into the tail of the year must not inflate the plotted total.
  it('excludes months beyond the cut from the totals', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-10', signedCents: -10000, category: 'Mercado' });
    addTx(db, { postedOn: '2026-12-10', signedCents: -99999, category: 'Mercado' });

    const d = buildDashboard(getMatrix(db, 2026), new Date('2026-09-15T12:00:00.000Z'));

    expect(d.spendingTotal).toBe(10000);
    expect(d.truncated).toBe(true);
  });

  it('plots a full past year', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2025-12-10', signedCents: -10000, category: 'Mercado' });
    const d = buildDashboard(getMatrix(db, 2025), new Date('2026-09-15T12:00:00.000Z'));
    expect(d.months).toHaveLength(12);
    expect(d.truncated).toBe(false);
  });
});

describe('empty year', () => {
  it('returns empty series rather than failing', () => {
    const d = getDashboard(freshDb(), 2026, DEC);
    expect(d.byCategory).toEqual([]);
    expect(d.spendingTotal).toBe(0);
    expect(d.incomeVsSpending[0]!.values.every((v) => v === 0)).toBe(true);
  });
});
