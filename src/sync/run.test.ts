import { describe, it, expect, beforeEach } from 'vitest';
import { eq, isNull, and } from 'drizzle-orm';
import { createTestDb, type DB } from '../db/client';
import { runMigrations } from '../db/migrate';
import { seedCategories } from '../db/seed-categories';
import { transactions, transactionOverrides, accountSyncState, syncRuns, bills, items } from '../db/schema';
import { FakePluggy } from '../pluggy/fake';
import { syncAll, __resetSyncLock, reapStaleRuns } from './run';

beforeEach(() => __resetSyncLock());

const NOW = '2026-03-15T12:00:00.000Z';

function freshDb(): DB {
  const { db } = createTestDb();
  runMigrations(db);
  seedCategories(db);
  return db;
}

function setupFake(opts: ConstructorParameters<typeof FakePluggy>[0] = {}) {
  const fake = new FakePluggy({ startTime: NOW, ...opts });
  fake.addItem({ id: 'item-1' });
  fake.addAccount({ id: 'acc-bank', itemId: 'item-1', type: 'BANK', subtype: 'CHECKING_ACCOUNT' });
  fake.addAccount({ id: 'acc-card', itemId: 'item-1', type: 'CREDIT', subtype: 'CREDIT_CARD' });
  return fake;
}

/** A fixed clock so timestamps don't make the idempotency comparison spuriously differ. */
const fixedClock = () => new Date(NOW);

function sync(fake: FakePluggy, db: DB, over: Parameters<typeof syncAll>[2] = {}) {
  __resetSyncLock();
  return syncAll(fake, db, { now: fixedClock, ...over });
}

function live(db: DB) {
  return db.select().from(transactions).where(isNull(transactions.deletedAt)).all();
}

function byId(db: DB, id: string) {
  return db.select().from(transactions).where(eq(transactions.id, id)).get();
}

/** Everything that should be identical after an identical re-sync. */
function snapshot(db: DB) {
  return JSON.stringify(
    db.select().from(transactions).orderBy(transactions.id).all().map((t) => ({ ...t, firstSeenAt: '<t>', lastSeenRunId: 0 })),
  );
}

describe('first sync', () => {
  it('pulls accounts and transactions into an empty database', async () => {
    const fake = setupFake();
    fake.add({ id: 't1', accountId: 'acc-bank', amount: -100, date: '2026-03-10T00:00:00.000Z' });
    fake.add({ id: 't2', accountId: 'acc-card', amount: 50, date: '2026-03-11T00:00:00.000Z', type: 'DEBIT' });
    const db = freshDb();

    const res = await sync(fake, db);

    expect(res.status).toBe('ok');
    expect(res.accountsSynced).toBe(2);
    expect(res.transactions.inserted).toBe(2);
    expect(live(db)).toHaveLength(2);
  });

  it('normalizes signs so money-out is negative on both account types', async () => {
    const fake = setupFake();
    fake.add({ id: 'salary', accountId: 'acc-bank', amount: 5000, date: '2026-03-05T00:00:00.000Z', type: 'CREDIT' });
    fake.add({ id: 'purchase', accountId: 'acc-card', amount: 120, date: '2026-03-06T00:00:00.000Z', type: 'DEBIT' });
    const db = freshDb();
    await sync(fake, db);

    expect(byId(db, 'salary')!.signedCents).toBe(500000);
    expect(byId(db, 'purchase')!.signedCents).toBe(-12000);
  });

  it('pulls a full year of history rather than a 45-day window', async () => {
    const fake = setupFake();
    fake.add({ id: 'old', accountId: 'acc-bank', amount: -10, date: '2025-06-01T00:00:00.000Z' });
    const db = freshDb();
    await sync(fake, db);
    expect(live(db).map((t) => t.id)).toContain('old');
  });

  it('records the deep scan so the next run can be shallow', async () => {
    const fake = setupFake();
    const db = freshDb();
    await sync(fake, db);
    const state = db.select().from(accountSyncState).where(eq(accountSyncState.accountId, 'acc-bank')).get();
    expect(state?.lastSuccessAt).toBe(NOW);
    expect(state?.lastDeepScanAt).toBe(NOW);
  });
});

describe('idempotency', () => {
  // Highest value-per-line test in the suite: it covers the whole pipeline at once.
  it('produces a byte-identical database when run twice against unchanged data', async () => {
    const fake = setupFake();
    fake.add({ id: 't1', accountId: 'acc-bank', amount: -100, date: '2026-03-10T00:00:00.000Z' });
    fake.add({ id: 't2', accountId: 'acc-card', amount: 50, date: '2026-03-11T00:00:00.000Z', type: 'DEBIT' });
    const db = freshDb();

    await sync(fake, db);
    const first = snapshot(db);
    await sync(fake, db);

    expect(snapshot(db)).toBe(first);
  });

  it('reports the second run as updates, not inserts', async () => {
    const fake = setupFake();
    fake.add({ id: 't1', accountId: 'acc-bank', amount: -100, date: '2026-03-10T00:00:00.000Z' });
    const db = freshDb();
    await sync(fake, db);
    const second = await sync(fake, db);
    expect(second.transactions.inserted).toBe(0);
    expect(second.transactions.updated).toBeGreaterThan(0);
  });

  it('deletes nothing on a no-change re-sync', async () => {
    const fake = setupFake();
    fake.add({ id: 't1', accountId: 'acc-bank', amount: -100, date: '2026-03-10T00:00:00.000Z' });
    const db = freshDb();
    await sync(fake, db);
    expect((await sync(fake, db)).deleted).toBe(0);
  });
});

describe('PENDING to POSTED', () => {
  it('settles in place when Pluggy keeps the id', async () => {
    const fake = setupFake();
    fake.add({ id: 't1', accountId: 'acc-card', amount: 100, date: '2026-03-10T00:00:00.000Z', type: 'DEBIT', status: 'PENDING' });
    const db = freshDb();
    await sync(fake, db);
    expect(byId(db, 't1')!.status).toBe('PENDING');

    fake.post('t1', { amount: 105 });
    await sync(fake, db);

    const row = byId(db, 't1')!;
    expect(row.status).toBe('POSTED');
    expect(row.amountCents).toBe(10500);
    expect(row.deletedAt).toBeNull();
    expect(live(db)).toHaveLength(1);
  });

  it('keeps pending transactions in the data, so the current month is not understated', async () => {
    const fake = setupFake();
    fake.add({ id: 't1', accountId: 'acc-card', amount: 100, date: '2026-03-10T00:00:00.000Z', type: 'DEBIT', status: 'PENDING' });
    const db = freshDb();
    await sync(fake, db);
    expect(live(db)).toHaveLength(1);
  });
});

describe('delete and recreate', () => {
  it('soft-deletes the old id and inserts the new one, leaving exactly one live row', async () => {
    const fake = setupFake();
    fake.add({ id: 't1', accountId: 'acc-bank', amount: -100, date: '2026-03-10T00:00:00.000Z', status: 'PENDING' });
    const db = freshDb();
    await sync(fake, db);

    const recreated = fake.deleteAndRecreate('t1', { status: 'POSTED', amount: -105 });
    await sync(fake, db);

    expect(byId(db, 't1')!.deletedAt).toBe(NOW);
    expect(byId(db, recreated.id)!.deletedAt).toBeNull();
    expect(live(db)).toHaveLength(1);
  });

  it('carries a manual categorization across to the new row', async () => {
    const fake = setupFake();
    fake.add({ id: 't1', accountId: 'acc-bank', amount: -100, date: '2026-03-10T00:00:00.000Z', description: 'MERCADO', status: 'PENDING' });
    const db = freshDb();
    await sync(fake, db);

    // The user categorizes it by hand.
    const original = byId(db, 't1')!;
    db.insert(transactionOverrides)
      .values({ fingerprint: original.fingerprint, categoryId: 15, updatedAt: NOW })
      .run();

    // Pluggy recreates it two days later with a different description suffix.
    const recreated = fake.deleteAndRecreate('t1', {
      status: 'POSTED', description: 'MERCADO EXTRA LTDA', date: '2026-03-12T00:00:00.000Z',
    });
    const res = await sync(fake, db);

    expect(res.overrides.migrated).toBe(1);
    const newFingerprint = byId(db, recreated.id)!.fingerprint;
    const carried = db.select().from(transactionOverrides).where(eq(transactionOverrides.fingerprint, newFingerprint)).get();
    expect(carried?.categoryId).toBe(15);
    expect(carried?.migratedFrom).toBe(original.fingerprint);
  });

  it('refuses to guess when two candidates are equally plausible', async () => {
    const fake = setupFake();
    fake.add({ id: 't1', accountId: 'acc-bank', amount: -100, date: '2026-03-10T00:00:00.000Z', description: 'CAFE A' });
    const db = freshDb();
    await sync(fake, db);
    db.insert(transactionOverrides)
      .values({ fingerprint: byId(db, 't1')!.fingerprint, categoryId: 15, updatedAt: NOW })
      .run();

    // Two same-amount replacements appear; neither is clearly the original.
    fake.remove('t1');
    fake.add({ id: 'n1', accountId: 'acc-bank', amount: -100, date: '2026-03-11T00:00:00.000Z', description: 'CAFE B' });
    fake.add({ id: 'n2', accountId: 'acc-bank', amount: -100, date: '2026-03-11T00:00:00.000Z', description: 'CAFE C' });
    const res = await sync(fake, db);

    expect(res.overrides.migrated).toBe(0);
    expect(res.overrides.ambiguous).toBe(1);
  });

  it('keeps a card override stable without needing a rescue, via the purchase date anchor', async () => {
    const fake = setupFake();
    fake.add({
      id: 't1', accountId: 'acc-card', amount: 100, date: '2026-03-10T00:00:00.000Z', type: 'DEBIT',
      status: 'PENDING', creditCardMetadata: { purchaseDate: '2026-03-08T00:00:00.000Z' },
    });
    const db = freshDb();
    await sync(fake, db);
    const before = byId(db, 't1')!.fingerprint;

    // Posting date moves, purchase date does not.
    const recreated = fake.deleteAndRecreate('t1', {
      status: 'POSTED', date: '2026-03-13T00:00:00.000Z',
      creditCardMetadata: { purchaseDate: '2026-03-08T00:00:00.000Z' },
    });
    await sync(fake, db);

    expect(byId(db, recreated.id)!.fingerprint).toBe(before);
  });
});

describe('deletion detection', () => {
  it('soft-deletes a transaction Pluggy stopped returning', async () => {
    const fake = setupFake();
    fake.add({ id: 't1', accountId: 'acc-bank', amount: -100, date: '2026-03-10T00:00:00.000Z' });
    fake.add({ id: 't2', accountId: 'acc-bank', amount: -200, date: '2026-03-11T00:00:00.000Z' });
    const db = freshDb();
    await sync(fake, db);

    fake.remove('t1');
    const res = await sync(fake, db);

    expect(res.deleted).toBe(1);
    expect(byId(db, 't1')!.deletedAt).toBe(NOW);
    expect(live(db).map((t) => t.id)).toEqual(['t2']);
  });

  it('revives a transaction that comes back', async () => {
    const fake = setupFake();
    const tx = { id: 't1', accountId: 'acc-bank', amount: -100, date: '2026-03-10T00:00:00.000Z' };
    fake.add(tx);
    const db = freshDb();
    await sync(fake, db);
    fake.remove('t1');
    await sync(fake, db);
    expect(byId(db, 't1')!.deletedAt).toBe(NOW);

    fake.add(tx);
    const res = await sync(fake, db);

    expect(res.transactions.revived).toBe(1);
    expect(byId(db, 't1')!.deletedAt).toBeNull();
  });

  // The sweep is only valid for a window that returned a COMPLETE set.
  it('never deletes rows dated outside the rescan window', async () => {
    const fake = setupFake();
    fake.add({ id: 'ancient', accountId: 'acc-bank', amount: -10, date: '2025-06-01T00:00:00.000Z' });
    fake.add({ id: 'recent', accountId: 'acc-bank', amount: -20, date: '2026-03-10T00:00:00.000Z' });
    const db = freshDb();
    await sync(fake, db); // deep scan, sees both

    // A shallow rescan (45 days) cannot see the 2025 row, and must not delete it.
    const res = await sync(fake, db, { deepScanIntervalDays: 3650 });

    expect(res.deleted).toBe(0);
    expect(byId(db, 'ancient')!.deletedAt).toBeNull();
  });

  // Scheduled installments are dated months ahead. The fetch reaches forward to
  // pick them up; the sweep must not, or the first sync deletes every one of them.
  it('ingests a future-dated installment on a first sync', async () => {
    const fake = setupFake();
    fake.add({ id: 'parcela', accountId: 'acc-card', amount: -330, date: '2026-10-03T00:00:00.000Z' });
    const db = freshDb();

    await sync(fake, db);

    expect(live(db).map((t) => t.id)).toContain('parcela');
  });

  it('never sweeps a future-dated row, even when it stops being returned', async () => {
    const fake = setupFake();
    fake.add({ id: 'parcela', accountId: 'acc-card', amount: -330, date: '2026-10-03T00:00:00.000Z' });
    fake.add({ id: 'hoje', accountId: 'acc-bank', amount: -20, date: '2026-03-10T00:00:00.000Z' });
    const db = freshDb();
    await sync(fake, db);

    fake.remove('parcela');
    const res = await sync(fake, db);

    expect(res.deleted).toBe(0);
    expect(byId(db, 'parcela')!.deletedAt).toBeNull();
  });

  it('catches an old deletion on the monthly deep scan', async () => {
    const fake = setupFake();
    fake.add({ id: 'ancient', accountId: 'acc-bank', amount: -10, date: '2025-06-01T00:00:00.000Z' });
    const db = freshDb();
    await sync(fake, db);

    fake.remove('ancient');
    await sync(fake, db, { deepScanIntervalDays: 3650 }); // shallow: misses it
    expect(byId(db, 'ancient')!.deletedAt).toBeNull();

    const res = await sync(fake, db, { deepScanIntervalDays: 0 }); // deep: catches it
    expect(res.deleted).toBe(1);
    expect(byId(db, 'ancient')!.deletedAt).toBe(NOW);
  });
});

describe('item needing attention', () => {
  it('does not sweep or advance the watermark while an item is UPDATING', async () => {
    const fake = setupFake();
    fake.add({ id: 't1', accountId: 'acc-bank', amount: -100, date: '2026-03-10T00:00:00.000Z' });
    const db = freshDb();
    await sync(fake, db);
    const before = db.select().from(accountSyncState).where(eq(accountSyncState.accountId, 'acc-bank')).get();

    fake.setItemStatus('item-1', 'UPDATING');
    fake.remove('t1'); // mid-update, the data is not trustworthy
    const res = await sync(fake, db, { now: () => new Date('2026-03-15T18:00:00.000Z') });

    expect(res.status).toBe('partial');
    expect(res.deleted).toBe(0);
    expect(byId(db, 't1')!.deletedAt).toBeNull();
    const after = db.select().from(accountSyncState).where(eq(accountSyncState.accountId, 'acc-bank')).get();
    expect(after?.lastSuccessAt).toBe(before?.lastSuccessAt);
  });

  it('warns and continues when a connection needs re-authentication', async () => {
    const fake = setupFake();
    fake.setItemStatus('item-1', 'LOGIN_ERROR', 'INVALID_CREDENTIALS');
    const db = freshDb();
    const res = await sync(fake, db);

    expect(res.status).toBe('partial');
    expect(res.warnings.join(' ')).toMatch(/needs attention/i);
    expect(res.warnings.join(' ')).toMatch(/meu\.pluggy\.ai/);
  });
});

describe('free tier degradation', () => {
  it('falls back to configured item ids when discovery is forbidden', async () => {
    const fake = setupFake({ forbidListItems: true });
    fake.add({ id: 't1', accountId: 'acc-bank', amount: -100, date: '2026-03-10T00:00:00.000Z' });
    const db = freshDb();

    const res = await sync(fake, db, { fallbackItemIds: ['item-1'] });

    expect(res.itemsSynced).toBe(1);
    expect(live(db)).toHaveLength(1);
    expect(res.warnings.join(' ')).toMatch(/discovery is unavailable/i);
    expect(db.select().from(items).all().map((i) => i.id)).toEqual(['item-1']);
  });

  it('continues without bills when they are forbidden', async () => {
    const fake = setupFake({ forbidBills: true });
    fake.add({ id: 't1', accountId: 'acc-card', amount: 100, date: '2026-03-10T00:00:00.000Z', type: 'DEBIT' });
    const db = freshDb();

    const res = await sync(fake, db);

    expect(res.status).toBe('ok');
    expect(res.billsFetched).toBe(0);
    expect(res.warnings.join(' ')).toMatch(/bills are unavailable/i);
    expect(live(db)).toHaveLength(1);
  });

  it('stores bills when they are available', async () => {
    const fake = setupFake();
    fake.addBills('acc-card', [{ id: 'b1', dueDate: '2026-03-20', totalAmount: 1234.56, minimumPaymentAmount: 123.45 }]);
    const db = freshDb();
    await sync(fake, db);

    const stored = db.select().from(bills).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.totalAmountCents).toBe(123456);
  });
});

describe('sign mismatch detection', () => {
  it('counts rows where the normalized sign contradicts Pluggy DEBIT/CREDIT', async () => {
    const fake = setupFake();
    // A bank row flagged DEBIT but with a positive amount — the assumption is violated.
    fake.add({ id: 'odd', accountId: 'acc-bank', amount: 100, date: '2026-03-10T00:00:00.000Z', type: 'DEBIT' });
    const db = freshDb();
    const res = await sync(fake, db);
    expect(res.transactions.signMismatches).toBeGreaterThan(0);
  });

  it('counts none when the convention holds', async () => {
    const fake = setupFake();
    fake.add({ id: 'ok1', accountId: 'acc-bank', amount: -100, date: '2026-03-10T00:00:00.000Z', type: 'DEBIT' });
    fake.add({ id: 'ok2', accountId: 'acc-card', amount: 100, date: '2026-03-10T00:00:00.000Z', type: 'DEBIT' });
    const db = freshDb();
    expect((await sync(fake, db)).transactions.signMismatches).toBe(0);
  });
});

describe('run bookkeeping', () => {
  it('records each run with its status and stats', async () => {
    const fake = setupFake();
    const db = freshDb();
    await sync(fake, db, { trigger: 'auto' });

    const runs = db.select().from(syncRuns).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'ok', trigger: 'auto', finishedAt: NOW });
    expect(JSON.parse(runs[0]!.statsJson!)).toHaveProperty('transactions.inserted');
  });

  it('refuses to run two syncs at once', async () => {
    const fake = setupFake();
    const db = freshDb();
    const first = syncAll(fake, db, { now: fixedClock });
    await expect(syncAll(fake, db, { now: fixedClock })).rejects.toThrow(/already running/i);
    await first;
  });

  it('reaps a run abandoned by a crash', async () => {
    const db = freshDb();
    db.insert(syncRuns).values({ startedAt: '2026-03-15T10:00:00.000Z', trigger: 'manual', status: 'running' }).run();
    expect(reapStaleRuns(db, new Date(NOW))).toBe(1);
    expect(db.select().from(syncRuns).all()[0]!.status).toBe('error');
  });

  it('warns rather than failing when nothing is configured', async () => {
    const fake = new FakePluggy({ startTime: NOW, forbidListItems: true });
    const db = freshDb();
    const res = await sync(fake, db, { fallbackItemIds: [] });
    expect(res.warnings.join(' ')).toMatch(/No connections configured/i);
  });
});

describe('window A', () => {
  it('surfaces an old-dated transaction created after the last sync', async () => {
    const fake = setupFake();
    fake.add({ id: 'known', accountId: 'acc-bank', amount: -10, date: '2026-03-10T00:00:00.000Z' });
    const db = freshDb();
    await sync(fake, db);

    // Created now, but dated 10 months ago — outside the 45-day rescan window.
    fake.advanceDays(1);
    fake.add({ id: 'backdated', accountId: 'acc-bank', amount: -20, date: '2025-05-01T00:00:00.000Z' });

    const res = await sync(fake, db, {
      now: () => new Date('2026-03-16T12:00:00.000Z'),
      deepScanIntervalDays: 3650, // force a shallow rescan, so only Window A can find it
    });

    expect(res.transactions.inserted).toBe(1);
    expect(live(db).map((t) => t.id).sort()).toEqual(['backdated', 'known']);
  });
});
