import { describe, it, expect, beforeEach } from 'vitest';
import { eq, isNull, and } from 'drizzle-orm';
import { createTestDb, type DB } from '../db/client';
import { runMigrations } from '../db/migrate';
import { seedCategories } from '../db/seed-categories';
import { seedRules } from '../categorize/seed-rules';
import { accounts, accountSyncState, items, transactions } from '../db/schema';
import { FakePluggy } from '../pluggy/fake';
import { syncAndCategorize } from './pipeline';
import { __resetSyncLock } from './run';
import { getMatrix } from '../queries/matrix';
import { getCardBreakdown } from '../queries/cards';

/**
 * A second bank connection is the common next step, so the merge behaviour is
 * worth proving rather than assuming.
 */

beforeEach(() => __resetSyncLock());
const NOW = '2026-03-15T12:00:00.000Z';

function freshDb(): DB {
  const { db } = createTestDb();
  runMigrations(db);
  seedCategories(db);
  seedRules(db);
  return db;
}

/** Two banks: Itaú (checking + card) and Nubank (card only). */
function twoBanks() {
  const fake = new FakePluggy({ startTime: NOW, forbidListItems: true });
  fake.addItem({ id: 'item-itau', connector: { id: 601, name: 'Itaú' } });
  fake.addAccount({ id: 'itau-cc', itemId: 'item-itau', type: 'BANK', subtype: 'CHECKING_ACCOUNT', name: 'Itaú conta' });
  fake.addAccount({ id: 'itau-card', itemId: 'item-itau', type: 'CREDIT', subtype: 'CREDIT_CARD', name: 'Itaú cartão' });

  fake.addItem({ id: 'item-nu', connector: { id: 212, name: 'Nubank' } });
  fake.addAccount({ id: 'nu-card', itemId: 'item-nu', type: 'CREDIT', subtype: 'CREDIT_CARD', name: 'Nubank' });
  return fake;
}

const run = (fake: FakePluggy, db: DB, ids: string[]) => {
  __resetSyncLock();
  return syncAndCategorize(fake, db, { now: () => new Date(NOW), fallbackItemIds: ids });
};

function live(db: DB) {
  return db.select().from(transactions).where(isNull(transactions.deletedAt)).all();
}

describe('adding a second connection', () => {
  it('keeps the first connection intact and adds the second', async () => {
    const fake = twoBanks();
    fake.add({ id: 'a1', accountId: 'itau-cc', amount: -100, date: '2026-03-01T12:00:00.000Z', description: 'PAO DE ACUCAR' });
    const db = freshDb();

    await run(fake, db, ['item-itau']);
    expect(live(db)).toHaveLength(1);

    // Later: the user connects Nubank too.
    fake.add({ id: 'b1', accountId: 'nu-card', amount: 250, type: 'DEBIT', date: '2026-03-02T12:00:00.000Z', description: 'IFOOD' });
    const res = await run(fake, db, ['item-itau', 'item-nu']);

    expect(res.sync.itemsSynced).toBe(2);
    expect(res.sync.accountsSynced).toBe(3);
    expect(live(db).map((t) => t.id).sort()).toEqual(['a1', 'b1']);
  });

  it('gives each account its own sync watermark', async () => {
    const fake = twoBanks();
    const db = freshDb();
    await run(fake, db, ['item-itau', 'item-nu']);
    const states = db.select().from(accountSyncState).all();
    expect(states).toHaveLength(3);
    expect(states.every((s) => s.lastSuccessAt === NOW)).toBe(true);
  });

  // The sweep is per-account. A deletion at one bank must never touch the other.
  it('never lets one connection delete another connection data', async () => {
    const fake = twoBanks();
    fake.add({ id: 'a1', accountId: 'itau-cc', amount: -100, date: '2026-03-01T12:00:00.000Z' });
    fake.add({ id: 'b1', accountId: 'nu-card', amount: 250, type: 'DEBIT', date: '2026-03-02T12:00:00.000Z' });
    const db = freshDb();
    await run(fake, db, ['item-itau', 'item-nu']);

    fake.remove('a1');
    const res = await run(fake, db, ['item-itau', 'item-nu']);

    expect(res.sync.deleted).toBe(1);
    expect(live(db).map((t) => t.id)).toEqual(['b1']);
  });

  it('carries on with the other bank when one connection is broken', async () => {
    const fake = twoBanks();
    fake.add({ id: 'b1', accountId: 'nu-card', amount: 250, type: 'DEBIT', date: '2026-03-02T12:00:00.000Z' });
    fake.setItemStatus('item-itau', 'LOGIN_ERROR', 'INVALID_CREDENTIALS');
    const db = freshDb();

    const res = await run(fake, db, ['item-itau', 'item-nu']);

    expect(res.sync.status).toBe('partial');
    expect(res.sync.warnings.join(' ')).toMatch(/Ita/);
    expect(live(db).map((t) => t.id)).toEqual(['b1']); // Nubank still synced
  });
});

describe('merged views', () => {
  it('sums both banks into one monthly figure', async () => {
    const fake = twoBanks();
    fake.add({ id: 'a1', accountId: 'itau-cc', amount: -100, date: '2026-03-01T12:00:00.000Z', description: 'PAO DE ACUCAR' });
    fake.add({ id: 'b1', accountId: 'nu-card', amount: 250, type: 'DEBIT', date: '2026-03-02T12:00:00.000Z', description: 'PAO DE ACUCAR' });
    const db = freshDb();
    await run(fake, db, ['item-itau', 'item-nu']);

    const m = getMatrix(db, 2026);
    const mercado = m.rows.find((r) => r.name === 'Mercado')!;

    expect(mercado.cells[2]!.cents).toBe(35000); // 100 + 250
    expect(mercado.cells[2]!.count).toBe(2);
  });

  it('separates the cards on the cards page', async () => {
    const fake = twoBanks();
    fake.add({ id: 'a1', accountId: 'itau-card', amount: 100, type: 'DEBIT', date: '2026-03-01T12:00:00.000Z', description: 'IFOOD' });
    fake.add({ id: 'b1', accountId: 'nu-card', amount: 250, type: 'DEBIT', date: '2026-03-02T12:00:00.000Z', description: 'IFOOD' });
    const db = freshDb();
    await run(fake, db, ['item-itau', 'item-nu']);

    const b = getCardBreakdown(db, { year: 2026 });

    expect(b.totalCents).toBe(35000);
    expect(b.byCard.map((c) => c.name).sort()).toEqual(['Itaú cartão', 'Nubank']);
  });

  // Identical purchases at two banks must stay distinct: the fingerprint includes
  // the account, so they cannot collapse into one another.
  it('does not confuse identical transactions at different banks', async () => {
    const fake = twoBanks();
    fake.add({ id: 'a1', accountId: 'itau-card', amount: 50, type: 'DEBIT', date: '2026-03-01T12:00:00.000Z', description: 'UBER' });
    fake.add({ id: 'b1', accountId: 'nu-card', amount: 50, type: 'DEBIT', date: '2026-03-01T12:00:00.000Z', description: 'UBER' });
    const db = freshDb();

    const res = await run(fake, db, ['item-itau', 'item-nu']);

    expect(res.duplicateFingerprints).toBe(0);
    const fps = live(db).map((t) => t.fingerprint);
    expect(new Set(fps).size).toBe(2);
  });
});

describe('transfers between the two banks', () => {
  // This is the case that only becomes detectable once BOTH sides are connected.
  it('pairs a transfer that leaves one bank and arrives at the other', async () => {
    const fake = twoBanks();
    fake.addAccount({ id: 'nu-cc', itemId: 'item-nu', type: 'BANK', subtype: 'CHECKING_ACCOUNT', name: 'Nubank conta' });
    fake.add({ id: 'out', accountId: 'itau-cc', amount: -500, date: '2026-03-10T12:00:00.000Z', description: 'PIX ENVIADO', paymentData: { paymentMethod: 'PIX' } });
    fake.add({ id: 'in', accountId: 'nu-cc', amount: 500, type: 'CREDIT', date: '2026-03-10T12:00:00.000Z', description: 'PIX RECEBIDO', paymentData: { paymentMethod: 'PIX' } });
    const db = freshDb();

    await run(fake, db, ['item-itau', 'item-nu']);

    const rows = db.select().from(transactions).where(isNull(transactions.deletedAt)).all();
    expect(rows.every((r) => r.isInternal)).toBe(true);
    expect(new Set(rows.map((r) => r.internalPairId)).size).toBe(1);
    // And therefore counts as neither spending nor income.
    expect(getMatrix(db, 2026).grandTotal).toBe(0);
    expect(getMatrix(db, 2026).incomeGrandTotal).toBe(0);
  });
});
