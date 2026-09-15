import { describe, it, expect, beforeEach } from 'vitest';
import { eq, isNull, and } from 'drizzle-orm';
import { createTestDb, type DB } from '../db/client';
import { runMigrations } from '../db/migrate';
import { seedCategories } from '../db/seed-categories';
import { seedRules } from '../categorize/seed-rules';
import { categories, transactions } from '../db/schema';
import { FakePluggy } from '../pluggy/fake';
import { syncAndCategorize } from './pipeline';
import { __resetSyncLock } from './run';

beforeEach(() => __resetSyncLock());
const NOW = '2026-03-15T12:00:00.000Z';

function freshDb(): DB {
  const { db } = createTestDb();
  runMigrations(db);
  seedCategories(db);
  seedRules(db);
  return db;
}

function setupFake() {
  const fake = new FakePluggy({ startTime: NOW });
  fake.addItem({ id: 'item-1' });
  fake.addAccount({ id: 'acc-bank', itemId: 'item-1', type: 'BANK', subtype: 'CHECKING_ACCOUNT' });
  fake.addAccount({ id: 'acc-card', itemId: 'item-1', type: 'CREDIT', subtype: 'CREDIT_CARD' });
  return fake;
}

function run(fake: FakePluggy, db: DB) {
  __resetSyncLock();
  return syncAndCategorize(fake, db, { now: () => new Date(NOW) });
}

function categoryOf(db: DB, id: string): string | null {
  return db
    .select({ name: categories.name })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .where(eq(transactions.id, id))
    .get()?.name ?? null;
}

function spendable(db: DB) {
  return db
    .select()
    .from(transactions)
    .where(and(isNull(transactions.deletedAt), eq(transactions.isInternal, false)))
    .all();
}

describe('end to end', () => {
  it('pulls, detects transfers and categorizes in one pass', async () => {
    const fake = setupFake();
    fake.add({ id: 'mercado', accountId: 'acc-card', amount: 250.9, type: 'DEBIT', date: '2026-03-05T00:00:00.000Z', description: 'PAO DE ACUCAR 55' });
    fake.add({ id: 'ifood', accountId: 'acc-card', amount: 48.5, type: 'DEBIT', date: '2026-03-06T00:00:00.000Z', description: 'IFOOD *SUSHI' });
    fake.add({ id: 'salario', accountId: 'acc-bank', amount: 12000, type: 'CREDIT', date: '2026-03-05T00:00:00.000Z', description: 'SALARIO EMPRESA' });
    const db = freshDb();

    const res = await run(fake, db);

    expect(res.sync.status).toBe('ok');
    expect(categoryOf(db, 'mercado')).toBe('Mercado');
    expect(categoryOf(db, 'ifood')).toBe('Restaurante');
    expect(categoryOf(db, 'salario')).toBe('Receitas');
    expect(res.categorize.scanned).toBe(3);
  });

  // The core correctness property of the whole app.
  it('counts card purchases once and excludes the bill that settles them', async () => {
    const fake = setupFake();
    fake.add({ id: 'buy1', accountId: 'acc-card', amount: 100, type: 'DEBIT', date: '2026-03-02T00:00:00.000Z', description: 'PAO DE ACUCAR' });
    fake.add({ id: 'buy2', accountId: 'acc-card', amount: 50, type: 'DEBIT', date: '2026-03-03T00:00:00.000Z', description: 'IFOOD' });
    // The bill payment: leaves the bank, and is credited on the card.
    fake.add({ id: 'pay-bank', accountId: 'acc-bank', amount: -150, type: 'DEBIT', date: '2026-03-20T00:00:00.000Z', description: 'PAGAMENTO FATURA CARTAO' });
    fake.add({ id: 'pay-card', accountId: 'acc-card', amount: -150, type: 'CREDIT', date: '2026-03-20T00:00:00.000Z', description: 'PAGAMENTO RECEBIDO' });
    fake.addBills('acc-card', [{ id: 'b1', dueDate: '2026-03-20', totalAmount: 150 }]);
    const db = freshDb();

    await run(fake, db);

    const counted = spendable(db);
    expect(counted.map((t) => t.id).sort()).toEqual(['buy1', 'buy2']);
    // Total spending is the purchases, not the purchases plus the bill.
    expect(counted.reduce((sum, t) => sum + t.signedCents, 0)).toBe(-15000);
  });

  it('treats the installments of one purchase as distinct transactions', async () => {
    const fake = setupFake();
    for (let i = 1; i <= 10; i++) {
      fake.add({
        id: `parcela-${i}`, accountId: 'acc-card', amount: 489.9, type: 'DEBIT',
        date: `2026-0${i <= 6 ? i + 3 : 9}-14T00:00:00.000Z`,
        description: 'MAGAZINE LUIZA PARCELA',
        creditCardMetadata: { installmentNumber: i, totalInstallments: 10, totalAmount: 4899, purchaseDate: '2026-03-14T00:00:00.000Z' },
      });
    }
    const db = freshDb();

    const res = await run(fake, db);

    expect(res.duplicateFingerprints).toBe(0);
    const fps = db.select().from(transactions).all().map((t) => t.fingerprint);
    expect(new Set(fps).size).toBe(fps.length);
  });

  it('reports no duplicate fingerprints on a clean run', async () => {
    const fake = setupFake();
    fake.add({ id: 't1', accountId: 'acc-bank', amount: -10, date: '2026-03-01T00:00:00.000Z' });
    const db = freshDb();
    expect((await run(fake, db)).duplicateFingerprints).toBe(0);
  });

  it('is stable across repeated runs', async () => {
    const fake = setupFake();
    fake.add({ id: 'mercado', accountId: 'acc-card', amount: 250.9, type: 'DEBIT', date: '2026-03-05T00:00:00.000Z', description: 'PAO DE ACUCAR' });
    const db = freshDb();
    await run(fake, db);
    const second = await run(fake, db);
    expect(second.categorize.changed).toBe(0);
    expect(second.sync.deleted).toBe(0);
  });

  it('keeps a manual categorization through a later sync', async () => {
    const fake = setupFake();
    fake.add({ id: 't1', accountId: 'acc-card', amount: 90, type: 'DEBIT', date: '2026-03-05T00:00:00.000Z', description: 'PAO DE ACUCAR' });
    const db = freshDb();
    await run(fake, db);
    expect(categoryOf(db, 't1')).toBe('Mercado');

    const { setOverride } = await import('../categorize/recategorize');
    const fp = db.select().from(transactions).where(eq(transactions.id, 't1')).get()!.fingerprint;
    const viagem = db.select().from(categories).where(eq(categories.name, 'Viagem')).get()!.id;
    setOverride(db, fp, { categoryId: viagem });

    await run(fake, db);
    expect(categoryOf(db, 't1')).toBe('Viagem');
  });
});
