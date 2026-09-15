import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, type DB } from '../db/client';
import { runMigrations } from '../db/migrate';
import { seedCategories } from '../db/seed-categories';
import { accounts, bills, categories, items, transactions } from '../db/schema';
import { getCardBreakdown, getOpenInstallments, listCards } from './cards';
import { getMatrix } from './matrix';

function freshDb(): DB {
  const { db } = createTestDb();
  runMigrations(db);
  seedCategories(db);
  db.insert(items).values({ id: 'item-1' }).run();
  db.insert(accounts).values({ id: 'acc-bank', itemId: 'item-1', type: 'BANK', name: 'Conta' }).run();
  db.insert(accounts).values({ id: 'nubank', itemId: 'item-1', type: 'CREDIT', name: 'Nubank', cardBrand: 'Mastercard', creditLimitCents: 1000000 }).run();
  db.insert(accounts).values({ id: 'itau', itemId: 'item-1', type: 'CREDIT', name: 'Itaú', cardBrand: 'Visa' }).run();
  return db;
}

function catId(db: DB, name: string): number {
  return db.select().from(categories).where(eq(categories.name, name)).get()!.id;
}

let n = 0;
function addTx(db: DB, o: {
  accountId: string; postedOn: string; signedCents: number; category?: string;
  isInternal?: boolean; merchantName?: string; billId?: string; installments?: [number, number];
  purchaseDate?: string;
}) {
  const id = `tx-${++n}`;
  db.insert(transactions)
    .values({
      id, accountId: o.accountId, fingerprint: `fp-${id}`,
      dateUtc: `${o.postedOn}T00:00:00.000Z`, postedOn: o.postedOn,
      description: o.merchantName ?? 'COMPRA', searchText: 'COMPRA',
      merchantName: o.merchantName ?? null,
      amountCents: Math.abs(o.signedCents), signedCents: o.signedCents,
      status: 'POSTED', firstSeenAt: 'now', lastSeenRunId: 1, rawJson: '{}',
      categoryId: o.category ? catId(db, o.category) : null,
      categorySource: 'rule',
      isInternal: o.isInternal ?? false,
      ccBillId: o.billId ?? null,
      ccPurchaseDate: o.purchaseDate ?? null,
      ccInstallmentNumber: o.installments?.[0] ?? null,
      ccTotalInstallments: o.installments?.[1] ?? null,
    })
    .run();
  return id;
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

  it('reports what is still committed on an open purchase', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -10000, category: 'Compras', installments: [3, 10], purchaseDate: '2026-01-14' });
    const [open] = getOpenInstallments(db);
    expect(open!.remainingCents).toBe(70000); // 7 of 10 still to come
    expect(open!.remainingCount).toBe(7);
  });

  // Each billed installment is its own row. Computing "remaining" on every row and
  // summing would count one purchase's commitment once per installment already paid.
  it('counts a purchase once, however many installments have been billed', () => {
    const db = freshDb();
    for (let i = 1; i <= 7; i++) {
      addTx(db, {
        accountId: 'nubank', postedOn: `2026-0${i}-14`, signedCents: -10000,
        category: 'Compras', installments: [i, 10], purchaseDate: '2026-01-14',
      });
    }

    const open = getOpenInstallments(db);

    expect(open).toHaveLength(1);
    expect(open[0]!.installmentNumber).toBe(7);
    expect(open[0]!.remainingCents).toBe(30000); // 3 left, not 7 rows' worth
  });

  it('keeps separate purchases separate', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-14', signedCents: -10000, category: 'Compras', installments: [2, 10], purchaseDate: '2026-02-14' });
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-20', signedCents: -25000, category: 'Viagem', installments: [1, 4], purchaseDate: '2026-03-20' });

    const open = getOpenInstallments(db);

    expect(open).toHaveLength(2);
    expect(open.reduce((s, r) => s + r.remainingCents, 0)).toBe(80000 + 75000);
  });

  it('ignores a purchase whose last installment has been billed', () => {
    const db = freshDb();
    addTx(db, { accountId: 'nubank', postedOn: '2026-03-01', signedCents: -10000, category: 'Compras', installments: [10, 10] });
    expect(getOpenInstallments(db)).toEqual([]);
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
