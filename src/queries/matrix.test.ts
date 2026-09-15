import { describe, it, expect } from 'vitest';
import type { DB } from '../db/client';
import { categories } from '../db/schema';
import { freshDb, catId, addTx } from '../db/testing';
import { getMatrix, getCellTransactions, getAvailableYears, getDefaultYear, getUncategorized } from './matrix';

function rowFor(m: ReturnType<typeof getMatrix>, name: string) {
  return m.rows.find((r) => r.name === name)!;
}

describe('shape', () => {
  it('is dense: every expense category, twelve months', () => {
    const db = freshDb();
    const m = getMatrix(db, 2026);
    const expenseCount = db.select().from(categories).all().filter((c) => c.kind === 'expense').length;
    expect(m.rows).toHaveLength(expenseCount);
    for (const row of m.rows) expect(row.cells).toHaveLength(12);
    expect(m.months[0]).toBe('2026-01');
    expect(m.months[11]).toBe('2026-12');
  });

  it('keeps categories in spreadsheet order', () => {
    const db = freshDb();
    const names = getMatrix(db, 2026).rows.map((r) => r.name);
    expect(names.slice(0, 3)).toEqual(['Condomínio', 'Apartamento', 'Luz']);
  });

  it('omits income and internal categories from the rows', () => {
    const db = freshDb();
    const names = getMatrix(db, 2026).rows.map((r) => r.name);
    expect(names).not.toContain('Receitas');
    expect(names).not.toContain('Transferências internas');
  });
});

describe('aggregation', () => {
  it('shows spending as a positive magnitude, like the spreadsheet', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-10', signedCents: -25090, category: 'Mercado' });
    const m = getMatrix(db, 2026);
    expect(rowFor(m, 'Mercado').cells[2]!.cents).toBe(25090);
  });

  it('sums several transactions into one cell', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-01', signedCents: -10000, category: 'Mercado' });
    addTx(db, { postedOn: '2026-03-20', signedCents: -15000, category: 'Mercado' });
    const cell = rowFor(getMatrix(db, 2026), 'Mercado').cells[2]!;
    expect(cell.cents).toBe(25000);
    expect(cell.count).toBe(2);
  });

  it('files each transaction in the correct month column', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-01-31', signedCents: -100, category: 'Mercado' });
    addTx(db, { postedOn: '2026-12-01', signedCents: -200, category: 'Mercado' });
    const row = rowFor(getMatrix(db, 2026), 'Mercado');
    expect(row.cells[0]!.cents).toBe(100);
    expect(row.cells[11]!.cents).toBe(200);
  });

  it('lets a refund show as negative net spending', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-01', signedCents: -10000, category: 'Compras' });
    addTx(db, { postedOn: '2026-03-05', signedCents: 15000, category: 'Compras' });
    expect(rowFor(getMatrix(db, 2026), 'Compras').cells[2]!.cents).toBe(-5000);
  });

  it('scopes strictly to the requested year', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2025-12-31', signedCents: -100, category: 'Mercado' });
    addTx(db, { postedOn: '2027-01-01', signedCents: -200, category: 'Mercado' });
    expect(rowFor(getMatrix(db, 2026), 'Mercado').total).toBe(0);
  });
});

describe('exclusions', () => {
  it('excludes internal movements', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-10', signedCents: -120000, category: 'Outros', isInternal: true });
    expect(getMatrix(db, 2026).grandTotal).toBe(0);
  });

  it('excludes soft-deleted transactions', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-10', signedCents: -5000, category: 'Mercado', deleted: true });
    expect(getMatrix(db, 2026).grandTotal).toBe(0);
  });
});

describe('totals', () => {
  it('reconcile across rows, columns and the grand total', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-01-10', signedCents: -10000, category: 'Mercado' });
    addTx(db, { postedOn: '2026-02-10', signedCents: -20000, category: 'Mercado' });
    addTx(db, { postedOn: '2026-02-15', signedCents: -5000, category: 'Restaurante' });

    const m = getMatrix(db, 2026);

    expect(rowFor(m, 'Mercado').total).toBe(30000);
    expect(m.monthTotals[0]).toBe(10000);
    expect(m.monthTotals[1]).toBe(25000);
    expect(m.grandTotal).toBe(35000);
    expect(m.rows.reduce((s, r) => s + r.total, 0)).toBe(m.grandTotal);
    expect(m.monthTotals.reduce((a, b) => a + b, 0)).toBe(m.grandTotal);
  });

  it('marks which months have data', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-10', signedCents: -100, category: 'Mercado' });
    const m = getMatrix(db, 2026);
    expect(m.monthsWithData[2]).toBe(true);
    expect(m.monthsWithData[3]).toBe(false);
  });

  it('is all zeros for an empty database', () => {
    const m = getMatrix(freshDb(), 2026);
    expect(m.grandTotal).toBe(0);
    expect(m.rows.every((r) => r.total === 0)).toBe(true);
  });
});

describe('drill-down', () => {
  it('returns the transactions behind a cell', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-10', signedCents: -10000, category: 'Mercado', description: 'PAO DE ACUCAR' });
    addTx(db, { postedOn: '2026-03-12', signedCents: -5000, category: 'Mercado', description: 'HORTIFRUTI' });
    addTx(db, { postedOn: '2026-03-12', signedCents: -9999, category: 'Restaurante' });

    const rows = getCellTransactions(db, { month: '2026-03', categoryId: catId(db, 'Mercado') });

    expect(rows.map((r) => r.description)).toEqual(['PAO DE ACUCAR', 'HORTIFRUTI']);
    expect(rows.map((r) => r.cents)).toEqual([10000, 5000]);
  });

  // The drill-down must reconcile with the cell, or the matrix cannot be trusted.
  it('sums to exactly the cell it came from', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-10', signedCents: -10000, category: 'Mercado' });
    addTx(db, { postedOn: '2026-03-12', signedCents: -5000, category: 'Mercado' });

    const cell = rowFor(getMatrix(db, 2026), 'Mercado').cells[2]!;
    const rows = getCellTransactions(db, { month: '2026-03', categoryId: catId(db, 'Mercado') });

    expect(rows.reduce((s, r) => s + r.cents, 0)).toBe(cell.cents);
    expect(rows).toHaveLength(cell.count);
  });

  it('applies the same exclusions as the matrix', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-10', signedCents: -100, category: 'Mercado', deleted: true });
    addTx(db, { postedOn: '2026-03-11', signedCents: -200, category: 'Mercado', isInternal: true });
    expect(getCellTransactions(db, { month: '2026-03', categoryId: catId(db, 'Mercado') })).toEqual([]);
  });

  it('labels installments', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-10', signedCents: -10000, category: 'Compras', accountId: 'acc-card', installments: [3, 10] });
    const [row] = getCellTransactions(db, { month: '2026-03', categoryId: catId(db, 'Compras') });
    expect(row!.installment).toBe('3/10');
  });

  it('leaves a single-payment purchase unlabelled', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-10', signedCents: -10000, category: 'Compras' });
    const [row] = getCellTransactions(db, { month: '2026-03', categoryId: catId(db, 'Compras') });
    expect(row!.installment).toBeNull();
  });
});

describe('review queue', () => {
  // Both directions matter now that income is counted: unmatched money in becomes
  // Receitas, which is how a refund ends up flattering the year.
  it('lists unclassified money in as well as unclassified spending', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-10', signedCents: 57779, category: 'Receitas', categorySource: 'default', description: 'ESTORNO SEGURO' });
    addTx(db, { postedOn: '2026-03-11', signedCents: -4500, category: 'Outros', categorySource: 'default', description: 'MISTERIO' });

    const queue = getUncategorized(db);

    expect(queue.map((r) => r.description).sort()).toEqual(['ESTORNO SEGURO', 'MISTERIO']);
  });

  it('still excludes anything a rule already classified', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-10', signedCents: 2250000, category: 'PJ', categorySource: 'rule', description: 'SCHORN CONSULTORIA' });
    expect(getUncategorized(db)).toEqual([]);
  });

  it('lists only rows the rules could not classify', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-10', signedCents: -100, category: 'Outros', categorySource: 'default', description: 'MISTERIO' });
    addTx(db, { postedOn: '2026-03-11', signedCents: -200, category: 'Mercado', categorySource: 'rule' });
    const queue = getUncategorized(db);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.description).toBe('MISTERIO');
  });
});

describe('year selector', () => {
  it('lists years containing data, newest first', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2025-06-01', signedCents: -100, category: 'Mercado' });
    addTx(db, { postedOn: '2026-03-01', signedCents: -100, category: 'Mercado' });
    expect(getAvailableYears(db)).toEqual([2026, 2025]);
  });

  it('falls back to the current year when empty', () => {
    expect(getAvailableYears(freshDb())).toEqual([new Date().getFullYear()]);
  });
});

describe('default year', () => {
  const NOW = new Date('2026-09-15T12:00:00.000Z');

  // Card installments are scheduled months ahead, so the newest year with data can
  // be a future one holding nothing but commitments. Opening there shows an empty grid.
  it('prefers the current year over a future year of installments', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-01', signedCents: -100, category: 'Mercado' });
    addTx(db, { postedOn: '2027-01-03', signedCents: -500, category: 'Compras' });

    expect(getAvailableYears(db)[0]).toBe(2027);
    expect(getDefaultYear(db, NOW)).toBe(2026);
  });

  it('falls back to the most recent past year when the current one is empty', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2025-06-01', signedCents: -100, category: 'Mercado' });
    addTx(db, { postedOn: '2027-01-03', signedCents: -500, category: 'Compras' });
    expect(getDefaultYear(db, NOW)).toBe(2025);
  });

  it('uses a future year only when there is nothing else', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2027-01-03', signedCents: -500, category: 'Compras' });
    expect(getDefaultYear(db, NOW)).toBe(2027);
  });
});

describe('income and balance', () => {
  it('counts income from income-kind categories', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-05', signedCents: 2250000, category: 'PJ' });
    addTx(db, { postedOn: '2026-03-10', signedCents: -50000, category: 'Mercado' });

    const m = getMatrix(db, 2026);

    expect(m.incomeTotals[2]).toBe(2250000);
    expect(m.monthTotals[2]).toBe(50000);
    expect(m.balanceTotals[2]).toBe(2200000);
  });

  // The finding that drove this design: money arriving on an EXPENSE category is a
  // refund. Counting it as income would inflate both income and the balance.
  it('treats money arriving on an expense category as a refund, not income', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-10', signedCents: -100000, category: 'Compras' });
    addTx(db, { postedOn: '2026-03-15', signedCents: 30000, category: 'Compras' }); // estorno

    const m = getMatrix(db, 2026);

    expect(m.incomeTotals[2]).toBe(0);
    expect(m.monthTotals[2]).toBe(70000); // netted against the category
    expect(m.balanceTotals[2]).toBe(-70000);
  });

  it('excludes internal movement from both sides', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-05', signedCents: 500000, category: 'Receitas', isInternal: true });
    addTx(db, { postedOn: '2026-03-06', signedCents: -500000, category: 'Outros', isInternal: true });

    const m = getMatrix(db, 2026);

    expect(m.incomeTotals[2]).toBe(0);
    expect(m.monthTotals[2]).toBe(0);
    expect(m.balanceTotals[2]).toBe(0);
  });

  it('reports a negative balance when a month spends more than it earns', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-04-05', signedCents: 100000, category: 'PJ' });
    addTx(db, { postedOn: '2026-04-10', signedCents: -250000, category: 'Apartamento' });
    expect(getMatrix(db, 2026).balanceTotals[3]).toBe(-150000);
  });

  it('reconciles year totals with the monthly columns', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-01-05', signedCents: 1000000, category: 'PJ' });
    addTx(db, { postedOn: '2026-02-05', signedCents: 1500000, category: 'PJ' });
    addTx(db, { postedOn: '2026-02-10', signedCents: -400000, category: 'Mercado' });

    const m = getMatrix(db, 2026);

    expect(m.incomeGrandTotal).toBe(2500000);
    expect(m.incomeGrandTotal).toBe(m.incomeTotals.reduce((a, b) => a + b, 0));
    expect(m.balanceGrandTotal).toBe(m.incomeGrandTotal - m.grandTotal);
    expect(m.balanceGrandTotal).toBe(m.balanceTotals.reduce((a, b) => a + b, 0));
  });

  it('keeps income out of the expense rows', () => {
    const db = freshDb();
    addTx(db, { postedOn: '2026-03-05', signedCents: 2250000, category: 'PJ' });
    const m = getMatrix(db, 2026);
    expect(m.rows.map((r) => r.name)).not.toContain('PJ');
    expect(m.grandTotal).toBe(0);
  });
});
