import { describe, it, expect } from 'vitest';
import type { DB } from '../db/client';
import { bills } from '../db/schema';
import { freshDb as makeDb, catId, addTx as insertTx } from '../db/testing';
import { getCardBreakdown, getCardCategoryTransactions, listCards } from './cards';
import { getMatrix } from './matrix';

function freshDb(): DB {
  return makeDb({
    accounts: [
      { id: 'acc-bank', type: 'BANK', name: 'Conta' },
      { id: 'nubank', type: 'CREDIT', name: 'Nubank', cardBrand: 'Mastercard', creditLimitCents: 1000000 },
      { id: 'itau', type: 'CREDIT', name: 'Itaú', cardBrand: 'Visa' },
    ],
  });
}

function addTx(db: DB, o: {
  accountId: string; postedOn: string; signedCents: number; category?: string;
  isInternal?: boolean; merchantName?: string; billId?: string; installments?: [number, number];
  purchaseDate?: string;
}) {
  return insertTx(db, { description: o.merchantName ?? 'COMPRA', ...o });
}

describe('category breakdown', () => {
  it('covers only credit card spending', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -10000, category: 'Mercado' });
    addTx(db, { accountId: 'acc-bank', postedOn: '2026-03-01', signedCents: -50000, category: 'Mercado' });

    const b = getCardBreakdown(db, { year: 2026 });

    expect(b.totalCents).toBe(10000);
    expect(b.byCategory).toHaveLength(1);
  });

  it('ranks categories by spend and computes their share', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -30000, category: 'Mercado' });
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-02', signedCents: -10000, category: 'Restaurante' });

    const b = getCardBreakdown(db, { year: 2026 });

    expect(b.byCategory.map((c) => c.name)).toEqual(['Mercado', 'Restaurante']);
    expect(b.byCategory[0]!.share).toBeCloseTo(0.75);
    expect(b.byCategory.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1);
  });

  it('narrows to a single month when asked', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -10000, category: 'Mercado' });
    addTx(db, { accountId: 'nubank', postedOn: '2026-04-01', signedCents: -20000, category: 'Mercado' });

    expect(getCardBreakdown(db, { year: 2026, month: '2026-03' }).totalCents).toBe(10000);
    expect(getCardBreakdown(db, { year: 2026 }).totalCents).toBe(30000);
  });

  it('excludes the bill payment, so purchases are not double-counted', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -10000, category: 'Mercado' });
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-20', signedCents: 10000, isInternal: true });
    expect(getCardBreakdown(db, { year: 2026 }).totalCents).toBe(10000);
  });

  it('labels uncategorized card spending rather than dropping it', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -10000 });
    const b = getCardBreakdown(db, { year: 2026 });
    expect(b.byCategory[0]!.name).toBe('Sem categoria');
    expect(b.totalCents).toBe(10000);
  });
});

describe('per-card summary', () => {
  it('splits spending across cards and carries their metadata', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -30000, category: 'Mercado' });
    addTx(db, { accountId: 'itau', postedOn: '2026-03-01', signedCents: -10000, category: 'Mercado' });

    const b = getCardBreakdown(db, { year: 2026 });

    expect(b.byCard.map((c) => c.name)).toEqual(['Nubank', 'Itaú']);
    expect(b.byCard[0]!.cents).toBe(30000);
    expect(b.byCard[0]!.brand).toBe('Mastercard');
    expect(b.byCard.reduce((s, c) => s + c.cents, 0)).toBe(b.totalCents);
  });

  it('lists the cards themselves', () => {
    expect(listCards(freshDb()).map((c) => c.name)).toEqual(['Itaú', 'Nubank']);
  });
});

describe('per-bill totals', () => {
  it('reports what we charged alongside what the bill says', () => {
    const db = freshDb();
    db.insert(bills).values({ id: 'b1', accountId: 'nubank', dueDate: '2026-03-20', totalAmountCents: 40000 }).run();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -30000, category: 'Mercado', billId: 'b1' });
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-02', signedCents: -10000, category: 'Restaurante', billId: 'b1' });

    const [bill] = getCardBreakdown(db, { year: 2026 }).byBill;

    expect(bill!.chargedCents).toBe(40000);
    expect(bill!.reportedTotalCents).toBe(40000);
    expect(bill!.count).toBe(2);
  });

  it('still groups transactions that carry no bill id', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -10000, category: 'Mercado' });
    const [bill] = getCardBreakdown(db, { year: 2026 }).byBill;
    expect(bill!.billId).toBeNull();
    expect(bill!.chargedCents).toBe(10000);
  });
});

describe('top merchants', () => {
  it('ranks by spend, falling back to the description', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -30000, merchantName: 'iFood' });
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-05', signedCents: -20000, merchantName: 'iFood' });
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-06', signedCents: -10000, merchantName: 'Uber' });

    const top = getCardBreakdown(db, { year: 2026 }).topMerchants;

    expect(top[0]).toMatchObject({ name: 'iFood', cents: 50000, count: 2 });
    expect(top[1]).toMatchObject({ name: 'Uber', cents: 10000 });
  });
});

describe('installments', () => {
  it('counts only the installment billed this month, never the full purchase', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -10000, category: 'Compras', installments: [3, 10] });
    expect(getCardBreakdown(db, { year: 2026 }).totalCents).toBe(10000);
  });

});

describe('consistency with the monthly matrix', () => {
  // The two views read the same rows with the same exclusions, so a card-only
  // month must agree exactly. If these ever diverge, one of them is lying.
  it('agrees with the matrix when all spending is on cards', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -30000, category: 'Mercado' });
    addTx(db, { accountId: 'itau', postedOn: '2026-03-02', signedCents: -10000, category: 'Restaurante' });
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-20', signedCents: 5000, isInternal: true });

    const cards = getCardBreakdown(db, { year: 2026, month: '2026-03' });
    const matrixMarch = getMatrix(db, 2026).monthTotals[2]!;

    expect(cards.totalCents).toBe(matrixMarch);
  });
});

describe('card category drill-down', () => {
  it('lists the card transactions behind a category', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -10000, category: 'Mercado', merchantName: 'Pão de Açúcar' });
    addTx(db, { accountId: 'itau', postedOn: '2026-03-05', signedCents: -5000, category: 'Mercado', merchantName: 'Hortifruti' });
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-06', signedCents: -9900, category: 'Restaurante' });

    const rows = getCardCategoryTransactions(db, { year: 2026, categoryId: catId(db, 'Mercado') });

    expect(rows.map((r) => r.merchantName)).toEqual(['Pão de Açúcar', 'Hortifruti']);
    expect(rows.map((r) => r.cents)).toEqual([10000, 5000]);
  });

  // If these two disagree, the page is lying about one of them.
  it('sums to exactly the category row it came from', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -10000, category: 'Mercado' });
    addTx(db, { accountId: 'itau', postedOn: '2026-05-05', signedCents: -5000, category: 'Mercado' });

    const breakdown = getCardBreakdown(db, { year: 2026 });
    const row = breakdown.byCategory.find((c) => c.name === 'Mercado')!;
    const rows = getCardCategoryTransactions(db, { year: 2026, categoryId: catId(db, 'Mercado') });

    expect(rows.reduce((s, r) => s + r.cents, 0)).toBe(row.cents);
    expect(rows).toHaveLength(row.count);
  });

  it('excludes bank spending, matching the rest of the page', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -10000, category: 'Mercado' });
    addTx(db, { accountId: 'acc-bank', postedOn: '2026-03-02', signedCents: -50000, category: 'Mercado' });

    const rows = getCardCategoryTransactions(db, { year: 2026, categoryId: catId(db, 'Mercado') });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.cents).toBe(10000);
  });

  it('narrows to a single month when the page is showing one', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -10000, category: 'Mercado' });
    addTx(db, { accountId: 'nubank', postedOn: '2026-04-01', signedCents: -20000, category: 'Mercado' });

    expect(getCardCategoryTransactions(db, { year: 2026, month: '2026-03', categoryId: catId(db, 'Mercado') })).toHaveLength(1);
    expect(getCardCategoryTransactions(db, { year: 2026, categoryId: catId(db, 'Mercado') })).toHaveLength(2);
  });

  it('excludes internal movements, matching the rest of the page', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-20', signedCents: 120000, category: 'Mercado', isInternal: true });
    expect(getCardCategoryTransactions(db, { year: 2026, categoryId: catId(db, 'Mercado') })).toEqual([]);
  });

  // The "Sem categoria" row is clickable too, and it is the one you most want to open.
  it('opens the uncategorized row', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -7700 });
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-02', signedCents: -1000, category: 'Mercado' });

    const rows = getCardCategoryTransactions(db, { year: 2026, categoryId: null });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.cents).toBe(7700);
  });

  it('labels installments', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -48990, category: 'Carro', installments: [6, 10] });
    expect(getCardCategoryTransactions(db, { year: 2026, categoryId: catId(db, 'Carro') })[0]!.installment).toBe('6/10');
  });
});
