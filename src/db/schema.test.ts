import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from './client';
import { runMigrations } from './migrate';
import { items, accounts, transactions } from './schema';

function seeded() {
  const { db, sqlite } = createTestDb();
  runMigrations(db);
  db.insert(items).values({ id: 'item-1', connectorId: 200 }).run();
  db.insert(accounts).values({ id: 'acc-1', itemId: 'item-1', type: 'CREDIT' }).run();
  return { db, sqlite };
}

const baseTx = {
  id: 'tx-1',
  accountId: 'acc-1',
  fingerprint: 'fp-1',
  dateUtc: '2026-03-01T00:00:00.000Z',
  postedOn: '2026-03-01',
  searchText: 'MERCADO',
  amountCents: 5000,
  signedCents: -5000,
  status: 'POSTED',
  firstSeenAt: '2026-03-02T10:00:00.000Z',
  lastSeenRunId: 1,
  rawJson: '{}',
};

describe('migrations', () => {
  it('apply cleanly to a fresh database', () => {
    const { sqlite } = seeded();
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'")
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(tables).toEqual([
      'account_sync_state', 'accounts', 'bills', 'categories', 'items',
      'rules', 'settings', 'sync_runs', 'transaction_overrides', 'transactions',
    ]);
  });

  it('creates the partial covering index the matrix query relies on', () => {
    const { sqlite } = seeded();
    const idx = sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_tx_matrix'")
      .get() as { sql: string } | undefined;
    expect(idx?.sql).toContain('WHERE deleted_at IS NULL AND is_internal = 0');
  });
});

describe('transactions.month generated column', () => {
  it('derives itself from posted_on without being written', () => {
    const { db } = seeded();
    db.insert(transactions).values(baseTx).run();
    const row = db.select().from(transactions).get();
    expect(row?.month).toBe('2026-03');
  });

  it('cannot drift: updating posted_on updates month', () => {
    const { db } = seeded();
    db.insert(transactions).values(baseTx).run();
    db.update(transactions).set({ postedOn: '2026-11-30' }).run();
    expect(db.select().from(transactions).get()?.month).toBe('2026-11');
  });
});

describe('referential integrity', () => {
  it('rejects a transaction pointing at an unknown account', () => {
    const { db } = seeded();
    expect(() => db.insert(transactions).values({ ...baseTx, accountId: 'nope' }).run()).toThrow(
      /FOREIGN KEY/i,
    );
  });

  it('cascades account deletion to its transactions', () => {
    const { db } = seeded();
    db.insert(transactions).values(baseTx).run();
    db.delete(accounts).run();
    expect(db.select().from(transactions).all()).toHaveLength(0);
  });
});

describe('booleans', () => {
  it('round-trip as real booleans, not 0/1', () => {
    const { db } = seeded();
    db.insert(transactions).values(baseTx).run();
    const row = db.select().from(transactions).get();
    expect(row?.isInternal).toBe(false);
    expect(typeof row?.isInternal).toBe('boolean');
  });
});

describe('sqlite capabilities', () => {
  it('is new enough for STORED generated columns', () => {
    const { sqlite } = createTestDb();
    const { v } = sqlite.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    const [major, minor] = v.split('.').map(Number) as [number, number];
    expect(major > 3 || (major === 3 && minor >= 31)).toBe(true);
  });
});
